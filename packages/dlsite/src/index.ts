import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  type DirectoryInterpreter,
  type FilesystemPackageSnapshot,
  type InformationFulfillmentCapability,
  type Recognizer,
  type RecognitionCandidateContext,
  type SourceArtifactAcquirer,
  type SourceCollectionResult,
  type SourceCollectionFailure,
  type SourceCollector,
  type SourceInterpreter,
  type StagedSourceArtifact,
} from "@digital/application";
import type {
  RecognitionEvidence,
  RecognitionProposalDraft,
  SourceArtifactCandidate,
  SourcedEntity,
  ProposedEntityRelationship,
  SourceInterpretationBatch,
  SourceRecord,
  EntityMention,
  EntityResolutionDecision,
} from "@digital/domain";

const exactProductId = /^(?:RJ\d{8}|VJ\d{6})$/u;
const maximumResponseBytes = 2 * 1024 * 1024;

const directoryCapability = declareCapability({
  identity: "dlsite.exact-directory",
  implementationVersion: "1",
  kind: "directory-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const collectorCapability = declareCapability({
  identity: "dlsite.official-collection",
  implementationVersion: "2",
  kind: "source-collector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const interpreterCapability = declareCapability({
  identity: "dlsite.product-interpretation",
  implementationVersion: "1",
  kind: "source-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const recognizerCapability = declareCapability({
  identity: "dlsite.exact-recognizer",
  implementationVersion: "1",
  kind: "recognizer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const acquirerCapability = declareCapability({
  identity: "dlsite.source-artifact-acquirer",
  implementationVersion: "2",
  kind: "source-artifact-acquirer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

/**
 * 适配器向应用层描述其开放事实坐标，但不让应用层了解 DLsite 视图或载荷。
 * 采集与解释共同构成低成本来源刷新路径；只有需求点名其角色时，才考虑独立获取器。
 */
export const dlsiteInformationFulfillmentCapabilities = [
  {
    declaration: collectorCapability,
    operation: "source-refresh",
    sourceIdentities: ["dlsite"],
    metadataProperties: [
      "asset.title",
      "asset.release-date",
      "asset.content-classification",
      "asset.declared-language",
      "dlsite.product.price-jpy",
      "asset.introduction",
      "asset.series-position",
    ],
    relationshipTypes: ["asset.contribution", "asset.membership"],
    cost: "low",
    availability: "available",
  },
  {
    declaration: acquirerCapability,
    operation: "source-artifact-acquisition",
    sourceIdentities: ["dlsite"],
    artifactRoles: ["asset.primary-cover"],
    cost: "low",
    availability: "available",
  },
] as const satisfies readonly InformationFulfillmentCapability[];

export const trustedDlsiteExactRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "exact-official-product-address",
  ruleVersion: "1",
} as const;

export class DlsiteExactDirectoryInterpreter implements DirectoryInterpreter {
  readonly capability = directoryCapability;

  interpret(
    snapshot: FilesystemPackageSnapshot,
  ): readonly RecognitionEvidence[] {
    const basename = snapshot.root.split(/[\\/]/u).at(-1) ?? "";
    if (!exactProductId.test(basename)) return [];
    return [
      {
        kind: "source-address",
        sourceIdentity: "dlsite",
        sourceAddress: canonicalProductAddress(basename),
        explanation: "DLsite 精确目录规则匹配",
        producer: this.capability,
      },
    ];
  }
}

type FetchLike = (input: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
type WaitLike = (milliseconds: number) => Promise<void>;

const retryDelaysMilliseconds = [250, 1_000] as const;

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 官方读取都是幂等 GET。能力仅重试传输错误、限流和服务端错误；确定性的
 * 客户端拒绝直接返回给调用者，最后一次瞬态失败也保持原始诊断。
 */
async function requestOfficialSource(
  request: FetchLike,
  delay: WaitLike,
  address: string,
): Promise<Awaited<ReturnType<FetchLike>>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await request(address);
      if (
        response.ok ||
        !retryableStatus(response.status) ||
        attempt === retryDelaysMilliseconds.length
      )
        return response;
    } catch (error) {
      if (attempt === retryDelaysMilliseconds.length) throw error;
    }
    await delay(retryDelaysMilliseconds[attempt]!);
  }
}

