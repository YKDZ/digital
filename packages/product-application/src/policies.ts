import type {
  CapabilityDeclaration,
  DeclaredCapability,
  MetadataPolicyConfiguration,
  RecognitionPolicy,
  WorkflowConfigurationCompatibility,
} from "@digital/application";
import type { AcceptedRecognition } from "@digital/domain";

const trustedRecognitionRules = [
  {
    capabilityId: "dlsite.exact-recognizer",
    capabilityVersion: "1",
    ruleId: "exact-official-product-address",
    ruleVersion: "1",
  },
  {
    capabilityId: "fanbox.creator-date-recognizer",
    capabilityVersion: "1",
    ruleId: "unique-creator-publication-date",
    ruleVersion: "1",
  },
  {
    capabilityId: "bangumi.episodic-recognizer",
    capabilityVersion: "1",
    ruleId: "title-year-season-ordinary-episode",
    ruleVersion: "1",
  },
  {
    capabilityId: "nbinet.exact-isbn-recognizer",
    capabilityVersion: "2",
    ruleId: "embedded-isbn-in-exact-official-record",
    ruleVersion: "2",
  },
  {
    capabilityId: "nbinet.exact-isbn-recognizer",
    capabilityVersion: "2",
    ruleId: "directed-isbn-in-exact-official-record",
    ruleVersion: "1",
  },
  {
    capabilityId: "epub.local-publication-recognizer",
    capabilityVersion: "2",
    ruleId: "epub.valid-single-publication-revision",
    ruleVersion: "2",
  },
  {
    capabilityId: "pdf.local-publication-recognizer",
    capabilityVersion: "2",
    ruleId: "pdf.valid-single-publication-revision",
    ruleVersion: "2",
  },
  {
    capabilityId: "tmdb.strict-film-recognizer",
    capabilityVersion: "1",
    ruleId: "unique-exact-title-year-official-record",
    ruleVersion: "1",
  },
  {
    capabilityId: "tmdb.strict-film-recognizer",
    capabilityVersion: "1",
    ruleId: "exact-directed-official-address",
    ruleVersion: "1",
  },
] as const;

const trustedTmdbRules = trustedRecognitionRules.filter(
  (rule) => rule.capabilityId === "tmdb.strict-film-recognizer",
);

/** 当前产品允许自动接受的初始识别规则；集成不能自行授予信任。 */
export function curatedInitialRecognitionPolicy(): RecognitionPolicy & {
  readonly version: string;
  readonly trustedRuleCoordinates: readonly string[];
} {
  return {
    version: "curated-initial-sources/7",
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
const ordinaryManualMetadataPolicyId = "ordinary-manual-metadata";

/** 当前产品在普通浏览语境采用的来源优先级。 */
export class CuratedMetadataPolicyConfiguration implements MetadataPolicyConfiguration {
  readonly version = "curated-metadata/3";
  readonly policies = [
    {
      id: ordinaryManualMetadataPolicyId,
      metadataUsageContext: "asset.ordinary",
      rules: ["asset.title", "asset.content-classification"].map(
        (property) => ({
          property,
          preferredSourceIdentities: ["user"],
          cardinality: "one" as const,
        }),
      ),
    },
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
  ];

  enroll(accepted: AcceptedRecognition): readonly string[] {
    if (accepted.proposal.basis.kind === "manual-boundary")
      return [ordinaryManualMetadataPolicyId];
    const acceptedTmdbFilmRule =
      accepted.recognitionDecision.acceptedRuleResults.some((result) =>
        trustedTmdbRules.some(
          (trusted) =>
            result.outcome === "satisfied" &&
            result.capabilityId === trusted.capabilityId &&
            result.capabilityVersion === trusted.capabilityVersion &&
            result.ruleId === trusted.ruleId &&
            result.ruleVersion === trusted.ruleVersion,
        ),
      );
    return acceptedTmdbFilmRule ? [ordinaryFilmMetadataPolicyId] : [];
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
