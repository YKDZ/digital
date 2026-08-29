import type {
  AssetRefreshAutomationWorkflow,
  AssetRefreshWorkflow,
  AutomationClock,
  AutomationHost,
  AutomationInformationRequirementResolver,
  ExecutionHost,
  ObservedRootRegistrations,
} from "@digital/application";

import type { ProductSourceConnections } from "./source-connections.ts";

/** 交付层可以使用的产品工作流；其中不包含任何持久化或来源 Adapter。 */
export type ProductAssetRefresh = AssetRefreshWorkflow &
  AssetRefreshAutomationWorkflow & {
    readonly observedRootRegistrations: ObservedRootRegistrations;
    readonly sourceConnections: ProductSourceConnections;
    close(): Promise<void>;
  };

export type ProductAutomationHost = AutomationHost & {
  close(): Promise<void>;
};

/** Web 进程共享的一组产品能力和生命周期持有者。 */
export type ProductAssetRefreshRuntime = {
  readonly workflow: ProductAssetRefresh;
  readonly executionHost: ExecutionHost;
  readonly automationHost: ProductAutomationHost;
  close(): Promise<void>;
};

export type ProductAssetRefreshOptions = {
  readonly automationInformationRequirementForAcceptedSubject?: AutomationInformationRequirementResolver;
};

export type ProductAssetRefreshRuntimeOptions = ProductAssetRefreshOptions & {
  readonly clock?: AutomationClock;
  readonly pollIntervalMilliseconds?: number;
  readonly onError?: (error: unknown) => void;
};

export type ProductAutomationHostOptions = ProductAssetRefreshOptions & {
  readonly clock?: AutomationClock;
  readonly pollIntervalMilliseconds?: number;
  readonly onError?: (error: unknown) => void;
};

export type ProductManagedArtifactReference = {
  readonly digest: string;
};

/** 交付层只接收已由组合根创建的操作，不取得其资源释放权。 */
export type ProductWorkflowOperations = Omit<ProductAssetRefresh, "close">;

export type ProductAutomationOperations = Omit<ProductAutomationHost, "close">;

export type ProductExecutionOperations = Pick<ExecutionHost, "invoke">;

/**
 * 当前产品提供给交付层的唯一目标导向入口。产品数据位置、适配器和提供方实现均被
 * 封装在此边界之后；未配置的部署仍能启动健康检查，但不能打开产品数据。
 */
export type ProductApplication = {
  readonly configured: boolean;
  readonly workflow: ProductWorkflowOperations;
  readonly automation: ProductAutomationOperations;
  readonly execution: ProductExecutionOperations;
  startAutomation(options?: ProductAutomationHostOptions): Promise<void>;
  setAutomationInformationRequirementForAcceptedSubject(
    resolver: AutomationInformationRequirementResolver,
  ): void;
  createOfflineBackup(backupDirectory: string): Promise<void>;
  managedArtifactReference(
    address: string,
  ): ProductManagedArtifactReference | undefined;
  readManagedArtifact(digest: string): Promise<Uint8Array>;
};

/** 可执行根通过这个单一生命周期协议把产品交给一种交付方式。 */
export type ProductDelivery<Result> = {
  start(application: ProductApplication): Result;
};
