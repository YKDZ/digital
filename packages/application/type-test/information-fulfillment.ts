import type {
  InformationFulfillmentPlan,
  InformationFulfillmentPorts,
  InformationSubjectSelection,
} from "../src/index.ts";

type AssertFalse<Value extends false> = Value;
type IncludesForbiddenKey<Keys, Forbidden extends PropertyKey> =
  Extract<Keys, Forbidden> extends never ? false : true;

type SelectionDoesNotReceivePresentationIdentity = AssertFalse<
  IncludesForbiddenKey<
    keyof InformationSubjectSelection,
    "view" | "viewId" | "component" | "route" | "dlsite"
  >
>;
type PlanDoesNotReceivePresentationModel = AssertFalse<
  IncludesForbiddenKey<
    keyof InformationFulfillmentPlan,
    "view" | "component" | "route" | "output" | "dlsite"
  >
>;
type SchedulerOnlyReceivesNeutralPlan = AssertFalse<
  IncludesForbiddenKey<
    keyof Parameters<InformationFulfillmentPorts["start"]>[0],
    "view" | "component" | "route" | "output" | "dlsite"
  >
>;

export type {
  PlanDoesNotReceivePresentationModel,
  SchedulerOnlyReceivesNeutralPlan,
  SelectionDoesNotReceivePresentationIdentity,
};
