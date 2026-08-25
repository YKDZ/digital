import type { AcceptedRecognition, MetadataPolicy } from "@digital/domain";

export type MetadataPolicyDefinition = Omit<MetadataPolicy, "subjectIds">;

/**
 * 组合层提供定义，以及从已接受解释到明确策略登记的产品映射。Application 只协调并
 * 持久化这些不透明标识符。
 */
export type MetadataPolicyConfiguration = {
  readonly version: string;
  readonly policies: readonly MetadataPolicyDefinition[];
  enroll(accepted: AcceptedRecognition): readonly string[];
};
