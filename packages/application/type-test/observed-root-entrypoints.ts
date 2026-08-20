import type {
  AssetRefreshSelection,
  AssetRefreshWorkflow,
  ObservedRootSnapshot,
} from "../src/index.js";

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
  // @ts-expect-error Production scan input accepts a registration identity, never a path.
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

// @ts-expect-error New filesystem selections must retain a frozen registered root.
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

// @ts-expect-error A possibly absent root snapshot cannot enter a new filesystem selection.
const rejectedOptionalObservedRoot: RegisteredFilesystemScope =
  optionalObservedRootScope;
void rejectedOptionalObservedRoot;

declare const workflow: AssetRefreshWorkflow;

// @ts-expect-error Legacy raw-path refresh is not a public Application API.
void workflow.refresh;
// @ts-expect-error Filesystem scans require a registered root identity.
void workflow.scanFilesystem;
// @ts-expect-error Re-scraping requires the registered-root public entrypoint.
void workflow.rescrape;
// @ts-expect-error Directed recognition requires the registered-root public entrypoint.
void workflow.directedRecognition;
// @ts-expect-error A terminal Source Refresh Run has no dedicated retry bypass.
void workflow.retrySourceRefreshRun;
