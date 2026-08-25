import type {
  ObservedRootCleanupFailureFallback,
  ObservedRootCleanupReportingFailure,
} from "@digital/application";

/**
 * 进程只保留最新事件。清理报告失败是异常运维证据，而非持久工作流记录，
 * 因此有界应急日志绝不能与目录可用性争夺资源。
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
 * 进程本地记录刻意只保存逻辑注册坐标和值种类。它绝不保留原始适配器错误、路径、
 * 描述符状态或含凭据文本。
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
  /** 自上次排空后丢弃的最旧事件数量。 */
  readonly discardedIncidentCount: number;
};

/**
 * 可检查且由进程拥有的运维日志。`drain` 供外层运维报告器在自身故障域恢复后调用。
 */
export type ObservedRootCleanupEmergencyJournal = {
  snapshot(): ObservedRootCleanupEmergencyJournalSnapshot;
  drain(): ObservedRootCleanupEmergencyJournalSnapshot;
};

/**
 * 最终清理审计槽是同步的，并刻意保证不抛错。容量满时会丢弃最旧记录，
 * 使最新失败仍可检查。此处不会调用文件系统或报告适配器。
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
      // 这是最后一个独立后备。即使发生意外运行时缺陷，它也不得控制清理或公开错误优先级。
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
