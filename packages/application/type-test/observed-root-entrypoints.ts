import type {
  AssetRefreshSelection,
  AssetRefreshWorkflow,
  ObservedRootSnapshot,
} from "../src/index.ts";

type RegisteredScanInput = Parameters<
  AssetRefreshWorkflow["scanObservedScope"]
>[0];

const registeredScan: RegisteredScanInput = {
  registrationId: "observed-root",
  relativeScope: ".",
  acceptTrusted: true,
};
void registeredScan;

const callerPathCannotBypassRegistration: RegisteredScanInput = {
  // @ts-expect-error 生产扫描输入接受注册身份，绝不接受路径。
  directory: "/host/media",
  acceptTrusted: true,
};
void callerPathCannotBypassRegistration;

type RegisteredFilesystemScope =
  AssetRefreshSelection["filesystemScopes"][number];

declare const registeredRoot: ObservedRootSnapshot;

const registeredFilesystemScope: RegisteredFilesystemScope = {
  root: "/container/media",
  observedRoot: registeredRoot,
  relativeScope: ".",
  explanations: [{ path: ["registered-root"] }],
};
void registeredFilesystemScope;

// @ts-expect-error 新文件系统选择必须保留冻结的已注册根。
const rootOnlyFilesystemScope: RegisteredFilesystemScope = {
  root: "/container/media",
  explanations: [{ path: ["legacy-root-only"] }],
};
void rootOnlyFilesystemScope;

declare const optionalObservedRootScope: {
  readonly root: string;
  readonly observedRoot?: ObservedRootSnapshot;
  readonly relativeScope: string;
  readonly explanations: readonly { readonly path: readonly string[] }[];
};

// @ts-expect-error 可能缺失的根快照不能进入新文件系统选择。
const rejectedOptionalObservedRoot: RegisteredFilesystemScope =
  optionalObservedRootScope;
void rejectedOptionalObservedRoot;

declare const workflow: AssetRefreshWorkflow;

// @ts-expect-error 旧版原始路径刷新不是公开应用层 API。
void workflow.refresh;
// @ts-expect-error 文件系统扫描需要已注册根身份。
void workflow.scanFilesystem;
// @ts-expect-error 重新抓取需要已注册根公开入口。
void workflow.rescrape;
// @ts-expect-error 定向识别需要已注册根公开入口。
void workflow.directedRecognition;
// @ts-expect-error 终态来源刷新运行没有专用重试绕过入口。
void workflow.retrySourceRefreshRun;
