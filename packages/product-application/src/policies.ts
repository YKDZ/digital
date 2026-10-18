import type {
  AutomatedInformationPlanner,
  CapabilityDeclaration,
  DeclaredCapability,
  InformationRequirement,
  MetadataPolicyConfiguration,
  RecognitionPolicy,
  WorkflowConfigurationCompatibility,
} from "@digital/application";
import type { SourceAssociation } from "@digital/domain";

const trustedRecognitionRules = [
  {
    capabilityId: "dlsite.exact-recognizer",
    capabilityVersion: "1",
    ruleId: "exact-official-product-address",
    ruleVersion: "1",
  },
  {
    capabilityId: "fanbox.creator-date-recognizer",
    capabilityVersion: "2",
    ruleId: "unique-creator-publication-date",
    ruleVersion: "2",
  },
  {
    capabilityId: "bangumi.episodic-recognizer",
    capabilityVersion: "2",
    ruleId: "title-year-season-ordinary-episode",
    ruleVersion: "2",
  },
  {
    capabilityId: "nbinet.exact-isbn-recognizer",
    capabilityVersion: "4",
    ruleId: "embedded-isbn-in-exact-official-record",
    ruleVersion: "4",
  },
  {
    capabilityId: "nbinet.exact-isbn-recognizer",
    capabilityVersion: "4",
    ruleId: "directed-isbn-in-exact-official-record",
    ruleVersion: "1",
  },
  {
    capabilityId: "epub.local-publication-recognizer",
    capabilityVersion: "4",
    ruleId: "epub.valid-single-publication-revision",
    ruleVersion: "4",
  },
  {
    capabilityId: "pdf.local-publication-recognizer",
    capabilityVersion: "3",
    ruleId: "pdf.valid-single-publication-revision",
    ruleVersion: "3",
  },
  {
    capabilityId: "tmdb.strict-film-recognizer",
    capabilityVersion: "2",
    ruleId: "unique-exact-title-year-official-record",
    ruleVersion: "2",
  },
  {
    capabilityId: "tmdb.strict-film-recognizer",
    capabilityVersion: "2",
    ruleId: "exact-directed-official-address",
    ruleVersion: "1",
  },
  {
    capabilityId: "dlsite.local-directory-recognizer",
    capabilityVersion: "1",
    ruleId: "dlsite.exact-local-product-directory",
    ruleVersion: "1",
  },
  {
    capabilityId: "book.local-directory-recognizer",
    capabilityVersion: "2",
    ruleId: "book.same-name-directory-with-valid-publication",
    ruleVersion: "2",
  },
] as const;

/** 首轮扫描前没有已接受主体，采用有限的通用资料需求。 */
export const productGeneralAutomationInformationRequirement: InformationRequirement =
  {
    metadataUsageContext: "asset.ordinary",
    metadata: [
      { property: "asset.title", necessity: "optional" },
      { property: "asset.introduction", necessity: "optional" },
      { property: "asset.summary", necessity: "optional" },
      { property: "asset.body", necessity: "optional" },
      { property: "asset.release-date", necessity: "optional" },
      { property: "asset.publication-datetime", necessity: "optional" },
      { property: "asset.declared-language", necessity: "optional" },
      { property: "asset.content-classification", necessity: "optional" },
    ],
    artifactRoles: [
      { role: "asset.primary-cover", necessity: "optional" },
      { role: "asset.material-image", necessity: "optional" },
    ],
    relationshipTypes: [
      { type: "asset.*", necessity: "optional" },
      { type: "bangumi.subject.related", necessity: "optional" },
    ],
  };

/** 为已接受主体选择类别专用规则时，只读取识别其类别所需的当前事实。 */
export const productRefreshPlanningInformationRequirement: InformationRequirement =
  {
    metadataUsageContext: "asset.ordinary",
    metadata: [
      { property: "book.isbn-13", necessity: "optional" },
      { property: "book.contributor", necessity: "optional" },
      { property: "book.publisher", necessity: "optional" },
      { property: "asset.content-classification", necessity: "optional" },
    ],
    artifactRoles: [],
    relationshipTypes: [],
  };

