import { rm, stat } from "node:fs/promises";

import { knownSourceAssociationEvidenceCapability } from "@digital/application";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => ({
  launches: 0,
  contexts: 0,
  contextCloses: 0,
  browserCloses: 0,
  serverKills: 0,
  operations: [] as Array<{
    readonly context: number;
    readonly pathname: string;
    readonly credentials: "include" | "omit";
  }>,
  connectedChallenge: false,
  bodyChallenge: false,
  challengeCancels: 0,
  challengeMarker: "challenge-platform-browser-private-marker",
  launchOptions: undefined as
    | {
        readonly downloadsPath: string;
        readonly artifactsDir: string;
        readonly env: NodeJS.ProcessEnv;
        readonly host: string;
        readonly port: number;
      }
    | undefined,
  blockLaunchServer: false,
  releaseLaunchServer: undefined as (() => void) | undefined,
  blockSummary: false,
  blockNewContext: false,
  releaseNewContext: undefined as (() => void) | undefined,
  releaseNewContextOnBrowserClose: true,
  blockNewPage: false,
  releaseNewPage: undefined as (() => void) | undefined,
  blockAddCookies: false,
  releaseAddCookies: undefined as (() => void) | undefined,
  blockGoto: false,
  releaseGoto: undefined as (() => void) | undefined,
  blockContextClose: false,
  releaseContextClose: undefined as (() => void) | undefined,
  blockPageClose: false,
  releasePageClose: undefined as (() => void) | undefined,
  rejectBlocked: undefined as (() => void) | undefined,
  blockEvaluate: false,
  releaseEvaluate: undefined as (() => void) | undefined,
  disconnect: undefined as (() => void) | undefined,
  disconnectLeavesProcessAlive: false,
  rejectBrowserClose: false,
  rejectPageClose: false,
  rejectServerKill: false,
  connectableBrowser: undefined as unknown,
  rejectConnect: false,
}));

