import type {
  ObservedRootCleanupFailureFallback,
  ObservedRootCleanupReportingFailure,
} from "@digital/application";

/**
 * The process keeps only the newest incidents.  A cleanup-reporting failure
 * is exceptional operational evidence, not a durable workflow record, so a
 * bounded emergency journal must never compete with catalogue availability.
 */
export const observedRootCleanupEmergencyJournalCapacity = 64;

type SanitizedCleanupErrorKind =
  | "bigint"
  | "boolean"
  | "error"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

/**
 * A process-local record deliberately preserves only logical registration
 * coordinates and value kinds. It never retains raw adapter errors, paths,
 * descriptor state, or credential-bearing text.
 */
export type ObservedRootCleanupEmergencyIncident = {
  readonly event: "observed-root-cleanup-reporting-failure";
  readonly operation: ObservedRootCleanupReportingFailure["cleanupFailure"]["operation"];
  readonly cleanup: ObservedRootCleanupReportingFailure["cleanupFailure"]["cleanup"];
  readonly rootId: string;
  readonly relativeScope: string;
  readonly cleanupErrorKind: SanitizedCleanupErrorKind;
  readonly reporterErrorKind: SanitizedCleanupErrorKind;
};

export type ObservedRootCleanupEmergencyJournalSnapshot = {
  readonly incidents: readonly ObservedRootCleanupEmergencyIncident[];
  /** Number of oldest incidents discarded since the last drain. */
  readonly discardedIncidentCount: number;
};

/**
 * An inspectable, process-owned operational journal. `drain` is intended for
 * an outer operational reporter after its own failure domain has recovered.
 */
export type ObservedRootCleanupEmergencyJournal = {
  snapshot(): ObservedRootCleanupEmergencyJournalSnapshot;
  drain(): ObservedRootCleanupEmergencyJournalSnapshot;
};

/**
 * The final cleanup audit sink is synchronous and intentionally non-throwing.
 * When full, it discards the oldest record so the latest failure remains
 * inspectable. No filesystem or reporting adapter is called from here.
 */
export class InProcessObservedRootCleanupEmergencyJournal
  implements
    ObservedRootCleanupFailureFallback,
    ObservedRootCleanupEmergencyJournal
{
  private incidents: ObservedRootCleanupEmergencyIncident[] = [];
  private discardedIncidentCount = 0;

  reportCleanupReportingFailure(
    input: ObservedRootCleanupReportingFailure,
  ): void {
    try {
      if (
        this.incidents.length >= observedRootCleanupEmergencyJournalCapacity
      ) {
        this.incidents.shift();
        this.discardedIncidentCount += 1;
      }
      this.incidents.push(toEmergencyIncident(input));
    } catch {
      // This is the last independent fallback. It must not control cleanup or
      // public error precedence even if an unexpected runtime defect occurs.
    }
  }

  snapshot(): ObservedRootCleanupEmergencyJournalSnapshot {
    return this.copySnapshot();
  }

  drain(): ObservedRootCleanupEmergencyJournalSnapshot {
    const snapshot = this.copySnapshot();
    this.incidents = [];
    this.discardedIncidentCount = 0;
    return snapshot;
  }

  private copySnapshot(): ObservedRootCleanupEmergencyJournalSnapshot {
    return {
      incidents: this.incidents.map((incident) => ({ ...incident })),
      discardedIncidentCount: this.discardedIncidentCount,
    };
  }
}

function toEmergencyIncident(
  input: ObservedRootCleanupReportingFailure,
): ObservedRootCleanupEmergencyIncident {
  return {
    event: "observed-root-cleanup-reporting-failure",
    operation: input.cleanupFailure.operation,
    cleanup: input.cleanupFailure.cleanup,
    rootId: input.cleanupFailure.rootId,
    relativeScope: input.cleanupFailure.relativeScope,
    cleanupErrorKind: cleanupErrorKind(input.cleanupFailure.error),
    reporterErrorKind: cleanupErrorKind(input.reporterError),
  };
}

function cleanupErrorKind(value: unknown): SanitizedCleanupErrorKind {
  if (value === null) return "null";
  if (value instanceof Error) return "error";
  return typeof value;
}