const bookAutomationInformationRequirement: InformationRequirement = {
  metadataUsageContext: "asset.ordinary",
  metadata: [
    { property: "asset.title", necessity: "required" },
    { property: "book.isbn-13", necessity: "optional" },
    { property: "book.publisher", necessity: "optional" },
    { property: "book.publication-date", necessity: "optional" },
    { property: "asset.declared-language", necessity: "optional" },
    { property: "asset.summary", necessity: "optional" },
  ],
  artifactRoles: [
    { role: "asset.primary-cover", necessity: "optional" },
    { role: "asset.material-image", necessity: "optional" },
  ],
  relationshipTypes: [{ type: "asset.contribution", necessity: "optional" }],
};

const filmAutomationInformationRequirement: InformationRequirement = {
  metadataUsageContext: "asset.ordinary",
  metadata: [
    { property: "asset.title", necessity: "required" },
    { property: "asset.introduction", necessity: "optional" },
    { property: "asset.release-date", necessity: "optional" },
    { property: "asset.runtime-minutes", necessity: "optional" },
    { property: "asset.genre", necessity: "optional" },
    { property: "asset.awards", necessity: "optional" },
    { property: "asset.box-office", necessity: "optional" },
    { property: "rating.*", necessity: "optional" },
  ],
  artifactRoles: [{ role: "asset.primary-cover", necessity: "optional" }],
  relationshipTypes: [{ type: "asset.contribution", necessity: "optional" }],
};

const dlsiteAutomationInformationRequirement: InformationRequirement = {
  metadataUsageContext: "asset.ordinary",
  metadata: [
    { property: "asset.title", necessity: "required" },
    { property: "asset.release-date", necessity: "optional" },
    { property: "asset.introduction", necessity: "optional" },
    { property: "asset.declared-language", necessity: "optional" },
    { property: "asset.content-classification", necessity: "optional" },
    { property: "dlsite.product.price-jpy", necessity: "optional" },
    { property: "dlsite.product.genre", necessity: "optional" },
  ],
  artifactRoles: [
    {
      role: "asset.primary-cover",
      necessity: "optional",
      maximum: 1,
    },
  ],
  relationshipTypes: [
    { type: "asset.contribution", necessity: "optional" },
    { type: "asset.membership", necessity: "optional" },
  ],
};

/** 自动刷新采用的产品信息需求；仅依赖已接受主体的中立事实和产品规则。 */
export const productAutomationInformationPlanner: AutomatedInformationPlanner =
  {
    // 继续沿用部署中冻结的坐标；规则本体与现有资产视图选择范围等价。
    coordinate: "information-planner:asset-view/1",
    requirementForAcceptedSubject(accepted) {
      const sourceIdentities = new Set([
        ...accepted.sourceAssociations.map(
          ({ sourceIdentity }) => sourceIdentity,
        ),
        accepted.recognitionSourceAssociation?.sourceIdentity,
      ]);
      if (sourceIdentities.has("fanbox"))
        return productGeneralAutomationInformationRequirement;
      if (sourceIdentities.has("dlsite"))
        return dlsiteAutomationInformationRequirement;
      if (sourceIdentities.has("tmdb"))
        return filmAutomationInformationRequirement;
      if (sourceIdentities.has("bangumi"))
        return productGeneralAutomationInformationRequirement;
      const subjectDescription = accepted.descriptions.find(
        (description) =>
          description.target.kind === "entity" &&
          description.target.entityId === accepted.id,
      );
      if (
        subjectDescription?.metadata.some(
          (metadata) =>
            metadata.result.status === "resolved" &&
            metadata.result.values.length > 0 &&
            (metadata.property === "book.isbn-13" ||
              metadata.property === "book.contributor" ||
              metadata.property === "book.publisher" ||
              (metadata.property === "asset.content-classification" &&
                metadata.result.values.some(({ value }) => value === "book"))),
        )
      )
        return bookAutomationInformationRequirement;
      return productGeneralAutomationInformationRequirement;
    },
  };