vi.mock("playwright", () => ({
  chromium: {
    async launchServer(options: {
      readonly downloadsPath: string;
      readonly artifactsDir: string;
      readonly env: NodeJS.ProcessEnv;
      readonly host: string;
      readonly port: number;
    }) {
      renderer.launches += 1;
      renderer.launchOptions = options;
      if (renderer.blockLaunchServer)
        await new Promise<void>((resolve) => {
          renderer.releaseLaunchServer = resolve;
        });
      const listeners = new Map<string, () => void>();
      const process = {
        exitCode: null as number | null,
        signalCode: null as string | null,
      };
      let connected = true;
      const disconnect = (signal: string | undefined) => {
        if (!connected) return;
        connected = false;
        if (signal === undefined) process.exitCode = 0;
        else process.signalCode = signal;
        listeners.get("disconnected")?.();
      };
      renderer.disconnect = () => {
        if (renderer.disconnectLeavesProcessAlive) {
          if (!connected) return;
          connected = false;
          listeners.get("disconnected")?.();
        } else disconnect("SIGKILL");
      };
      renderer.connectableBrowser = {
        on(name: string, listener: () => void) {
          listeners.set(name, listener);
        },
        isConnected() {
          return connected;
        },
        async newContext() {
          if (renderer.blockNewContext)
            await new Promise<void>((resolve) => {
              renderer.releaseNewContext = resolve;
            });
          renderer.contexts += 1;
          const context = renderer.contexts;
          return {
            async addCookies() {
              if (renderer.blockAddCookies)
                await new Promise<void>((resolve) => {
                  renderer.releaseAddCookies = resolve;
                });
            },
            async newPage() {
              if (renderer.blockNewPage)
                await new Promise<void>((resolve) => {
                  renderer.releaseNewPage = resolve;
                });
              return {
                async goto(address: string) {
                  expect(address).toBe("https://www.fanbox.cc/");
                  if (renderer.blockGoto)
                    await new Promise<void>((resolve) => {
                      renderer.releaseGoto = resolve;
                    });
                },
                async evaluate(
                  callback: (input: {
                    readonly address: string;
                    readonly credentials: "include" | "omit";
                    readonly maximumBytes: number;
                    readonly timeout: number;
                  }) => Promise<unknown>,
                  input: {
                    readonly address: string;
                    readonly credentials: "include" | "omit";
                    readonly maximumBytes: number;
                    readonly timeout: number;
                  },
                ) {
                  const address = new URL(input.address);
                  renderer.operations.push({
                    context,
                    pathname: address.pathname,
                    credentials: input.credentials,
                  });
                  if (renderer.blockEvaluate)
                    await new Promise<void>((resolve) => {
                      renderer.releaseEvaluate = resolve;
                    });
                  if (
                    renderer.bodyChallenge &&
                    address.pathname === "/post.info" &&
                    input.credentials === "include"
                  ) {
                    const previousFetch = globalThis.fetch;
                    let reads = 0;
                    globalThis.fetch = (async () => ({
                      status: 403,
                      headers: {
                        get: (name: string) =>
                          name.toLowerCase() === "content-type"
                            ? "text/html"
                            : null,
                      },
                      body: {
                        async cancel() {
                          renderer.challengeCancels += 1;
                        },
                        getReader: () => ({
                          async read() {
                            reads += 1;
                            if (reads === 1)
                              return {
                                done: false,
                                value: new TextEncoder().encode(
                                  renderer.challengeMarker,
                                ),
                              };
                            if (reads === 2)
                              return {
                                done: false,
                                value: new TextEncoder().encode(
                                  "body-must-not-cross-seam",
                                ),
                              };
                            return { done: true, value: undefined };
                          },
                          async cancel() {
                            renderer.challengeCancels += 1;
                          },
                        }),
                      },
                    })) as typeof fetch;
                    try {
                      return await callback(input);
                    } finally {
                      globalThis.fetch = previousFetch;
                    }
                  }
                  if (
                    renderer.blockSummary &&
                    address.pathname === "/post.listCreator"
                  ) {
                    await new Promise<never>((_resolve, reject) => {
                      renderer.rejectBlocked = () =>
                        reject(new Error("page closed"));
                    });
                  }
                  if (
                    renderer.connectedChallenge &&
                    address.pathname === "/post.info" &&
                    input.credentials === "include"
                  ) {
                    return {
                      kind: "cloudflare-challenge",
                      status: 403,
                      mediaType: "text/html",
                      cfMitigated: "challenge",
                    };
                  }
                  const body =
                    address.pathname === "/user.countUnreadMessages"
                      ? { body: 0 }
                      : address.pathname === "/post.listCreator"
                        ? {
                            body: {
                              posts: [
                                {
                                  id: "9135862",
                                  creatorId: "customudon",
                                  title: "测试帖子",
                                  publishedDatetime:
                                    "2025-01-01T00:11:17+09:00",
                                },
                              ],
                            },
                          }
                        : {
                            body: {
                              post: {
                                id: "9135862",
                                creatorId: "customudon",
                                title: "测试帖子",
                                publishedDatetime: "2025-01-01T00:11:17+09:00",
                                type: "text",
                                body: { text: "正文" },
                              },
                            },
                          };
                  return {
                    kind: "response",
                    status: 200,
                    mediaType: "application/json",
                    body: Array.from(
                      new TextEncoder().encode(JSON.stringify(body)),
                    ),
                  };
                },
                async close() {
                  if (renderer.blockPageClose)
                    await new Promise<void>((resolve) => {
                      renderer.releasePageClose = resolve;
                    });
                  if (renderer.rejectPageClose)
                    throw new Error("raw page close failure");
                },
              };
            },
            async close() {
              renderer.releaseNewPage?.();
              renderer.rejectBlocked?.();
              renderer.rejectBlocked = undefined;
              renderer.contextCloses += 1;
              if (renderer.blockContextClose)
                await new Promise<void>((resolve) => {
                  renderer.releaseContextClose = resolve;
                });
            },
          };
        },
        async close() {
          renderer.browserCloses += 1;
          if (renderer.rejectBrowserClose)
            throw new Error("raw browser close failure");
          if (renderer.releaseNewContextOnBrowserClose)
            renderer.releaseNewContext?.();
          disconnect(undefined);
        },
      };
      return {
        wsEndpoint: () => "ws://127.0.0.1/fanbox-test",
        process: () => process,
        async kill() {
          renderer.serverKills += 1;
          if (renderer.rejectServerKill)
            throw new Error("raw server kill failure");
          process.signalCode = "SIGKILL";
          disconnect("SIGKILL");
        },
      };
    },
    async connect() {
      if (renderer.rejectConnect)
        throw new Error("raw browser connect failure");
      return renderer.connectableBrowser;
    },
  },
}));

