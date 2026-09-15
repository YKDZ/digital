import type { MetadataPolicy, SourceAssociation } from "@digital/domain";

export type MetadataPolicyDefinition = Omit<MetadataPolicy, "subjectIds">;

/** 组合层按当前已接受事实选择产品策略；选择结果不是耐久领域事实。 */
export type MetadataPolicyConfiguration = {
  readonly version: string;
  readonly policies: readonly MetadataPolicyDefinition[];
  readonly artifactAssociationRules?: readonly {
    readonly usageContext: string;
    readonly role: string;
    readonly preferredSourceIdentities: readonly string[];
  }[];
  select(accepted: {
    readonly sourceAssociations: readonly SourceAssociation[];
  }): readonly string[];
};