/** 当前产品允许自动接受的初始识别规则；集成不能自行授予信任。 */
export function curatedInitialRecognitionPolicy(): RecognitionPolicy & {
  readonly version: string;
  readonly trustedRuleCoordinates: readonly string[];
} {
  return {
    version: "curated-initial-sources/9",
    trustedRuleCoordinates: trustedRecognitionRules.map(
      (rule) =>
        `${rule.capabilityId}@${rule.capabilityVersion}/${rule.ruleId}@${rule.ruleVersion}`,
    ),
    accepts(result) {
      return trustedRecognitionRules.some(
        (rule) =>
          result.capabilityId === rule.capabilityId &&
          result.capabilityVersion === rule.capabilityVersion &&
          result.ruleId === rule.ruleId &&
          result.ruleVersion === rule.ruleVersion,
      );
    },
  };
}

const ordinaryFilmMetadataPolicyId = "ordinary-film-metadata";
const ordinaryDlsiteMetadataPolicyId = "ordinary-dlsite-metadata";
const ordinaryNbinetMetadataPolicyId = "ordinary-nbinet-metadata";

/** 当前产品在普通浏览语境采用的来源优先级。 */
export class CuratedMetadataPolicyConfiguration implements MetadataPolicyConfiguration {
  readonly version = "curated-metadata/5";
  readonly policies = [
    {
      id: ordinaryFilmMetadataPolicyId,
      metadataUsageContext: "asset.ordinary",
      rules: [
        ...[
          "asset.title",
          "asset.title.original",
          "asset.introduction",
          "asset.release-date",
          "asset.runtime-minutes",
          "external.imdb-id",
        ].map((property) => ({
          property,
          preferredSourceIdentities: ["tmdb", "omdb"],
          cardinality: "one" as const,
        })),
        {
          property: "asset.title.alternative",
          preferredSourceIdentities: ["tmdb", "omdb"],
          cardinality: "many" as const,
        },
        {
          property: "asset.genre",
          preferredSourceIdentities: ["tmdb", "omdb"],
          cardinality: "many" as const,
        },
        ...["asset.awards", "asset.box-office"].map((property) => ({
          property,
          preferredSourceIdentities: ["omdb"],
          cardinality: "one" as const,
        })),
        {
          property: "rating.*",
          preferredSourceIdentities: ["omdb"],
          cardinality: "many" as const,
        },
      ],
    },
    {
      id: ordinaryDlsiteMetadataPolicyId,
      metadataUsageContext: "asset.ordinary",
      rules: [
        ...[
          "asset.title",
          "asset.release-date",
          "asset.content-classification",
          "asset.introduction",
          "dlsite.product.price-jpy",
        ].map((property) => ({
          property,
          preferredSourceIdentities: ["dlsite", "local-observed"],
          cardinality: "one" as const,
        })),
        {
          property: "asset.declared-language",
          preferredSourceIdentities: ["dlsite", "local-observed"],
          cardinality: "many" as const,
        },
        {
          property: "dlsite.product.genre",
          preferredSourceIdentities: ["dlsite"],
          cardinality: "many" as const,
        },
      ],
    },
    {
      id: ordinaryNbinetMetadataPolicyId,
      metadataUsageContext: "asset.ordinary",
      rules: [
        {
          property: "book.isbn-13",
          preferredSourceIdentities: [
            "nbinet",
            "kadokawa-jp",
            "taiwan-kadokawa",
            "local-observed",
          ],
          cardinality: "one" as const,
        },
        ...[
          "asset.title",
          "book.publisher",
          "book.publication-date",
          "asset.declared-language",
        ].map((property) => ({
          property,
          preferredSourceIdentities: [
            "nbinet",
            "kadokawa-jp",
            "taiwan-kadokawa",
            "local-observed",
          ],
          cardinality: "one" as const,
        })),
        {
          property: "book.contributor",
          preferredSourceIdentities: [
            "nbinet",
            "kadokawa-jp",
            "taiwan-kadokawa",
            "local-observed",
          ],
          cardinality: "many" as const,
        },
      ],
    },
  ];
  readonly artifactAssociationRules = [
    {
      usageContext: "asset.ordinary",
      role: "asset.primary-cover",
      preferredSourceIdentities: ["dlsite"],
      preferredCapabilityIds: ["book.same-name-directory"],
    },
  ];