export class DlsiteCollector implements SourceCollector {
  readonly capability = collectorCapability;
  private readonly request: FetchLike;
  private readonly delay: WaitLike;

  constructor(request: FetchLike = fetch, delay: WaitLike = wait) {
    this.request = request;
    this.delay = delay;
  }

  canCollect(evidence: RecognitionEvidence): boolean {
    return (
      evidence.sourceIdentity === "dlsite" &&
      (evidence.producer.capabilityId === directoryCapability.capabilityId ||
        (evidence.kind === "source-association" &&
          evidence.sourceIdentity === "dlsite") ||
        (evidence.kind === "directed-source-address" &&
          evidence.sourceIdentity === "dlsite")) &&
      evidence.sourceAddress !== undefined
    );
  }

  coverageScopeIds(evidence: RecognitionEvidence): readonly string[] {
    return this.canCollect(evidence)
      ? ["dlsite.product-json", "dlsite.product-html"]
      : [];
  }

  async collect(
    evidence: RecognitionEvidence,
  ): Promise<SourceCollectionResult> {
    if (!this.canCollect(evidence)) {
      return {
        records: [],
        failures: [
          {
            capability: this.capability,
            reason:
              "DLsite collection requires DLsite evidence with an exact source address",
          },
        ],
      };
    }
    let nativeAddress: string;
    let productId: string;
    try {
      nativeAddress = canonicalDirectedProductAddress(evidence.sourceAddress!);
      productId = productIdFromAddress(nativeAddress);
    } catch (error) {
      // 验证刻意发生在构造任何请求之前，更不用说发出请求。定向地址是不可信用户输入，
      // 不是端点。
      return {
        records: [],
        failures: [
          { capability: this.capability, reason: errorMessage(error) },
        ],
      };
    }
    const jsonOutcome = await Promise.allSettled([
      this.capture({
        requestedAddress: `https://www.dlsite.com/maniax/product/info/ajax?product_id=${productId}`,
        nativeAddress,
        coverage: "dlsite.product-json",
      }),
    ]);
    let officialAddress = nativeAddress;
    const contractFailures: SourceCollectionFailure[] = [];
    if (jsonOutcome[0]?.status === "fulfilled") {
      try {
        officialAddress =
          productAddressFromJson(productId, jsonOutcome[0].value.body) ??
          officialAddress;
      } catch (error) {
        contractFailures.push({
          capability: this.capability,
          reason: errorMessage(error),
        });
      }
    }
    const htmlOutcome = await Promise.allSettled([
      this.capture({
        requestedAddress: officialAddress,
        nativeAddress: officialAddress,
        coverage: "dlsite.product-html",
      }),
    ]);
    const outcomes = [...jsonOutcome, ...htmlOutcome];
    const records: SourceRecord[] = [];
    const failures: SourceCollectionFailure[] = [...contractFailures];
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled")
        records.push({ ...outcome.value, nativeAddress: officialAddress });
      else
        failures.push({
          capability: this.capability,
          reason: errorMessage(outcome.reason),
        });
    }
    return { records, failures };
  }

  private async capture(input: {
    readonly requestedAddress: string;
    readonly nativeAddress: string;
    readonly coverage: "dlsite.product-json" | "dlsite.product-html";
  }): Promise<SourceRecord> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await requestOfficialSource(
        this.request,
        this.delay,
        input.requestedAddress,
      );
    } catch (error) {
      throw new Error(
        `DLsite official source request failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(
        `DLsite official source request failed: HTTP ${response.status}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumResponseBytes) {
      throw new Error("DLsite official source response exceeded capture limit");
    }
    return {
      id: `source-record_${randomUUID()}`,
      sourceIdentity: "dlsite",
      nativeAddress: input.nativeAddress,
      mediaType:
        response.headers.get("content-type") ?? "application/octet-stream",
      acquiredAt: new Date().toISOString(),
      acquisition: {
        requestedAddress: input.requestedAddress,
        method: "GET",
        authorized: false,
      },
      coverage: {
        id: input.coverage,
        completeness: "complete",
        authority: "official",
      },
      digest: createHash("sha256").update(bytes).digest("hex"),
      body: new TextDecoder().decode(bytes),
    };
  }
}

