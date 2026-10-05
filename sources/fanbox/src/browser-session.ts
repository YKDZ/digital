import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserServer,
  type Page,
} from "playwright";

export type FanboxPrivateBrowserContextV2 = {
  readonly format: "fanbox-browser-request-context/2";
  readonly userAgent: string;
  readonly cookies: readonly {
    readonly name: string;
    readonly value: string;
    readonly domain: "fanbox.cc" | ".fanbox.cc";
    readonly path: string;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly sameSite?: "Strict" | "Lax" | "None";
    readonly expires?: number;
  }[];
};

export type FanboxClosedEndpoint =
  | { readonly kind: "login-status" }
  | {
      readonly kind: "creator-summaries";
      readonly creatorId: string;
      readonly limit: 1 | 300;
    }
  | {
      readonly kind: "post-detail";
      readonly postId: string;
      readonly access: "connected" | "public";
    };

export type FanboxSessionResponse =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly mediaType: string | null;
      readonly body: Uint8Array;
    }
  | {
      readonly kind: "response-limit";
      readonly status: number;
      readonly mediaType: string | null;
    }
  | {
      readonly kind: "cloudflare-challenge";
      readonly status: number;
      readonly mediaType: string | null;
      readonly cfMitigated: "challenge" | null;
    };

export type FanboxClosedGet = (
  endpoint: FanboxClosedEndpoint,
) => Promise<FanboxSessionResponse>;

export type FanboxSessionTransportFaultCategory =
  | "runtime-unavailable"
  | "runtime-crashed"
  | "request-timeout"
  | "transaction-cancelled"
  | "network-failure";

export class FanboxSessionTransportFault extends Error {
  readonly category: FanboxSessionTransportFaultCategory;

  constructor(category: FanboxSessionTransportFaultCategory) {
    super("FANBOX browser session transport failed");
    this.category = category;
  }
}

export interface FanboxEndpointSessionTransport {
  transact<Result>(input: {
    readonly creatorId: string;
    readonly privateContext: FanboxPrivateBrowserContextV2;
    readonly use: (get: FanboxClosedGet) => Promise<Result>;
  }): Promise<Result>;
  close(): Promise<void>;
}

type ActiveTransaction = {
  cancelled: boolean;
  crashed: boolean;
  readonly cancellation: Promise<never>;
  readonly cancel: (category: FanboxSessionTransportFaultCategory) => void;
  generation?: BrowserGeneration;
  context?: BrowserContext;
  contextCleanup?: Promise<void>;
  page?: Page;
  pageCleanup?: Promise<void>;
  cleanupFailed: boolean;
  readonly ownStageSettlement: (settlement: Promise<void>) => void;
  readonly settled: Promise<void>;
  readonly settle: () => void;
};

type BrowserGeneration = {
  readonly browser: Browser;
  readonly server: BrowserServer;
  readonly owner: string;
  dead: boolean;
  cleanup?: Promise<void>;
};

type PreReadyBrowserOwner = {
  readonly server: BrowserServer;
  readonly owner: string;
  browser?: Browser;
  cleanup: Promise<void> | undefined;
};

const stepTimeoutMilliseconds = 30_000;

async function boundedBrowserCleanup(operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("bounded browser cleanup failed")),
          stepTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function awaitTransactionStage<Result>(
  transaction: ActiveTransaction,
  operation: Promise<Result>,
  lateResult?: {
    readonly dispose: (result: Result) => Promise<void>;
  },
): Promise<Result> {
  const settlement = (async () => {
    let result: Result;
    try {
      result = await operation;
    } catch {
      return;
    }
    if (
      lateResult !== undefined &&
      (transaction.cancelled || transaction.crashed)
    )
      await lateResult.dispose(result);
  })();
  transaction.ownStageSettlement(settlement);
  return await Promise.race([operation, transaction.cancellation]);
}

