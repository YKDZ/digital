import {
  claimProcessTemporaryRoot,
  type ProcessTemporaryRootOwner,
} from "@digital/composition/process-temporary-root";

export type ProductServiceProcessTemporaryRoot = ProcessTemporaryRootOwner;
export type ProductServiceProcessTemporaryRootClaim = {
  beginInitialization(): void;
  commit(): void;
  retain(): void;
  rollback(): Promise<void>;
};
export type ProductServiceProcessTemporaryRootClaimRegistry = {
  claim(): Promise<ProductServiceProcessTemporaryRootClaim>;
  close(): Promise<void>;
};

const ownerSymbol = Symbol.for(
  "digital.product-service.process-temporary-root",
);
const processGlobal = globalThis as typeof globalThis & {
  [ownerSymbol]?: ProductServiceProcessTemporaryRootClaimRegistry;
};

export function createProductServiceProcessTemporaryRootClaimRegistry(
  environment: NodeJS.ProcessEnv,
  parentDirectory?: string,
): ProductServiceProcessTemporaryRootClaimRegistry {
  type OwnerState = {
    readonly owner: Promise<ProductServiceProcessTemporaryRoot>;
    readonly pending: Set<Promise<void>>;
    committed: boolean;
  };
  let current: OwnerState | undefined;
  let retiring: Promise<void> | undefined;
  let terminalClosing: Promise<void> | undefined;
  let closed = false;
  let poisoned = false;
  let poisonError: unknown;

  const retire = (state: OwnerState): Promise<void> => {
    if (current !== state) return Promise.resolve();
    current = undefined;
    const retirement = (async () => {
      try {
        await (await state.owner).close();
      } catch (error) {
        poisoned = true;
        poisonError = error;
        throw error;
      }
    })();
    retiring = retirement;
    void retirement.then(
      () => {
        if (retiring === retirement) retiring = undefined;
      },
      () => {
        if (retiring === retirement) retiring = undefined;
      },
    );
    return retirement;
  };

  return {
    async claim() {
      if (poisoned) throw poisonError;
      const retirement = retiring;
      if (retirement !== undefined) await retirement.catch(() => undefined);
      if (poisoned) throw poisonError;
      if (closed) throw new Error("产品服务进程临时根已关闭，不能再 claim");
      const state = (current ??= {
        owner: claimProcessTemporaryRoot(environment, {
          prefix: "digital-product-service-process-",
          ...(parentDirectory === undefined ? {} : { parentDirectory }),
        }),
        pending: new Set(),
        committed: false,
      });
      let settleToken!: () => void;
      const tokenSettled = new Promise<void>((resolve) => {
        settleToken = resolve;
      });
      state.pending.add(tokenSettled);
      let status:
        | "pending"
        | "initializing"
        | "committed"
        | "retained"
        | "rolled-back" = "pending";
      const settle = (next: "committed" | "retained" | "rolled-back"): void => {
        status = next;
        state.pending.delete(tokenSettled);
        settleToken();
      };
      try {
        await state.owner;
      } catch (error) {
        settle("rolled-back");
        if (current === state) current = undefined;
        throw error;
      }
      if (closed) {
        settle("rolled-back");
        throw new Error("产品服务进程临时根已关闭，不能再 claim");
      }
      return {
        beginInitialization() {
          if (status === "initializing") return;
          if (status !== "pending")
            throw new Error("产品服务进程临时根 claim 已结束");
          if (closed) {
            settle("rolled-back");
            throw new Error("产品服务进程临时根已关闭，不能开始初始化");
          }
          status = "initializing";
        },
        commit() {
          if (status === "committed") return;
          if (status !== "initializing")
            throw new Error("产品服务进程临时根 claim 未开始初始化");
          if (closed) {
            settle("rolled-back");
            throw new Error("产品服务进程临时根已关闭，不能提交初始化");
          }
          settle("committed");
          if (current === state) state.committed = true;
        },
        retain() {
          if (status === "retained") return;
          if (status !== "initializing")
            throw new Error("产品服务进程临时根 claim 未开始初始化");
          settle("retained");
          if (current === state) state.committed = true;
        },
        async rollback() {
          if (
            status === "committed" ||
            status === "retained" ||
            status === "rolled-back"
          )
            return;
          settle("rolled-back");
          if (
            !closed &&
            current === state &&
            !state.committed &&
            state.pending.size === 0
          )
            await retire(state);
        },
      };
    },
    close() {
      terminalClosing ??= (async () => {
        closed = true;
        const retirement = retiring;
        if (retirement !== undefined) await retirement.catch(() => undefined);
        if (poisoned) throw poisonError;
        const state = current;
        if (state === undefined) return;
        await Promise.all(state.pending);
        await (await state.owner).close();
        if (current === state) current = undefined;
      })();
      return terminalClosing;
    },
  };
}

const processRegistry =
  processGlobal[ownerSymbol] ??
  (processGlobal[ownerSymbol] =
    createProductServiceProcessTemporaryRootClaimRegistry(process.env));

export function claimProductServiceProcessTemporaryRoot(): Promise<ProductServiceProcessTemporaryRootClaim> {
  return processRegistry.claim();
}

export async function closeProductServiceProcessTemporaryRoot(): Promise<void> {
  await processRegistry.close();
}

export async function createProductServiceProcessTemporaryRoot(
  environment: NodeJS.ProcessEnv,
  parentDirectory: string,
): Promise<ProductServiceProcessTemporaryRoot> {
  return await claimProcessTemporaryRoot(environment, {
    prefix: "digital-product-service-process-",
    parentDirectory,
  });
}