type ProductInfo = {
  readonly work_name?: unknown;
  readonly regist_date?: unknown;
  readonly work_image?: unknown;
  readonly age_category?: unknown;
  readonly maker_id?: unknown;
  readonly maker_name?: unknown;
  readonly maker_name_en?: unknown;
  readonly work_lang?: unknown;
  readonly work_lang_name?: unknown;
  readonly language?: unknown;
  readonly price?: unknown;
  readonly price_str?: unknown;
  readonly voice?: unknown;
  readonly scenario?: unknown;
  readonly illustration?: unknown;
  readonly author?: unknown;
  readonly options?: unknown;
  readonly title_id?: unknown;
  readonly title_name?: unknown;
  readonly title_volumn?: unknown;
  readonly translation_info?: unknown;
};

export class DlsiteSourceInterpreter implements SourceInterpreter {
  readonly capability = interpreterCapability;

  canInterpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): boolean {
    return (
      input.evidence.some(
        (evidence) =>
          (evidence.sourceIdentity === "dlsite" &&
            evidence.producer.capabilityId ===
              directoryCapability.capabilityId) ||
          (evidence.kind === "source-association" &&
            evidence.sourceIdentity === "dlsite") ||
          (evidence.kind === "directed-source-address" &&
            evidence.sourceIdentity === "dlsite"),
      ) &&
      input.sourceRecords.every(
        (record) => record.sourceIdentity === "dlsite",
      ) &&
      input.sourceRecords.some(
        (record) => record.coverage.id === "dlsite.product-json",
      ) &&
      input.sourceRecords.some(
        (record) => record.coverage.id === "dlsite.product-html",
      )
    );
  }

  interpret(input: {
    readonly evidence: readonly RecognitionEvidence[];
    readonly sourceRecords: readonly SourceRecord[];
  }): SourceInterpretationBatch {
    const sourceAddress = input.sourceRecords[0]?.nativeAddress;
    if (
      sourceAddress === undefined ||
      input.sourceRecords.some(
        (record) => record.nativeAddress !== sourceAddress,
      )
    )
      throw new Error("Missing exact DLsite evidence");
    const json = input.sourceRecords.find(
      (record) => record.coverage.id === "dlsite.product-json",
    );
    const html = input.sourceRecords.find(
      (record) => record.coverage.id === "dlsite.product-html",
    );
    if (json === undefined || html === undefined) {
      throw new Error(
        "DLsite interpretation requires independent JSON and HTML records",
      );
    }
    const productId = productIdFromAddress(sourceAddress);
    const parsed = JSON.parse(json.body) as Record<string, ProductInfo>;
    const jsonProduct = parsed[productId];
    const product = jsonProduct ?? productInfoFromHtml(productId, html.body);
    if (product === undefined)
      throw new Error(
        "DLsite official records did not contain the requested product",
      );
    const productRecordId = jsonProduct === undefined ? html.id : json.id;
    const title = requiredString(product.work_name, "DLsite work name");
    const metadata = [
      {
        property: "asset.title",
        sourceSlot: "dlsite.product.title",
        value: title,
        sourceRecordIds: [productRecordId],
      },
      {
        property: "asset.release-date",
        sourceSlot: "dlsite.product.release-date",
        value: requiredString(product.regist_date, "DLsite release date"),
        sourceRecordIds: [productRecordId],
      },
    ];
    const classification = stringValue(product.age_category);
    if (classification.length > 0) {
      metadata.push({
        property: "asset.content-classification",
        sourceSlot: "dlsite.product.content-classification",
        value: classification,
        sourceRecordIds: [productRecordId],
      });
    }
    const explicitLanguage = firstString(
      product.work_lang_name,
      product.work_lang,
      product.language,
    );
    const languages =
      explicitLanguage === undefined
        ? declaredLanguages(product.options)
        : [explicitLanguage];
    for (const language of languages) {
      metadata.push({
        property: "asset.declared-language",
        sourceSlot: `dlsite.product.declared-language:${language}`,
        value: language,
        sourceRecordIds: [productRecordId],
      });
    }
    const price = jpyPrice(product.price);
    if (price !== undefined) {
      metadata.push({
        property: "dlsite.product.price-jpy",
        sourceSlot: "dlsite.product.price",
        value: price,
        sourceRecordIds: [productRecordId],
      });
    }
    const introduction = officialIntroduction(html.body);
    if (introduction !== undefined) {
      metadata.push({
        property: "asset.introduction",
        sourceSlot: "dlsite.product.introduction",
        value: introduction,
        sourceRecordIds: [html.id],
      });
    }
    const explicitImage = explicitMainImage(product.work_image);
    const carouselImage =
      explicitImage === undefined ? carouselFirstImage(html.body) : undefined;
    const image = explicitImage ?? carouselImage;
    /**
     * 封面选择属于来源解释策略：显式官方主图优先，首张官方轮播图只作为后备。
     * 缺失也是有效来源证据，不是识别失败；由应用层决定消费者需求是否需要该角色。
     */
    const sourceArtifacts: SourceArtifactCandidate[] =
      image === undefined
        ? []
        : [
            {
              id: `source-artifact-candidate_${randomUUID()}`,
              sourceRecordId:
                explicitImage === undefined ? html.id : productRecordId,
              role: "asset.primary-cover",
              acquisitionReference: absoluteHttps(image),
              mediaType: mediaTypeForImage(image),
            },
          ];
    const entities: SourcedEntity[] = [];
    const entityMentions: EntityMention[] = [];
    const entityResolutionDecisions: EntityResolutionDecision[] = [];
    const relationships: ProposedEntityRelationship[] = [];
    const byExactNamespace = new Map<string, SourcedEntity>();
    const relationshipOccurrences = new Map<string, number>();
    const mention = (i: {
      readonly field: string;
      readonly role: string;
      readonly kind: "entity" | "persona";
      readonly value: string;
      readonly sourceKey?: string;
      readonly sourceRecordId: string;
      readonly namespace: string;
    }): SourcedEntity => {
      const sourceKey = i.sourceKey ?? i.value;
      const exactKey = `${i.namespace}\u0000${sourceKey}`;
      let entity = byExactNamespace.get(exactKey);
      if (entity === undefined) {
        entity = {
          id: sourcedEntityId(i.namespace, sourceKey),
          kind: i.kind,
          sourceIdentity: "dlsite",
          sourceKey,
          identityNamespace: i.namespace,
          label: i.value,
          sourceRecordIds: [i.sourceRecordId],
        };
        byExactNamespace.set(exactKey, entity);
        entities.push(entity);
      }
      const occurrence: EntityMention = {
        id: `entity-mention_${randomUUID()}`,
        sourceRecordIds: [i.sourceRecordId],
        sourceIdentity: "dlsite",
        field: i.field,
        role: i.role,
        label: i.value,
        identityNamespace: i.namespace,
        sourceKey,
      };
      entityMentions.push(occurrence);
      entityResolutionDecisions.push({
        id: `entity-resolution_${randomUUID()}`,
        mentionId: occurrence.id,
        entityId: entity.id,
        rule: "source-field-role-exact",
        sourceRecordIds: [i.sourceRecordId],
      });
      const occurrenceIndex =
        (relationshipOccurrences.get(i.namespace) ?? 0) + 1;
      relationshipOccurrences.set(i.namespace, occurrenceIndex);
      relationships.push({
        participantId: entity.id,
        participantMentionIds: [occurrence.id],
        type: "asset.contribution",
        role: i.role,
        sourceSlot: `${i.namespace}:${sourceKey}:${occurrenceIndex}`,
        sourceRecordIds: [i.sourceRecordId],
      });
      return entity;
    };
    const makerId = stringValue(product.maker_id);
    const makerNameFromJson = firstString(
      product.maker_name,
      product.maker_name_en,
    );
    const makerName =
      makerNameFromJson ?? circleNameFromHtml(html.body, makerId);
    if (makerId.length > 0 && makerName !== undefined) {
      mention({
        field: "maker",
        role: "circle",
        kind: "entity",
        value: makerName,
        sourceKey: makerId,
        sourceRecordId:
          makerNameFromJson === undefined ? html.id : productRecordId,
        namespace: "dlsite.circle",
      });
    }
    const seriesId = stringValue(product.title_id);
    const seriesName = firstString(product.title_name);
    if (seriesId.length > 0 && seriesName !== undefined) {
      const series: SourcedEntity = {
        id: sourcedEntityId("dlsite.series", seriesId),
        kind: "entity",
        sourceIdentity: "dlsite",
        sourceKey: seriesId,
        identityNamespace: "dlsite.series",
        label: seriesName,
        sourceRecordIds: [productRecordId],
      };
      entities.push(series);
      relationships.push({
        participantId: series.id,
        type: "asset.membership",
        role: "dlsite.series.member",
        sourceSlot: `dlsite.series.member:${seriesId}`,
        sourceRecordIds: [productRecordId],
      });
      const volume = firstString(product.title_volumn);
      if (volume !== undefined) {
        metadata.push({
          property: "asset.series-position",
          sourceSlot: `dlsite.series.position:${seriesId}`,
          value: volume,
          sourceRecordIds: [productRecordId],
        });
      }
    }
    for (const [field, role, htmlLabel] of [
      ["voice", "voice", "声優"],
      ["scenario", "scenario", "シナリオ"],
      ["illustration", "illustration", "イラスト"],
      ["author", "author", "作者"],
    ] as const) {
      const jsonCredits = creditedNames(product[field]);
      const credits =
        jsonCredits.length > 0
          ? jsonCredits
          : creditedNamesFromHtml(html.body, htmlLabel);
      for (const credit of credits) {
        mention({
          field,
          role,
          kind: "persona",
          value: credit,
          sourceRecordId: jsonCredits.length > 0 ? productRecordId : html.id,
          namespace: `dlsite.credit.${field}.${role}`,
        });
      }
    }
    return {
      id: `source-interpretation_${randomUUID()}`,
      producer: this.capability,
      sourceRecordIds: [json.id, html.id],
      sourceIdentity: "dlsite",
      sourceAddress,
      metadata,
      sourceArtifacts,
      entities,
      entityMentions,
      entityResolutionDecisions,
      relationships,
    };
  }
}