export function fanboxEndpointAddress(endpoint: FanboxClosedEndpoint): string {
  if (endpoint.kind === "login-status")
    return "https://api.fanbox.cc/user.countUnreadMessages";
  if (endpoint.kind === "creator-summaries") {
    const address = new URL("https://api.fanbox.cc/post.listCreator");
    address.searchParams.set("creatorId", endpoint.creatorId);
    address.searchParams.set("limit", String(endpoint.limit));
    return address.href;
  }
  const address = new URL("https://api.fanbox.cc/post.info");
  address.searchParams.set("postId", endpoint.postId);
  return address.href;
}

export function createPlaywrightFanboxSessionTransport(): FanboxEndpointSessionTransport {
  let generation: BrowserGeneration | undefined;
  let starting: Promise<BrowserGeneration> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const active = new Set<ActiveTransaction>();
  const ownedGenerationOwners = new Set<BrowserGeneration>();
  const preReadyBrowserOwners = new Set<PreReadyBrowserOwner>();
  const ownedStageSettlements = new Set<Promise<void>>();
  let generationCleanupFailed = false;

  const ownStageSettlement = (settlement: Promise<void>): void => {
    ownedStageSettlements.add(settlement);
    void settlement.then(
      () => ownedStageSettlements.delete(settlement),
      () => undefined,
    );
  };

  const closeTransactionPage = async (
    transaction: ActiveTransaction,
  ): Promise<void> => {
    if (transaction.page === undefined) return;
    transaction.pageCleanup ??= boundedBrowserCleanup(transaction.page.close());
    await transaction.pageCleanup;
  };

  const closeTransactionContext = async (
    transaction: ActiveTransaction,
  ): Promise<void> => {
    if (transaction.context === undefined) return;
    transaction.contextCleanup ??= boundedBrowserCleanup(
      transaction.context.close(),
    );
    await transaction.contextCleanup;
  };

  const discard = async (current: BrowserGeneration): Promise<void> => {
    if (generation === current) generation = undefined;
    current.dead = true;
    current.cleanup ??= Promise.resolve().then(async () => {
      let cleanupFailed = false;
      try {
        await boundedBrowserCleanup(current.browser.close());
      } catch {
        cleanupFailed = true;
      }
      const process = current.server.process();
      if (
        current.browser.isConnected() ||
        (process.exitCode === null && process.signalCode === null)
      ) {
        try {
          await boundedBrowserCleanup(current.server.kill());
        } catch {
          cleanupFailed = true;
        }
      }
      if (
        current.browser.isConnected() ||
        (process.exitCode === null && process.signalCode === null)
      ) {
        cleanupFailed = true;
      } else {
        try {
          await rm(current.owner, { recursive: true, force: true });
          ownedGenerationOwners.delete(current);
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        generationCleanupFailed = true;
        throw new FanboxSessionTransportFault("runtime-unavailable");
      }
    });
    const cleanup = current.cleanup;
    void cleanup.catch(() => undefined);
    try {
      await cleanup;
    } finally {
      if (current.cleanup === cleanup) delete current.cleanup;
    }
  };

  const cleanupPreReadyBrowserOwner = async (
    current: PreReadyBrowserOwner,
  ): Promise<void> => {
    current.cleanup ??= Promise.resolve().then(async () => {
      let cleanupFailed = false;
      try {
        if (current.browser !== undefined)
          await boundedBrowserCleanup(current.browser.close());
      } catch {
        cleanupFailed = true;
      }
      const process = current.server.process();
      if (
        current.browser?.isConnected() === true ||
        (process.exitCode === null && process.signalCode === null)
      ) {
        try {
          await boundedBrowserCleanup(current.server.kill());
        } catch {
          cleanupFailed = true;
        }
      }
      if (
        current.browser?.isConnected() === true ||
        (process.exitCode === null && process.signalCode === null)
      ) {
        cleanupFailed = true;
      } else {
        try {
          await rm(current.owner, { recursive: true, force: true });
          preReadyBrowserOwners.delete(current);
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed)
        throw new FanboxSessionTransportFault("runtime-unavailable");
    });
    const cleanup = current.cleanup;
    void cleanup.catch(() => undefined);
    try {
      await cleanup;
    } finally {
      current.cleanup = undefined;
    }
  };

  const launch = async (): Promise<BrowserGeneration> => {
    const owner = await mkdtemp(path.join(tmpdir(), "digital-fanbox-browser-"));
    let server: BrowserServer | undefined;
    let browser: Browser | undefined;
    let preReadyOwner: PreReadyBrowserOwner | undefined;
    try {
      await mkdir(path.join(owner, "downloads"), { mode: 0o700 });
      await mkdir(path.join(owner, "artifacts"), { mode: 0o700 });
      server = await chromium.launchServer({
        headless: true,
        host: "127.0.0.1",
        port: 0,
        timeout: stepTimeoutMilliseconds,
        downloadsPath: path.join(owner, "downloads"),
        artifactsDir: path.join(owner, "artifacts"),
        env: { ...process.env, HOME: owner, TMPDIR: owner },
      });
      preReadyOwner = { server, owner, cleanup: undefined };
      preReadyBrowserOwners.add(preReadyOwner);
      browser = await chromium.connect(server.wsEndpoint(), {
        timeout: stepTimeoutMilliseconds,
      });
      preReadyOwner.browser = browser;
      const current: BrowserGeneration = {
        browser,
        server,
        owner,
        dead: false,
      };
      ownedGenerationOwners.add(current);
      browser.on("disconnected", () => {
        current.dead = true;
        if (generation === current) generation = undefined;
        for (const transaction of active)
          if (transaction.generation === current) {
            transaction.crashed = true;
            transaction.cancel("runtime-crashed");
          }
        void discard(current).catch(() => undefined);
      });
      preReadyBrowserOwners.delete(preReadyOwner);
      if (closed) {
        await discard(current);
        throw new FanboxSessionTransportFault("runtime-unavailable");
      }
      generation = current;
      return current;
    } catch (error) {
      if (error instanceof FanboxSessionTransportFault) throw error;
      if (
        preReadyOwner !== undefined &&
        preReadyBrowserOwners.has(preReadyOwner)
      )
        await cleanupPreReadyBrowserOwner(preReadyOwner).catch(() => undefined);
      else if (server === undefined)
        await rm(owner, { recursive: true, force: true }).catch(
          () => undefined,
        );
      throw new FanboxSessionTransportFault("runtime-unavailable");
    }
  };

  const ready = async (): Promise<BrowserGeneration> => {
    if (closed) throw new FanboxSessionTransportFault("runtime-unavailable");
    if (generation !== undefined && !generation.dead) return generation;
    starting ??= launch().finally(() => {
      starting = undefined;
    });
    return await starting;
  };

  return {
    async transact<Result>(input: {
      readonly creatorId: string;
      readonly privateContext: FanboxPrivateBrowserContextV2;
      readonly use: (get: FanboxClosedGet) => Promise<Result>;
    }): Promise<Result> {
      if (closed) throw new FanboxSessionTransportFault("runtime-unavailable");
      let settle!: () => void;
      let cancel!: (category: FanboxSessionTransportFaultCategory) => void;
      let cancellationSettled = false;
      const cancellation = new Promise<never>((_resolve, reject) => {
        cancel = (category) => {
          if (cancellationSettled) return;
          cancellationSettled = true;
          reject(new FanboxSessionTransportFault(category));
        };
      });
      void cancellation.catch(() => undefined);
      const transaction: ActiveTransaction = {
        cancelled: false,
        crashed: false,
        cancellation,
        cancel,
        cleanupFailed: false,
        ownStageSettlement,
        settled: new Promise<void>((resolve) => {
          settle = resolve;
        }),
        settle: () => settle(),
      };
      active.add(transaction);
      let current: BrowserGeneration | undefined;
      let outcome:
        | { readonly kind: "success"; readonly value: Result }
        | { readonly kind: "failure"; readonly error: unknown };
      try {
        current = await awaitTransactionStage(transaction, ready());
        transaction.generation = current;
        if (transaction.cancelled)
          throw new FanboxSessionTransportFault("transaction-cancelled");
        if (current.dead)
          throw new FanboxSessionTransportFault("runtime-crashed");
        const readyGeneration = current;
        transaction.context = await awaitTransactionStage(
          transaction,
          readyGeneration.browser.newContext({
            userAgent: input.privateContext.userAgent,
            acceptDownloads: false,
          }),
          {
            dispose: async (context) =>
              await boundedBrowserCleanup(context.close()),
          },
        );
        if (transaction.cancelled)
          throw new FanboxSessionTransportFault("transaction-cancelled");
        if (transaction.crashed || readyGeneration.dead)
          throw new FanboxSessionTransportFault("runtime-crashed");
        await awaitTransactionStage(
          transaction,
          transaction.context.addCookies([...input.privateContext.cookies]),
        );
        if (transaction.cancelled)
          throw new FanboxSessionTransportFault("transaction-cancelled");
        transaction.page = await awaitTransactionStage(
          transaction,
          transaction.context.newPage(),
          {
            dispose: async (latePage) =>
              await boundedBrowserCleanup(latePage.close()),
          },
        );
        if (transaction.cancelled)
          throw new FanboxSessionTransportFault("transaction-cancelled");
        await awaitTransactionStage(
          transaction,
          transaction.page.goto("https://www.fanbox.cc/", {
            waitUntil: "domcontentloaded",
            timeout: stepTimeoutMilliseconds,
          }),
        );
        let pending = false;
        const get: FanboxClosedGet = async (endpoint) => {
          if (pending) throw new FanboxSessionTransportFault("network-failure");
          if (transaction.cancelled)
            throw new FanboxSessionTransportFault("transaction-cancelled");
          if (transaction.crashed || readyGeneration.dead)
            throw new FanboxSessionTransportFault("runtime-crashed");
          pending = true;
          try {
            return await awaitTransactionStage(
              transaction,
              rendererGet(transaction.page!, endpoint),
            );
          } finally {
            pending = false;
          }
        };
        outcome = {
          kind: "success",
          value: await awaitTransactionStage(transaction, input.use(get)),
        };
      } catch (error) {
        outcome = { kind: "failure", error };
      }
      let cleanupFailed = false;
      try {
        await closeTransactionPage(transaction);
      } catch {
        cleanupFailed = true;
      }
      try {
        await closeTransactionContext(transaction);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed && current !== undefined)
        await discard(current).catch(() => undefined);
      transaction.cleanupFailed = cleanupFailed;
      if (
        outcome.kind === "failure" &&
        outcome.error instanceof FanboxSessionTransportFault &&
        outcome.error.category === "request-timeout" &&
        current !== undefined
      )
        await discard(current).catch(() => undefined);
      active.delete(transaction);
      transaction.settle();
      if (outcome.kind === "failure") {
        if (outcome.error instanceof FanboxSessionTransportFault)
          throw outcome.error;
        if (transaction.cancelled)
          throw new FanboxSessionTransportFault("transaction-cancelled");
        if (transaction.crashed || current?.dead)
          throw new FanboxSessionTransportFault("runtime-crashed");
        throw new FanboxSessionTransportFault("network-failure");
      }
      if (cleanupFailed)
        throw new FanboxSessionTransportFault("network-failure");
      return outcome.value;
    },
    close(): Promise<void> {
      closing ??= (async () => {
        closed = true;
        const transactions = [...active];
        const cancellations: Promise<unknown>[] = [];
        for (const transaction of transactions) {
          transaction.cancelled = true;
          transaction.cancel("transaction-cancelled");
          cancellations.push(closeTransactionPage(transaction));
          await closeTransactionContext(transaction).catch(() => undefined);
          if (transaction.generation !== undefined)
            cancellations.push(discard(transaction.generation));
        }
        await Promise.allSettled(cancellations);
        await Promise.allSettled(transactions.map(({ settled }) => settled));
        let cleanupFailed = false;
        const pending = starting;
        if (pending !== undefined) await pending.catch(() => undefined);
        if (generation !== undefined)
          try {
            await discard(generation);
          } catch {
            cleanupFailed = true;
          }
        const preReadyCleanupResults = await Promise.allSettled(
          [...preReadyBrowserOwners].map(cleanupPreReadyBrowserOwner),
        );
        try {
          await boundedBrowserCleanup(
            Promise.allSettled(ownedStageSettlements).then((results) => {
              if (results.some(({ status }) => status === "rejected"))
                throw new FanboxSessionTransportFault("runtime-unavailable");
            }),
          );
        } catch {
          cleanupFailed = true;
        }
        const generationCleanupResults = await Promise.allSettled(
          [...ownedGenerationOwners].map(async (current) => {
            const currentCleanup = current.cleanup;
            if (currentCleanup !== undefined) {
              await currentCleanup.catch(() => undefined);
              if (current.cleanup === currentCleanup) delete current.cleanup;
            }
            if (ownedGenerationOwners.has(current)) await discard(current);
          }),
        );
        if (
          generationCleanupFailed ||
          generationCleanupResults.some(({ status }) => status === "rejected")
        )
          cleanupFailed = true;
        if (preReadyCleanupResults.some(({ status }) => status === "rejected"))
          cleanupFailed = true;
        if (transactions.some((transaction) => transaction.cleanupFailed))
          cleanupFailed = true;
        if (cleanupFailed)
          throw new FanboxSessionTransportFault("runtime-unavailable");
      })();
      return closing;
    },
  };
}

async function rendererGet(
  page: Page,
  endpoint: FanboxClosedEndpoint,
): Promise<FanboxSessionResponse> {
  const maximumBytes =
    endpoint.kind === "login-status" ? 1024 : 2 * 1024 * 1024;
  const evaluation = page.evaluate(
    async ({ address, credentials, maximumBytes, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(address, {
          credentials,
          cache: "no-store",
          signal: controller.signal,
        });
        const mediaType = response.headers.get("content-type");
        if (response.headers.get("cf-mitigated") === "challenge") {
          await response.body?.cancel();
          return {
            kind: "cloudflare-challenge" as const,
            status: response.status,
            mediaType,
            cfMitigated: "challenge" as const,
          };
        }
        const reader = response.body?.getReader();
        const chunks: number[] = [];
        let size = 0;
        const mediaTypeEssence = mediaType
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        const rejectedNonJson =
          (response.status < 200 || response.status >= 300) &&
          mediaTypeEssence !== "application/json" &&
          !mediaTypeEssence?.endsWith("+json");
        const challengeDecoder = new TextDecoder();
        let challengeProbe = "";
        if (reader !== undefined) {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > maximumBytes) {
              await reader.cancel();
              return {
                kind: "response-limit" as const,
                status: response.status,
                mediaType,
              };
            }
            if (rejectedNonJson) {
              challengeProbe += challengeDecoder.decode(next.value, {
                stream: true,
              });
              const normalized = challengeProbe.toLowerCase();
              if (
                normalized.includes("challenge-platform") ||
                normalized.includes("_cf_chl_opt") ||
                normalized.includes("cf-chl")
              ) {
                await reader.cancel();
                return {
                  kind: "cloudflare-challenge" as const,
                  status: response.status,
                  mediaType,
                  cfMitigated: null,
                };
              }
            }
            chunks.push(...next.value);
          }
        }
        return {
          kind: "response" as const,
          status: response.status,
          mediaType,
          body: chunks,
        };
      } catch (error) {
        return {
          kind: "fault" as const,
          fault:
            error instanceof DOMException && error.name === "AbortError"
              ? ("request-timeout" as const)
              : ("network-failure" as const),
        };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      address: fanboxEndpointAddress(endpoint),
      credentials:
        endpoint.kind === "post-detail" && endpoint.access === "public"
          ? ("omit" as const)
          : ("include" as const),
      maximumBytes,
      timeout: stepTimeoutMilliseconds,
    },
  );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    evaluation,
    new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(
        () => reject(new FanboxSessionTransportFault("request-timeout")),
        stepTimeoutMilliseconds,
      );
    }),
  ]).finally(() => {
    if (watchdog !== undefined) clearTimeout(watchdog);
  });
  if (result.kind === "fault")
    throw new FanboxSessionTransportFault(result.fault);
  if (result.kind === "response")
    return { ...result, body: Uint8Array.from(result.body) };
  return result;
}
