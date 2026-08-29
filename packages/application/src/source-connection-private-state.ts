export type SourceConnectionPrivateStateStatus =
  | "missing"
  | "permissions-unsafe"
  | "storage-invalid"
  | "usable";

export type SourceConnectionPrivateStateRead =
  | {
      readonly status: Exclude<SourceConnectionPrivateStateStatus, "usable">;
    }
  | { readonly status: "usable"; readonly value: unknown };

export type SourceConnectionPrivateStateListing = {
  readonly status: SourceConnectionPrivateStateStatus;
  readonly keys: readonly string[];
};

export type SourceConnectionPrivateLeaseRecord = {
  readonly schema: "product-private-lease/1";
  readonly version: string;
  readonly instanceNonce: string;
  readonly leaseNonce: string;
  readonly fingerprint: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
};

export type SourceConnectionPrivateLeaseOwnership<
  Record extends SourceConnectionPrivateLeaseRecord,
> = {
  record(): Record;
  isCurrent(): boolean;
  retire(): boolean;
};

export type SourceConnectionPrivateLease<
  Record extends SourceConnectionPrivateLeaseRecord,
> = {
  tryAcquire(candidate: Record): boolean;
  acquire(
    candidate: Record,
  ): SourceConnectionPrivateLeaseOwnership<Record> | undefined;
  reclaimStale(): boolean;
  isLive(): boolean;
  currentRecord(): Record | undefined;
  retireExact(expected: Record): boolean;
  consumeToActive(
    expected: Record,
    target: SourceConnectionPrivateLease<Record>,
  ): SourceConnectionPrivateLeaseOwnership<Record> | undefined;
};

/**
 * 来源连接能力使用的不透明私密状态端口。能力拥有记录格式和授权生命周期；端口只负责
 * 安全读取、耐久提交、列举逻辑键与跨进程租约，不定义通用凭据模式。
 */
export type SourceConnectionPrivateStatePort = {
  read(key: string): SourceConnectionPrivateStateRead;
  write(input: {
    readonly key: string;
    readonly value: unknown;
    readonly failureMessage: string;
  }): void;
  list(): SourceConnectionPrivateStateListing;
  lease<Record extends SourceConnectionPrivateLeaseRecord>(input: {
    readonly key: string;
    /** 让若干逻辑槽共享一个不可变租约命名空间。 */
    readonly namespaceKey?: string;
    readonly now: () => Date;
    /** 仅供能力测试注入的确定性 Linux 单调时钟。 */
    readonly monotonicNow?: () => number;
    /** 仅供能力测试注入的确定性 Linux 启动身份。 */
    readonly bootId?: () => string;
    readonly isRecord: (value: unknown) => value is Record;
    readonly failureMessage: string;
  }): SourceConnectionPrivateLease<Record>;
};