/** 识别器只发出通用提案和带版本的规则结果。 */
export class DlsiteExactRecognizer implements Recognizer {
  readonly capability = recognizerCapability;

  canRecognize(input: RecognitionCandidateContext): boolean {
    if (input.basis.kind !== "source-interpretation") return false;
    const interpretation = input.basis.interpretation;
    return (
      interpretation.sourceIdentity === "dlsite" &&
      interpretation.producer.capabilityId ===
        interpreterCapability.capabilityId
    );
  }

  recognize(input: RecognitionCandidateContext): RecognitionProposalDraft {
    if (input.basis.kind !== "source-interpretation")
      throw new Error("DLsite recognizer requires source interpretation");
    const interpretation = input.basis.interpretation;
    const directed = input.evidence.some((evidence) => {
      if (
        evidence.kind !== "directed-source-address" ||
        evidence.sourceIdentity !== "dlsite" ||
        evidence.sourceAddress === undefined
      )
        return false;
      try {
        return (
          canonicalDirectedProductAddress(evidence.sourceAddress) ===
          interpretation.sourceAddress
        );
      } catch {
        return false;
      }
    });
    const directory = input.evidence.some(
      (evidence) =>
        evidence.sourceIdentity === "dlsite" &&
        evidence.producer.capabilityId === directoryCapability.capabilityId &&
        evidence.sourceAddress !== undefined &&
        productIdFromAddress(evidence.sourceAddress) ===
          productIdFromAddress(interpretation.sourceAddress),
    );
    const satisfied = directed || directory;
    return {
      id: `recognition-proposal_${randomUUID()}`,
      ruleResults: [
        {
          ...trustedDlsiteExactRule,
          outcome: satisfied ? "satisfied" : "contradicted",
          explanation: directed
            ? "用户指定的精确 DLsite 来源地址与官方记录一致"
            : "目录中的精确来源地址与官方记录一致",
          evidence: input.evidence,
        },
      ],
    };
  }
}