import { createPlaywrightFanboxSessionTransport } from "../src/browser-session.ts";
import { createFanboxProductAssembly } from "../src/index.ts";

beforeEach(() => {
  renderer.launches = 0;
  renderer.contexts = 0;
  renderer.contextCloses = 0;
  renderer.browserCloses = 0;
  renderer.serverKills = 0;
  renderer.operations = [];
  renderer.connectedChallenge = false;
  renderer.bodyChallenge = false;
  renderer.challengeCancels = 0;
  renderer.launchOptions = undefined;
  renderer.blockLaunchServer = false;
  renderer.releaseLaunchServer = undefined;
  renderer.blockSummary = false;
  renderer.blockNewContext = false;
  renderer.releaseNewContext = undefined;
  renderer.releaseNewContextOnBrowserClose = true;
  renderer.blockNewPage = false;
  renderer.releaseNewPage = undefined;
  renderer.blockAddCookies = false;
  renderer.releaseAddCookies = undefined;
  renderer.blockGoto = false;
  renderer.releaseGoto = undefined;
  renderer.blockContextClose = false;
  renderer.releaseContextClose = undefined;
  renderer.blockPageClose = false;
  renderer.releasePageClose = undefined;
  renderer.rejectBlocked = undefined;
  renderer.blockEvaluate = false;
  renderer.releaseEvaluate = undefined;
  renderer.disconnect = undefined;
  renderer.disconnectLeavesProcessAlive = false;
  renderer.rejectBrowserClose = false;
  renderer.rejectPageClose = false;
  renderer.rejectServerKill = false;
  renderer.connectableBrowser = undefined;
  renderer.rejectConnect = false;
});