  select(accepted: {
    readonly sourceAssociations: readonly SourceAssociation[];
  }): readonly string[] {
    const sources = new Set(
      accepted.sourceAssociations.map(({ sourceIdentity }) => sourceIdentity),
    );
    return [
      ...(sources.has("tmdb") ? [ordinaryFilmMetadataPolicyId] : []),
      ...(sources.has("dlsite") ? [ordinaryDlsiteMetadataPolicyId] : []),
      ...(sources.has("nbinet") ||
      sources.has("kadokawa-jp") ||
      sources.has("taiwan-kadokawa")
        ? [ordinaryNbinetMetadataPolicyId]
        : []),
    ];
  }
}

/** 产品登记的静态配置与来源连接版本共同判断冻结执行能否继续。 */
export class RegisteredWorkflowConfigurationCompatibility implements WorkflowConfigurationCompatibility {
  readonly #registered: ReadonlySet<string>;
  readonly #sourceConnections:
    | { isConfigurationReferenceCurrent(reference: string): boolean }
    | undefined;

  constructor(
    references: readonly string[],
    sourceConnections?: {
      isConfigurationReferenceCurrent(reference: string): boolean;
    },
  ) {
    this.#registered = new Set(references);
    this.#sourceConnections = sourceConnections;
  }

  async checkCompatibility(input: {
    readonly references: readonly string[];
  }): Promise<
    | { readonly compatible: true }
    | { readonly compatible: false; readonly reason: string }
  > {
    return input.references.every(
      (reference) =>
        this.#registered.has(reference) ||
        this.#sourceConnections?.isConfigurationReferenceCurrent(reference) ===
          true,
    )
      ? { compatible: true }
      : {
          compatible: false,
          reason: "冻结配置引用当前不可用或版本已变更",
        };
  }
}

/** 在创建进程资源前验证当前产品声明的能力坐标。 */
export function validateCapabilityDeclarations(
  declarations: readonly Partial<DeclaredCapability>[],
): readonly CapabilityDeclaration[] {
  const identities = new Set<string>();
  return declarations.map((declaration) => {
    if (!nonEmpty(declaration.identity))
      throw new Error("Capability declaration requires a stable identity");
    if (!nonEmpty(declaration.implementationVersion))
      throw new Error(
        `Capability declaration ${declaration.identity} requires an implementation version`,
      );
    if (!nonEmpty(declaration.kind))
      throw new Error(
        `Capability declaration ${declaration.identity} requires a capability kind`,
      );
    if (!Array.isArray(declaration.interpretationContractVersions))
      throw new Error(
        `Capability declaration ${declaration.identity} requires interpretation contract versions`,
      );
    if (identities.has(declaration.identity))
      throw new Error(
        `Capability declaration has duplicate stable identity ${declaration.identity}`,
      );
    const contractVersions = new Set<string>();
    for (const version of declaration.interpretationContractVersions) {
      if (!nonEmpty(version) || contractVersions.has(version))
        throw new Error(
          `Capability declaration ${declaration.identity} has invalid interpretation contract versions`,
        );
      contractVersions.add(version);
    }
    if (
      declaration.capabilityId !== undefined &&
      declaration.capabilityId !== declaration.identity
    ) {
      throw new Error(
        `Capability declaration ${declaration.identity} has an incompatible stable identity coordinate`,
      );
    }
    if (
      declaration.capabilityVersion !== undefined &&
      declaration.capabilityVersion !== declaration.implementationVersion
    ) {
      throw new Error(
        `Capability declaration ${declaration.identity} has an incompatible implementation version coordinate`,
      );
    }
    if (!nonEmpty(declaration.contractVersion)) {
      throw new Error(
        `Capability declaration ${declaration.identity} requires a selected interpretation contract`,
      );
    }
    if (!contractVersions.has(declaration.contractVersion)) {
      throw new Error(
        `Capability declaration ${declaration.identity} has an incompatible interpretation contract`,
      );
    }
    identities.add(declaration.identity);
    return {
      identity: declaration.identity,
      implementationVersion: declaration.implementationVersion,
      kind: declaration.kind,
      interpretationContractVersions:
        declaration.interpretationContractVersions,
    };
  });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
