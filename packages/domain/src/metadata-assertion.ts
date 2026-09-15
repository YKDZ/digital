import type { CapabilityCoordinate } from "./index.ts";

/** 描述性事实明确指向实体，或一个已经物化的精确产物修订版。 */
export type DescriptionTarget =
  | { readonly kind: "entity"; readonly entityId: string }
  | {
      readonly kind: "artifact-revision";
      readonly artifactId: string;
      readonly revisionId: string;
    };

type MetadataAssertionFields = {
  readonly property: string;
  /** 稳定来源契约槽位；仅属性相等绝不隐含 lineage。 */
  readonly sourceSlot: string;
  readonly value: string;
  readonly sourceRecordIds: readonly string[];
  /** 保留判断的发起方式与提案引用；不将交互入口伪装成用户账户身份。 */
  readonly authoredBy?: {
    readonly initiatedBy: string;
    readonly proposalId: string;
  };
  /** 建立该断言的解释器坐标。 */
  readonly producer?: CapabilityCoordinate;
  /** 由来源契约定义的开放语义，例如评分单位和量表。 */
  readonly qualifiers?: readonly {
    readonly key: string;
    readonly value: string;
  }[];
  /**
   * 从容器派生的事实保留提供它们的精确观察修订和条目。不能仅因某外部来源记录建立了
   * 识别，就刻意把这些事实归因于该记录。
   */
  readonly observedArtifactPart?: {
    readonly artifactId: string;
    readonly revisionId: string;
    readonly locator: string;
  };
};

/** 来源解释阶段尚未分配接受实体，因此只允许指向同批次的来源实体。 */
export type MetadataAssertionCandidate = MetadataAssertionFields & {
  readonly subjectId?: string;
};

/** 已接受和持久化的元数据断言；描述目标不可省略。 */
export type MetadataAssertion = MetadataAssertionFields & {
  readonly target: DescriptionTarget;
  /** 本地事实提升到实体目标时，保留证明代表关系的识别决定。 */
  readonly recognitionDecisionId?: string;
};