describe("FANBOX browser product assembly", () => {
  it("验证与采集各用 fresh context，并在同一采集 session 只追加一次 public detail", async () => {
    const assembly = createFanboxProductAssembly();
    const privateConfiguration = await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      },
    });
    renderer.connectedChallenge = true;
    const collector = assembly.createCollector({
      creatorIds: () => ["customudon"],
      privateConfigurationForExecution: () => privateConfiguration,
    });
    const result = await collector.collect({
      kind: "source-association",
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    });

    expect(result.records).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(renderer.launches).toBe(1);
    expect(renderer.contexts).toBe(2);
    expect(renderer.operations).toEqual([
      {
        context: 1,
        pathname: "/user.countUnreadMessages",
        credentials: "include",
      },
      { context: 1, pathname: "/post.listCreator", credentials: "include" },
      { context: 1, pathname: "/post.info", credentials: "include" },
      { context: 2, pathname: "/post.listCreator", credentials: "include" },
      { context: 2, pathname: "/post.info", credentials: "include" },
      { context: 2, pathname: "/post.info", credentials: "omit" },
    ]);
    expect(renderer.contextCloses).toBe(2);
    const owner = renderer.launchOptions!.env.HOME!;
    expect(renderer.launchOptions!.env.TMPDIR).toBe(owner);
    expect(renderer.launchOptions).toMatchObject({
      host: "127.0.0.1",
      port: 0,
    });
    expect(renderer.launchOptions!.downloadsPath.startsWith(`${owner}/`)).toBe(
      true,
    );
    expect(renderer.launchOptions!.artifactsDir.startsWith(`${owner}/`)).toBe(
      true,
    );
    expect(owner.startsWith("/data/")).toBe(false);
    expect((await stat(owner)).mode & 0o777).toBe(0o700);
    const firstClose = assembly.close();
    expect(assembly.close()).toBe(firstClose);
    await firstClose;
    expect(renderer.browserCloses).toBe(1);
    await expect(stat(owner)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("无 header 的非 JSON challenge 在 renderer 内命中即取消，正文不越 closed seam", async () => {
    const assembly = createFanboxProductAssembly();
    const privateConfiguration = await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      },
    });
    renderer.bodyChallenge = true;
    const collector = assembly.createCollector({
      creatorIds: () => ["customudon"],
      privateConfigurationForExecution: () => privateConfiguration,
    });

    const result = await collector.collect({
      kind: "source-association",
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    });

    expect(result.records).toHaveLength(2);
    expect(renderer.challengeCancels).toBe(1);
    expect(JSON.stringify(result)).not.toContain(renderer.challengeMarker);
    expect(JSON.stringify(result)).not.toContain("body-must-not-cross-seam");
    await assembly.close();
  });

  it("close 取消活动事务并等待其 settle，关闭后不再启动 runtime", async () => {
    const assembly = createFanboxProductAssembly();
    const privateConfiguration = await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      },
    });
    renderer.blockSummary = true;
    const collector = assembly.createCollector({
      creatorIds: () => ["customudon"],
      privateConfigurationForExecution: () => privateConfiguration,
    });
    const collecting = collector.collect({
      kind: "source-association",
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    });
    while (renderer.rejectBlocked === undefined)
      await new Promise((resolve) => setTimeout(resolve, 0));

    const closing = assembly.close();
    const result = await collecting;
    await closing;

    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ failureCode: "transport-failure" }),
    ]);
    expect(
      renderer.operations.filter(
        ({ context, pathname }) => context === 2 && pathname === "/post.info",
      ),
    ).toEqual([]);
    await expect(
      assembly.verifyStoredCredential({
        creatorId: "customudon",
        privateConfiguration,
      }),
    ).rejects.toThrow("FANBOX 来源连接验证失败");
    expect(renderer.launches).toBe(1);
    expect(renderer.browserCloses).toBe(1);
    expect(renderer.contextCloses).toBe(2);
  });

  it("并发冷启动 single-flight，generation 断开后的下一独立事务才 lazy restart", async () => {
    const assembly = createFanboxProductAssembly();
    const privateConfiguration = JSON.stringify({
      format: "fanbox-browser-request-context/2",
      userAgent: "test-browser/1",
      cookies: [
        {
          name: "FANBOXSESSID",
          value: "test-private-session",
          domain: ".fanbox.cc",
          path: "/",
        },
      ],
    });

    await Promise.all([
      assembly.verifyStoredCredential({
        creatorId: "customudon",
        privateConfiguration,
      }),
      assembly.verifyStoredCredential({
        creatorId: "customudon",
        privateConfiguration,
      }),
    ]);
    expect(renderer.launches).toBe(1);
    expect(renderer.contexts).toBe(2);

    renderer.disconnect!();
    await assembly.verifyStoredCredential({
      creatorId: "customudon",
      privateConfiguration,
    });
    expect(renderer.launches).toBe(2);
    expect(renderer.contexts).toBe(3);
    await assembly.close();
  });

  it("browser close 拒绝时以公开终止 primitive 收尾并只暴露固定安全 fault", async () => {
    const assembly = createFanboxProductAssembly();
    await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      },
    });
    const owner = renderer.launchOptions!.env.HOME!;
    renderer.rejectBrowserClose = true;

    const closing = assembly.close();
    await expect(closing).rejects.toThrow(
      "FANBOX browser session transport failed",
    );
    await expect(closing).rejects.not.toThrow("raw browser close failure");
    expect(renderer.serverKills).toBe(1);
    await expect(stat(owner)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("部分启动失败也终止 BrowserServer、清理 owner 并只暴露固定安全 fault", async () => {
    const assembly = createFanboxProductAssembly();
    renderer.rejectConnect = true;

    await expect(
      assembly.validatedBrowserCredential({
        creatorId: "customudon",
        browserCredential: {
          userAgent: "test-browser/1",
          cookies: [
            {
              name: "FANBOXSESSID",
              value: "test-private-session",
              domain: ".fanbox.cc",
              path: "/",
            },
          ],
        },
      }),
    ).rejects.toThrow("FANBOX 来源连接验证失败");
    expect(renderer.serverKills).toBe(1);
    await expect(stat(renderer.launchOptions!.env.HOME)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assembly.close();
  });

  it("部分启动无法终止 BrowserServer 时保留 owner，并让最终 close 以固定安全 fault 拒绝", async () => {
    const assembly = createFanboxProductAssembly();
    renderer.rejectConnect = true;
    renderer.rejectServerKill = true;
    let owner: string | undefined;

    try {
      await expect(
        assembly.validatedBrowserCredential({
          creatorId: "customudon",
          browserCredential: {
            userAgent: "test-browser/1",
            cookies: [
              {
                name: "FANBOXSESSID",
                value: "test-private-session",
                domain: ".fanbox.cc",
                path: "/",
              },
            ],
          },
        }),
      ).rejects.toThrow("FANBOX 来源连接验证失败");
      owner = renderer.launchOptions!.env.HOME!;
      await expect(stat(owner)).resolves.toBeDefined();
      expect(renderer.serverKills).toBe(1);

      const closing = assembly.close();
      await expect(closing).rejects.toThrow(
        "FANBOX browser session transport failed",
      );
      await expect(closing).rejects.not.toThrow("raw server kill failure");
      expect(renderer.serverKills).toBe(2);
      await expect(stat(owner)).resolves.toBeDefined();
    } finally {
      if (owner !== undefined)
        await rm(owner, { recursive: true, force: true });
    }
  });

  it("close 等待 pending launch 不再发布资源，清理迟到 server 后才 settle", async () => {
    const transport = createPlaywrightFanboxSessionTransport();
    renderer.blockLaunchServer = true;
    let owner: string | undefined;
    let fakeTimers = false;

    try {
      const transaction = transport.transact({
        creatorId: "customudon",
        privateContext: {
          format: "fanbox-browser-request-context/2",
          userAgent: "test-browser/1",
          cookies: [
            {
              name: "FANBOXSESSID",
              value: "test-private-session",
              domain: ".fanbox.cc",
              path: "/",
            },
          ],
        },
        use: async () => undefined,
      });
      void transaction.catch(() => undefined);
      while (renderer.releaseLaunchServer === undefined)
        await new Promise((resolve) => setTimeout(resolve, 0));
      owner = renderer.launchOptions!.env.HOME!;
      vi.useFakeTimers();
      fakeTimers = true;

      let closeSettled = false;
      const closing = transport.close();
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );
      void closing.catch(() => undefined);
      expect(transport.close()).toBe(closing);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(closeSettled).toBe(false);
      await expect(stat(owner)).resolves.toBeDefined();
      renderer.releaseLaunchServer();
      await expect(closing).resolves.toBeUndefined();
      await expect(transaction).rejects.toThrow(
        "FANBOX browser session transport failed",
      );
      expect(renderer.browserCloses).toBe(1);
      await expect(stat(owner)).rejects.toMatchObject({ code: "ENOENT" });
      expect(transport.close()).toBe(closing);
    } finally {
      renderer.releaseLaunchServer?.();
      await Promise.resolve();
      await Promise.resolve();
      if (fakeTimers) {
        await vi.runAllTimersAsync();
        vi.useRealTimers();
      }
      if (owner !== undefined)
        await rm(owner, { recursive: true, force: true });
    }
  });

  it("page close 失败时仍恰好关闭 context，并让原本成功的事务安全失败", async () => {
    const assembly = createFanboxProductAssembly();
    renderer.rejectPageClose = true;

    await expect(
      assembly.validatedBrowserCredential({
        creatorId: "customudon",
        browserCredential: {
          userAgent: "test-browser/1",
          cookies: [
            {
              name: "FANBOXSESSID",
              value: "test-private-session",
              domain: ".fanbox.cc",
              path: "/",
            },
          ],
        },
      }),
    ).rejects.toThrow("FANBOX 来源连接验证失败");
    expect(renderer.contextCloses).toBe(1);
    await assembly.close();
  });

  it("ready generation 下同 tick transact 与 close 仍先等待事务 settle", async () => {
    const assembly = createFanboxProductAssembly();
    const privateConfiguration = await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      },
    });
    renderer.blockNewContext = true;
    const order: string[] = [];

    const transaction = assembly
      .verifyStoredCredential({ creatorId: "customudon", privateConfiguration })
      .then(
        () => order.push("transaction"),
        () => order.push("transaction"),
      );
    const closing = assembly.close().then(() => order.push("close"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.releaseNewContext?.();
    await Promise.allSettled([transaction, closing]);

    expect(order).toEqual(["transaction", "close"]);
  });

  it("close 主动终止卡在 newContext 的事务并收割 generation", async () => {
    const assembly = createFanboxProductAssembly();
    const privateConfiguration = await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      },
    });
    renderer.blockNewContext = true;
    const transaction = assembly.verifyStoredCredential({
      creatorId: "customudon",
      privateConfiguration,
    });
    void transaction.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const closing = assembly.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.allSettled([transaction, closing]);

    expect(renderer.browserCloses).toBe(1);
    expect(renderer.contextCloses).toBe(2);
  });

  it.each(["newContext", "newPage"] as const)(
    "close 在 generation 收割后仍等待迟到 %s 的 cleanup",
    async (stage) => {
      const assembly = createFanboxProductAssembly();
      const privateConfiguration = await assembly.validatedBrowserCredential({
        creatorId: "customudon",
        browserCredential: {
          userAgent: "test-browser/1",
          cookies: [
            {
              name: "FANBOXSESSID",
              value: "test-private-session",
              domain: ".fanbox.cc",
              path: "/",
            },
          ],
        },
      });
      if (stage === "newContext") {
        renderer.blockNewContext = true;
        renderer.blockContextClose = true;
      } else {
        renderer.blockNewPage = true;
        renderer.blockPageClose = true;
      }
      const transaction = assembly.verifyStoredCredential({
        creatorId: "customudon",
        privateConfiguration,
      });
      void transaction.catch(() => undefined);
      while (
        (stage === "newContext"
          ? renderer.releaseNewContext
          : renderer.releaseNewPage) === undefined
      )
        await Promise.resolve();

      let closeSettled = false;
      const closing = assembly.close().then(
        () => {
          closeSettled = true;
        },
        (error: unknown) => {
          closeSettled = true;
          throw error;
        },
      );
      void closing.catch(() => undefined);
      while (
        (stage === "newContext"
          ? renderer.releaseContextClose
          : renderer.releasePageClose) === undefined
      )
        await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(closeSettled).toBe(false);
      if (stage === "newContext") renderer.releaseContextClose!();
      else renderer.releasePageClose!();
      await expect(closing).resolves.toBeUndefined();
      await expect(transaction).rejects.toThrow("FANBOX 来源连接验证失败");
    },
  );

  it("迟到 disposer 拒绝时 close 只暴露固定安全 fault", async () => {
    const assembly = createFanboxProductAssembly();
    const privateConfiguration = await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      },
    });
    renderer.blockNewPage = true;
    renderer.rejectPageClose = true;
    const transaction = assembly.verifyStoredCredential({
      creatorId: "customudon",
      privateConfiguration,
    });
    void transaction.catch(() => undefined);
    while (renderer.releaseNewPage === undefined) await Promise.resolve();

    const closing = assembly.close();
    await expect(closing).rejects.toThrow(
      "FANBOX browser session transport failed",
    );
    await expect(closing).rejects.not.toThrow("raw page close failure");
    await expect(transaction).rejects.toThrow("FANBOX 来源连接验证失败");
  });

  it.each(["operation", "disposer"] as const)(
    "迟到 %s 永不 settle 时 close 在既有安全边界明确拒绝",
    async (pending) => {
      vi.useFakeTimers();
      const assembly = createFanboxProductAssembly();
      try {
        const privateConfiguration = await assembly.validatedBrowserCredential({
          creatorId: "customudon",
          browserCredential: {
            userAgent: "test-browser/1",
            cookies: [
              {
                name: "FANBOXSESSID",
                value: "test-private-session",
                domain: ".fanbox.cc",
                path: "/",
              },
            ],
          },
        });
        const owner = renderer.launchOptions!.env.HOME!;
        renderer.blockNewContext = true;
        if (pending === "operation")
          renderer.releaseNewContextOnBrowserClose = false;
        else renderer.blockContextClose = true;
        const transaction = assembly.verifyStoredCredential({
          creatorId: "customudon",
          privateConfiguration,
        });
        void transaction.catch(() => undefined);
        while (renderer.releaseNewContext === undefined)
          await Promise.resolve();

        const closing = assembly.close();
        void closing.catch(() => undefined);
        if (pending === "operation") {
          while (renderer.browserCloses === 0) await Promise.resolve();
          await expect(transaction).rejects.toThrow("FANBOX 来源连接验证失败");
          let ownerRemoved = false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
              await stat(owner);
            } catch {
              ownerRemoved = true;
              break;
            }
          }
          expect(ownerRemoved).toBe(true);
          while (vi.getTimerCount() === 0) await Promise.resolve();
        } else {
          while (renderer.releaseContextClose === undefined)
            await Promise.resolve();
        }
        await vi.advanceTimersByTimeAsync(30_000);

        await expect(closing).rejects.toThrow(
          "FANBOX browser session transport failed",
        );
        if (pending === "disposer")
          await expect(transaction).rejects.toThrow("FANBOX 来源连接验证失败");
        if (pending === "operation") renderer.releaseNewContext();
        else renderer.releaseContextClose!();
        await Promise.resolve();
        await Promise.resolve();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["addCookies", "goto", "rendererGet", "use"] as const)(
    "%s operation 在取消后永久 pending 时最终 close 明确拒绝",
    async (stage) => {
      const transport = createPlaywrightFanboxSessionTransport();
      let releaseUse: (() => void) | undefined;
      let fakeTimers = false;
      try {
        renderer.blockAddCookies = stage === "addCookies";
        renderer.blockGoto = stage === "goto";
        renderer.blockEvaluate = stage === "rendererGet";
        const transaction = transport.transact({
          creatorId: "customudon",
          privateContext: {
            format: "fanbox-browser-request-context/2",
            userAgent: "test-browser/1",
            cookies: [
              {
                name: "FANBOXSESSID",
                value: "test-private-session",
                domain: ".fanbox.cc",
                path: "/",
              },
            ],
          },
          use: async (get) => {
            if (stage === "rendererGet") await get({ kind: "login-status" });
            if (stage === "use")
              await new Promise<void>((resolve) => {
                releaseUse = resolve;
              });
          },
        });
        void transaction.catch(() => undefined);
        while (
          (stage === "addCookies"
            ? renderer.releaseAddCookies
            : stage === "goto"
              ? renderer.releaseGoto
              : stage === "rendererGet"
                ? renderer.releaseEvaluate
                : releaseUse) === undefined
        )
          await new Promise((resolve) => setTimeout(resolve, 0));
        const owner = renderer.launchOptions!.env.HOME!;
        vi.useFakeTimers();
        fakeTimers = true;

        const closing = transport.close();
        void closing.catch(() => undefined);
        await expect(transaction).rejects.toThrow(
          "FANBOX browser session transport failed",
        );
        let ownerRemoved = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            await stat(owner);
          } catch {
            ownerRemoved = true;
            break;
          }
        }
        expect(ownerRemoved).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(30_000);

        await expect(closing).rejects.toThrow(
          "FANBOX browser session transport failed",
        );
      } finally {
        if (stage === "addCookies") renderer.releaseAddCookies?.();
        else if (stage === "goto") renderer.releaseGoto?.();
        else if (stage === "rendererGet") renderer.releaseEvaluate?.();
        else releaseUse?.();
        await Promise.resolve();
        await Promise.resolve();
        await vi.runAllTimersAsync();
        if (fakeTimers) vi.useRealTimers();
      }
    },
  );

  it.each([
    { finalKillFails: false, ownerRetained: false },
    { finalKillFails: true, ownerRetained: true },
  ])(
    "generation disconnect cleanup 首败后 final kill 失败=$finalKillFails 时按 owner 状态收口",
    async ({ finalKillFails, ownerRetained }) => {
      const assembly = createFanboxProductAssembly();
      let owner: string | undefined;
      try {
        await assembly.validatedBrowserCredential({
          creatorId: "customudon",
          browserCredential: {
            userAgent: "test-browser/1",
            cookies: [
              {
                name: "FANBOXSESSID",
                value: "test-private-session",
                domain: ".fanbox.cc",
                path: "/",
              },
            ],
          },
        });
        owner = renderer.launchOptions!.env.HOME!;
        renderer.disconnectLeavesProcessAlive = true;
        renderer.rejectServerKill = true;
        renderer.disconnect!();
        while (renderer.serverKills < 1)
          await new Promise((resolve) => setTimeout(resolve, 0));
        await expect(stat(owner)).resolves.toBeDefined();
        renderer.rejectServerKill = finalKillFails;

        await expect(assembly.close()).rejects.toThrow(
          "FANBOX browser session transport failed",
        );
        expect(renderer.serverKills).toBe(2);
        if (ownerRetained) await expect(stat(owner)).resolves.toBeDefined();
        else
          await expect(stat(owner)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (owner !== undefined)
          await rm(owner, { recursive: true, force: true });
      }
    },
  );

  it("close 在活动事务 cleanup 失败后仍收割 generation 并诚实拒绝", async () => {
    const assembly = createFanboxProductAssembly();
    const privateConfiguration = await assembly.validatedBrowserCredential({
      creatorId: "customudon",
      browserCredential: {
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: "test-private-session",
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      },
    });
    renderer.blockSummary = true;
    renderer.rejectPageClose = true;
    const collector = assembly.createCollector({
      creatorIds: () => ["customudon"],
      privateConfigurationForExecution: () => privateConfiguration,
    });
    const collecting = collector.collect({
      kind: "source-association",
      sourceIdentity: "fanbox",
      sourceAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      explanation: "known",
      producer: knownSourceAssociationEvidenceCapability,
    });
    while (renderer.rejectBlocked === undefined)
      await new Promise((resolve) => setTimeout(resolve, 0));

    const closing = assembly.close();
    await expect(collecting).resolves.toEqual(
      expect.objectContaining({ records: [] }),
    );
    await expect(closing).rejects.toThrow(
      "FANBOX browser session transport failed",
    );
    expect(renderer.browserCloses).toBe(1);
  });

  it("Node watchdog 终止未能启动或 settle 的 renderer evaluate", async () => {
    vi.useFakeTimers();
    const assembly = createFanboxProductAssembly();
    try {
      const privateConfiguration = await assembly.validatedBrowserCredential({
        creatorId: "customudon",
        browserCredential: {
          userAgent: "test-browser/1",
          cookies: [
            {
              name: "FANBOXSESSID",
              value: "test-private-session",
              domain: ".fanbox.cc",
              path: "/",
            },
          ],
        },
      });
      renderer.blockEvaluate = true;
      const verification = assembly.verifyStoredCredential({
        creatorId: "customudon",
        privateConfiguration,
      });
      void verification.catch(() => undefined);
      while (renderer.releaseEvaluate === undefined) await Promise.resolve();

      await vi.advanceTimersByTimeAsync(30_000);
      renderer.blockEvaluate = false;
      renderer.releaseEvaluate();

      await expect(verification).rejects.toThrow("FANBOX 来源连接验证失败");
      expect(renderer.contextCloses).toBe(2);
    } finally {
      await assembly.close().catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