export class DlsiteArtifactAcquirer implements SourceArtifactAcquirer {
  readonly capability = acquirerCapability;
  private readonly request: FetchLike;
  private readonly delay: WaitLike;

  constructor(request: FetchLike = fetch, delay: WaitLike = wait) {
    this.request = request;
    this.delay = delay;
  }

  canAcquire(candidate: SourceArtifactCandidate): boolean {
    return candidate.acquisitionReference.startsWith("https://img.dlsite.jp/");
  }

  async acquire(
    candidate: SourceArtifactCandidate,
  ): Promise<StagedSourceArtifact> {
    const target = new URL(candidate.acquisitionReference);
    if (target.protocol !== "https:" || target.hostname !== "img.dlsite.jp") {
      throw new Error(
        "DLsite cover candidate must use the official HTTPS image host",
      );
    }
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await requestOfficialSource(
        this.request,
        this.delay,
        candidate.acquisitionReference,
      );
    } catch (error) {
      throw new Error(`DLsite cover request failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (!response.ok)
      throw new Error(`DLsite cover request failed: HTTP ${response.status}`);
    const mediaType = response.headers.get("content-type") ?? "";
    if (mediaTypeEssence(mediaType) !== mediaTypeEssence(candidate.mediaType)) {
      throw new Error(
        "DLsite cover response content type differs from the selected candidate",
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumResponseBytes) {
      throw new Error("DLsite cover did not meet the capture limits");
    }
    return {
      candidateId: candidate.id,
      sourceRecordId: candidate.sourceRecordId,
      bytes,
      mediaType,
    };
  }
}

function canonicalProductAddress(
  productId: string,
  section = "maniax",
): string {
  return `https://www.dlsite.com/${section}/work/=/product_id/${productId}.html`;
}

/**
 * DLsite 拥有手动定向来源地址的语法。该语法刻意比 URL 解析更窄：只有规范公开产品页
 * 才是来源原生地址；重定向、Ajax 端点、外部主机、HTTP URL、凭据、片段或带查询的 URL
 * 均不是。
 */
function canonicalDirectedProductAddress(input: string): string {
  let address: URL;
  try {
    address = new URL(input);
  } catch {
    throw new Error("DLsite requires an official HTTPS product address");
  }
  if (
    address.protocol !== "https:" ||
    address.hostname !== "www.dlsite.com" ||
    address.port !== "" ||
    address.username !== "" ||
    address.password !== "" ||
    address.search !== "" ||
    address.hash !== ""
  ) {
    throw new Error("DLsite requires an official HTTPS product address");
  }
  const match =
    /^\/(maniax|girls|soft|pro|books|comics|appx|home|eng)\/work\/=\/product_id\/(RJ(\d{8})|VJ(\d{6}))\.html$/iu.exec(
      address.pathname,
    );
  if (match === null) {
    throw new Error("DLsite requires an official HTTPS product address");
  }
  return canonicalProductAddress(
    match[2]!.toUpperCase(),
    match[1]!.toLowerCase(),
  );
}

function productIdFromAddress(address: string): string {
  const productId = /product_id\/(RJ\d{8}|VJ\d{6})\.html/u.exec(address)?.[1];
  if (productId === undefined) throw new Error("Invalid DLsite source address");
  return productId;
}

function productAddressFromJson(
  productId: string,
  body: string,
): string | undefined {
  const parsed = JSON.parse(body) as Record<
    string,
    { readonly site_id?: unknown }
  >;
  const product = parsed[productId];
  if (product === undefined) return undefined;
  const section = stringValue(product.site_id).toLowerCase();
  if (
    ![
      "maniax",
      "girls",
      "soft",
      "pro",
      "books",
      "comics",
      "appx",
      "home",
      "eng",
    ].includes(section)
  ) {
    throw new Error(
      "DLsite JSON did not declare a supported official catalogue section",
    );
  }
  return canonicalProductAddress(productId, section);
}

function productInfoFromHtml(
  productId: string,
  html: string,
): ProductInfo | undefined {
  const contents = /var\s+contents\s*=\s*(\{[\s\S]*?\});\s*<\/script>/u.exec(
    html,
  )?.[1];
  if (contents === undefined) return undefined;
  const detail = (JSON.parse(contents) as { readonly detail?: unknown }).detail;
  if (!Array.isArray(detail)) return undefined;
  const product = detail.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" &&
      item !== null &&
      stringValue((item as { readonly id?: unknown }).id) === productId,
  );
  if (product === undefined) return undefined;
  return {
    work_name: product.name,
    regist_date:
      typeof product.regist_date === "string"
        ? product.regist_date.replaceAll("/", "-")
        : product.regist_date,
    work_image: product.image_main,
    age_category: product.age_category,
    maker_id: product.brand,
    options: product.lang_options,
    title_id: product.title_id ?? product.series_id,
    title_name: product.title_name ?? product.series_name,
    work_lang: product.lang,
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Missing ${label}`);
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.map(stringValue).find((value) => value.length > 0);
}

function jpyPrice(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return undefined;
  return String(value);
}

function creditedNames(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : [value];
  // 唯一分割点是 DLsite 文档规定的列表分隔符。保留每次精确出现；
  // 任何修剪、规范化或 `Set` 都不能合并不同拼写。
  return values
    .flatMap((item) => stringValue(item).split(/[、,，／]/u))
    .flatMap((item) =>
      item.trim().toUpperCase() === "N/A" ? [] : item.split("/"),
    )
    .filter((item) => item.length > 0 && item.trim().toUpperCase() !== "N/A");
}

function sourcedEntityId(namespace: string, sourceKey: string): string {
  return `entity_${createHash("sha256")
    .update(`dlsite:${namespace}:${sourceKey}`)
    .digest("hex")}`;
}

function declaredLanguages(value: unknown): readonly string[] {
  return stringValue(value)
    .split("#")
    .filter((token) =>
      ["JPN", "ENG", "CHI", "CHI_HANS", "CHI_HANT", "KO_KR", "KOR"].includes(
        token,
      ),
    );
}

function circleNameFromHtml(html: string, makerId: string): string | undefined {
  const escaped = makerId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `maker_id/${escaped}\\.html[^>]*>\\s*<span>([^<]+)</span>`,
    "u",
  ).exec(html)?.[1];
  return match === undefined ? undefined : decodeHtml(match);
}

function creditedNamesFromHtml(html: string, label: string): readonly string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const row = new RegExp(
    `<th>\\s*${escaped}\\s*</th>[\\s\\S]*?<td>([\\s\\S]*?)</td>`,
    "u",
  ).exec(html)?.[1];
  if (row === undefined) return [];
  return [...row.matchAll(/>([^<>]+)<\/a>/gu)]
    .map((match) => decodeHtml(match[1] ?? ""))
    .filter((name) => name.length > 0 && name.toUpperCase() !== "N/A");
}

function explicitMainImage(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function carouselFirstImage(html: string): string | undefined {
  const carousel =
    /class="[^"]*(?:work_slider|work_carousel)[^"]*"[\s\S]{0,2000}?<img[^>]+src="([^"]+)"/u.exec(
      html,
    );
  return carousel?.[1];
}

function officialIntroduction(html: string): string | undefined {
  const meta =
    /<meta\s+(?:name|property)="(?:description|og:description)"\s+content="([^"]+)"/u.exec(
      html,
    )?.[1];
  if (meta === undefined) return undefined;
  const value = decodeHtml(meta).split("「DLsite", 1)[0]?.trim() ?? "";
  return value.length > 0 ? value : undefined;
}

function absoluteHttps(value: string): string {
  return value.startsWith("//") ? `https:${value}` : value;
}

function mediaTypeForImage(reference: string): string {
  const extension = new URL(absoluteHttps(reference)).pathname
    .split(".")
    .at(-1)
    ?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
