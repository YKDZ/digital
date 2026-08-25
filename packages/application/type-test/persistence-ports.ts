import type {
  AutomationQueries,
  AssetRefreshAutomationWorkflow,
  AssetRefreshWorkflowPorts,
  ChangeImpactQueries,
  RecognitionChangeImpactPersistence,
  RecognitionAcceptancePersistence,
  RecognitionReevaluationPersistence,
  WorkflowExecutionQueries,
  WorkflowExecutionCommands,
} from "../src/index.ts";

const inspectionOnlyDouble: WorkflowExecutionQueries = {
  async inspectExecution() {
    return undefined;
  },
  async listExecutions() {
    return [];
  },
  async listRunningExecutions() {
    return [];
  },
  async inspectRawSourceRecord() {
    return undefined;
  },
};

type AssertFalse<Value extends false> = Value;
type QueryDoesNotRequireExecutionMutation = AssertFalse<
  "createExecution" extends keyof WorkflowExecutionQueries ? true : false
>;
type QueryDoesNotRequireRecognitionMutation = AssertFalse<
  "acceptRecognition" extends keyof WorkflowExecutionQueries ? true : false
>;
type CommandsDoNotRequireInspection = AssertFalse<
  "inspectExecution" extends keyof WorkflowExecutionCommands ? true : false
>;
type PreviewQueriesDoNotRequireApply = AssertFalse<
  "applyChangeImpactPreview" extends keyof ChangeImpactQueries ? true : false
>;
type AtomicChangeImpactDoesNotRequireApply = AssertFalse<
  "applyChangeImpactPreview" extends keyof RecognitionChangeImpactPersistence
    ? true
    : false
>;
type AutomationQueriesDoNotRequireMutation = AssertFalse<
  "createAutomationIntent" extends keyof AutomationQueries ? true : false
>;
type BaseWorkflowDoesNotRequireAutomationQueries = AssertFalse<
  "automationQueries" extends keyof AssetRefreshWorkflowPorts ? true : false
>;
type BaseWorkflowDoesNotRequireAutomationCommands = AssertFalse<
  "automationCommands" extends keyof AssetRefreshWorkflowPorts ? true : false
>;
type AutomationFacadeDoesNotExposeRefreshInternals = AssertFalse<
  "refresh" extends keyof AssetRefreshAutomationWorkflow ? true : false
>;
type InitialAcceptanceDoesNotRequireReevaluation = AssertFalse<
  "refreshAcceptedRecognition" extends keyof RecognitionAcceptancePersistence
    ? true
    : false
>;
type ReevaluationDoesNotRequireInitialAcceptance = AssertFalse<
  "acceptRecognition" extends keyof RecognitionReevaluationPersistence
    ? true
    : false
>;

void inspectionOnlyDouble;
export type {
  CommandsDoNotRequireInspection,
  AtomicChangeImpactDoesNotRequireApply,
  AutomationQueriesDoNotRequireMutation,
  AutomationFacadeDoesNotExposeRefreshInternals,
  BaseWorkflowDoesNotRequireAutomationCommands,
  BaseWorkflowDoesNotRequireAutomationQueries,
  InitialAcceptanceDoesNotRequireReevaluation,
  PreviewQueriesDoNotRequireApply,
  QueryDoesNotRequireExecutionMutation,
  QueryDoesNotRequireRecognitionMutation,
  ReevaluationDoesNotRequireInitialAcceptance,
};
