import type { CapabilityCoordinate } from "./index.ts";

export type MetadataAssertion = {
  /**
   * 本断言描述的同一提议中，一个由来源解析的实体。省略时刻意表示已接受数字资产。
   */
  readonly subjectId?: string;
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
