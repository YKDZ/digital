import type {
  EffectiveSubjectRead,
  SelectedMetadataRead,
  InformationRequirement,
} from "@digital/application";
import * as v from "valibot";

export type { InformationRequirement } from "@digital/application";

import {
  type BangumiSeriesViewModel,
  projectBangumiCatalogue,
} from "./bangumi";
import { nameSchema } from "./name-schema";

export * from "./asset-refresh-selection";
export * from "./bangumi";
export * from "./library.ts";

export type Greeting = { message: string };

export function greet(name: string): Greeting {
  return { message: `Hello, ${v.parse(nameSchema, name)}` };
}

/** 通用资产视图完整且与交付无关的信息需求。 */
export const generalAssetViewInformationRequirement: InformationRequirement = {
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

/**
 * 图书视图实际消费的信息；来源/提供方保持开放。
 *
 * 资料语境与普通查询一致：书籍详情、索引和预演对同一需求采用相同的来源优先级政策，
 * 避免同一实体的多来源标题在不同入口分别表现为单值与冲突。仅请求的坐标不同。
 */
export const bookViewInformationRequirement: InformationRequirement = {
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

/** 影片视图实际消费的信息；来源/提供方保持开放。 */
export const filmViewInformationRequirement: InformationRequirement = {
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

/**
 * DLsite 资产视图完整且与交付无关的输入声明。
 *
 * 它刻意由视图边界拥有，而不是由卡片、详情、文件树或交付路由拥有。应用层只看到这些
 * 开放事实坐标和普通有效元数据使用上下文。
 */
export const dlsiteAssetViewInformationRequirement: InformationRequirement = {
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

/**
 * 正式通用资产视图面向消费者的结构。其来源输入刻意保持结构化：应用层提供中立事实，
 * 该限界上下文选择消费者看到的名称、分组和省略项。
 */
export type AssetViewComponent =
  | "generic"
  | "fanbox"
  | "dlsite"
  | "bangumi"
  | "book"
  | "film";

export type DlsiteViewCreditGroup = {
  readonly heading: string;
  readonly names: readonly string[];
};

export type ArtifactFileView = {
  readonly name: string;
  readonly format: string;
  readonly revisionId?: string;
  readonly image?: string;
  readonly byteLength?: number;
  readonly downloadUrl?: string;
  readonly interaction?: {
    readonly positionMilliseconds: number;
    readonly completed: boolean;
  };
};

export type AssetFileTreeNode = {
  readonly name: string;
  readonly children?: readonly AssetFileTreeNode[];
  readonly format?: string;
  readonly revisionId?: string;
  readonly image?: string;
  readonly byteLength?: number;
  readonly downloadUrl?: string;
  readonly interaction?: ArtifactFileView["interaction"];
};

export type AssetViewModel = {
  readonly id: string;
  /** 精确交付主体；服务端解析可变范围/指代。 */
  readonly refreshTarget: { readonly subjectId: string };
  readonly cardComponent: AssetViewComponent;
  readonly detailComponent: AssetViewComponent;
  readonly title: string;
  readonly factProblems?: readonly {
    readonly target: EffectiveSubjectRead["descriptions"][number]["target"];
    readonly message: string;
    readonly conflicts: EffectiveSubjectRead["descriptions"][number]["conflicts"];
  }[];
  /**
   * 被请求且必需的坐标在生效描述里确定为 missing 的坐标集。它与 informationReadiness
   * 的获取状态分属两个维度：这里表达“当前事实确实没有值”，履行状态表达“还能不能取到”。
   * 坐标只供展示层映射友好名称，绝不作为公共文案直接渲染。
   */
  readonly missingFacts?: readonly string[];
  readonly informationReadiness?: EffectiveSubjectRead["informationReadiness"];
  readonly introduction?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly releaseDate?: string;
  readonly publicationDateTime?: string;
  readonly language?: string;
  readonly classifications: readonly string[];
  readonly cover?: string;
  readonly files?: readonly ArtifactFileView[];
  readonly fileTree?: readonly AssetFileTreeNode[];
  readonly available: boolean;
  readonly officialPage?: string;
  readonly sourceLabel?: string;
  /** 后续检查界面使用的全部当前来源关联；普通详情可只显示安静的来源链接。 */
  readonly sources?: readonly {
    readonly sourceIdentity: string;
    readonly label?: string;
    readonly officialPage?: string;
  }[];
  readonly relationships: readonly {
    readonly heading: "参与者" | "相关内容";
    readonly label: string;
  }[];
  readonly fanbox?: {
    readonly title: string;
    readonly publicationDateTime?: string;
    readonly creator?: string;
    readonly body?: string;
    readonly cover?: string;
    readonly hasOfficialCover: boolean;
    readonly entitlement?: "available" | "restricted" | "unverified";
    readonly likeCount?: string;
    readonly commentCount?: string;
    readonly attachments: readonly {
      readonly name?: string;
      readonly byteLength?: string;
      readonly kind: "file" | "image";
    }[];
  };
  readonly dlsite?: {
    readonly title: string;
    readonly cover?: string;
    readonly releaseDate?: string;
    readonly introduction?: string;
    readonly circle?: string;
    readonly priceJpy?: string;
    readonly languages: readonly string[];
    readonly classifications: readonly string[];
    readonly genres: readonly {
      readonly vocabulary: string;
      readonly termId: string;
      readonly label: string;
    }[];
    readonly credits: readonly DlsiteViewCreditGroup[];
    readonly fileTree?: readonly AssetFileTreeNode[];
    readonly series: readonly {
      readonly id: string;
      readonly relationshipId: string;
      readonly name: string;
      readonly position?: string;
    }[];
  };
  readonly book?: {
    readonly title: string;
    readonly cover?: string;
    readonly contributors: readonly string[];
    readonly isbn13?: string;
    readonly publisher?: string;
    readonly publicationDate?: string;
    readonly language?: string;
    readonly format?: string;
    readonly files: readonly ArtifactFileView[];
  };
  readonly film?: {
    readonly title: string;
    readonly cover?: string;
    readonly releaseDate?: string;
    readonly year?: string;
    readonly introduction?: string;
    readonly runtimeMinutes?: string;
    readonly genres: readonly string[];
    readonly directors: readonly string[];
    readonly cast: readonly string[];
    readonly ratings: readonly {
      readonly label: string;
      readonly value: string;
    }[];
    readonly awards?: string;
    readonly boxOffice?: string;
    readonly sources: readonly {
      readonly label: string;
      readonly officialPage?: string;
    }[];
  };
};

/** 普通读取直接成为展示输入；交付层只可补充下载地址与用户交互。 */
export type AssetViewFacts = Omit<EffectiveSubjectRead, "locations"> & {
  readonly locations: readonly (EffectiveSubjectRead["locations"][number] & {
    readonly downloadUrl?: string;
  })[];
  readonly interactionStates?: readonly {
    readonly artifactRevisionId: string;
    readonly positionMilliseconds: number;
    readonly completed: boolean;
  }[];
};

export function subjectMetadata(
  input: Pick<EffectiveSubjectRead, "id" | "descriptions">,
  subjectId = input.id,
): readonly SelectedMetadataRead[] {
  return (
    input.descriptions
      .find(
        (description) =>
          description.target.kind === "entity" &&
          description.target.entityId === subjectId,
      )
      ?.metadata.flatMap((property) =>
        property.result.status === "resolved" ? property.result.values : [],
      ) ?? []
  );
}

export function subjectArtwork(
  input: Pick<EffectiveSubjectRead, "descriptions">,
  subjectId: string,
): string | undefined {
  return input.descriptions
    .find(
      (description) =>
        description.target.kind === "entity" &&
        description.target.entityId === subjectId,
    )
    ?.artifactRoles.find((role) => role.role === "asset.primary-cover")
    ?.address;
}

export type CatalogueViewModel = AssetViewModel | BangumiSeriesViewModel;

export type TargetArtworkResult = {
  readonly address?: string;
  readonly problem?: ReturnType<typeof factProblems>[number];
};

/**
 * 在同一明确实体目标上共同消费多份资料读取的主封面结果。协调依据是各读取实际选中的产物身份
 * 与该角色的可用状态，而不是可选的地址：已选出但当前不可用的读取不会被跳过，也不会有另一读取
 * 的另一张图替它补位。不同产物是资料事实冲突，抑制供图并保留稳定审计；同一产物在不同读取中的
 * 可用位置差异只是可用性问题，不伪装成产物选择冲突。任一读取保留同级冲突时不供图（该冲突由
 * `factProblems` 逐项呈现），读取之间绝不按先后取首个地址。
 */
export function targetArtwork(
  inputs: readonly Pick<EffectiveSubjectRead, "descriptions">[],
  subjectId: string,
): TargetArtworkResult {
  const role = "asset.primary-cover";
  const problem = (
    message: string,
    conflicts: NonNullable<TargetArtworkResult["problem"]>["conflicts"],
  ): NonNullable<TargetArtworkResult["problem"]> => ({
    target: { kind: "entity", entityId: subjectId },
    message,
    conflicts,
  });
  const artifactIds = new Set<string>();
  const associationIds = new Set<string>();
  const addresses = new Set<string>();
  let selected = 0;
  let unusable = 0;
  let conflicted = false;
  for (const input of inputs) {
    const description = input.descriptions.find(
      (candidate) =>
        candidate.target.kind === "entity" &&
        candidate.target.entityId === subjectId,
    );
    if (description === undefined) continue;
    if (description.conflicts.some((conflict) => conflict.role === role))
      conflicted = true;
    const chosen = description.artifactRoles.find(
      (candidate) => candidate.role === role,
    );
    if (chosen === undefined) continue;
    selected += 1;
    artifactIds.add(chosen.artifactId);
    for (const associationId of chosen.associationIds)
      associationIds.add(associationId);
    if (chosen.address === undefined) unusable += 1;
    else addresses.add(chosen.address);
  }
  if (artifactIds.size > 1)
    return {
      problem: problem("这项内容有尚未解决的资料或图片选择", [
        {
          kind: "artifact-association-conflict",
          role,
          references: [...associationIds].toSorted().map((associationId) => ({
            kind: "artifact-association" as const,
            associationId,
          })),
          explanation: "同一图片目标在不同资料读取中选择了不同产物",
        },
      ]),
    };
  if (selected === 0 || conflicted || addresses.size === 0) return {};
  const [address] = [...addresses].toSorted();
  if (address === undefined) return {};
  return {
    address,
    ...(unusable === 0
      ? {}
      : {
          problem: problem("这项内容的封面有尚未确认的当前内容", []),
        }),
  };
}

export function factProblems(
  input: AssetViewFacts,
): NonNullable<AssetViewModel["factProblems"]> {
  return input.descriptions.flatMap((description) =>
    description.conflicts.length === 0
      ? []
      : [
          {
            target: description.target,
            message: "这项内容有尚未解决的资料或图片选择",
            conflicts: description.conflicts,
          },
        ],
  );
}

/**
 * 生效描述里被请求且必需、却确定为 missing 的坐标。只用于与冲突、履行状态区分展示，
 * 可选坐标缺失或没有就绪信息时不制造缺失，绝不把未请求坐标计为缺失。
 */
export function descriptiveMissingFacts(
  input: AssetViewFacts,
): readonly string[] {
  const required = new Set(
    (input.informationReadiness?.inputs ?? [])
      .filter((item) => item.necessity === "required")
      .map((item) => item.coordinate),
  );
  if (required.size === 0) return [];
  const description = input.descriptions.find(
    (item) =>
      item.target.kind === "entity" && item.target.entityId === input.id,
  );
  if (description === undefined) return [];
  return [
    ...description.metadata
      .filter((property) => property.result.status === "missing")
      .map((property) => property.property),
    ...description.missingArtifactRoles,
  ].filter((coordinate) => required.has(coordinate));
}

function singleMetadata(
  metadata: readonly SelectedMetadataRead[],
  property: string,
): string | undefined {
  const values = metadataValues(metadata, property);
  return values.length === 1 ? values[0] : undefined;
}

function metadataValues(
  metadata: readonly SelectedMetadataRead[],
  property: string,
): readonly string[] {
  return metadata
    .filter((item) => item.property === property)
    .map((item) => item.value);
}

/**
 * 展示层拥有组件分派，也因此拥有该组件的完整需求权威。交付层绝不会向应用层请求
 * 所有视图可选数据的全局并集。
 */
export function assetViewComponent(
  input: Pick<
    AssetViewFacts,
    | "id"
    | "sourceAssociations"
    | "recognitionSourceAssociation"
    | "descriptions"
  >,
): AssetViewComponent {
  const identities = [
    ...(input.sourceAssociations ?? []).map(
      (association) => association.sourceIdentity,
    ),
    input.recognitionSourceAssociation?.sourceIdentity,
  ];
  if (identities.includes("fanbox")) return "fanbox";
  if (identities.includes("dlsite")) return "dlsite";
  if (identities.includes("tmdb")) return "film";
  if (identities.includes("bangumi")) return "bangumi";
  if (
    subjectMetadata(input).some(
      (item) =>
        item.property === "asset.content-classification" &&
        item.value === "book",
    ) ||
    subjectMetadata(input).some((item) =>
      ["book.isbn-13", "book.contributor", "book.publisher"].includes(
        item.property,
      ),
    )
  )
    return "book";
  return "generic";
}

/**
 * 解析根据当前事实选出的展示所对应的唯一完整需求。通用、FANBOX 和 Bangumi 展示
 * 暂时使用通用视图声明，直到各自拥有更具体的需求。
 */
export function informationRequirementForAssetView(
  input: Pick<
    AssetViewFacts,
    | "id"
    | "sourceAssociations"
    | "recognitionSourceAssociation"
    | "descriptions"
  >,
): InformationRequirement {
  switch (assetViewComponent(input)) {
    case "dlsite":
      return dlsiteAssetViewInformationRequirement;
    case "book":
      return bookViewInformationRequirement;
    case "film":
      return filmViewInformationRequirement;
    case "generic":
    case "fanbox":
    case "bangumi":
      return generalAssetViewInformationRequirement;
  }
}

function sourceLabel(identity: string | undefined): string | undefined {
  return identity === undefined
    ? undefined
    : ({
        nbinet: "国家图书馆",
        dlsite: "DLsite",
        fanbox: "FANBOX",
        bangumi: "Bangumi",
        tmdb: "TMDB",
        omdb: "OMDb",
      }[identity] ?? identity);
}

function relationshipLabels(
  input: AssetViewFacts,
  role: string,
): readonly string[] {
  const entities = new Map(
    (input.relatedEntities ?? []).map((entity) => [entity.id, entity.label]),
  );
  return (input.relationships ?? [])
    .filter((relationship) =>
      relationship.participants.some(
        (participant) => participant.entityId === input.id,
      ),
    )
    .flatMap((relationship) => {
      return relationship.participants.flatMap((participant) => {
        if (participant.role !== role) return [];
        const label = entities.get(participant.entityId);
        return label === undefined ? [] : [label];
      });
    });
}

function joinedRelationshipLabels(
  input: AssetViewFacts,
  role: string,
): string | undefined {
  const labels = [...new Set(relationshipLabels(input, role))];
  return labels.length === 0 ? undefined : labels.join("、");
}

function fileFormat(name: string): string {
  return /\.([^.]+)$/u.exec(name)?.[1]?.toUpperCase() ?? "文件";
}

function currentRevisionId(
  _input: AssetViewFacts,
  location: AssetViewFacts["locations"][number],
): string | undefined {
  return location.content.status === "confirmed"
    ? location.content.target.revisionId
    : undefined;
}

function interactionFor(
  input: AssetViewFacts,
  revisionId: string | undefined,
): ArtifactFileView["interaction"] | undefined {
  if (revisionId === undefined) return undefined;
  const state = input.interactionStates?.find(
    (candidate) => candidate.artifactRevisionId === revisionId,
  );
  return state === undefined
    ? undefined
    : {
        positionMilliseconds: state.positionMilliseconds,
        completed: state.completed,
      };
}

function observedFileTree(input: AssetViewFacts): readonly AssetFileTreeNode[] {
  const files = input.locations.filter(
    (location) => location.kind === "observed",
  );
  const paths = files.map((file) =>
    file.address.split(/[\\/]/u).filter(Boolean),
  );
  const common = paths.reduce<string[]>(
    (prefix, current) => {
      let length = 0;
      while (length < prefix.length && prefix[length] === current[length])
        length += 1;
      return prefix.slice(0, length);
    },
    paths[0]?.slice(0, -1) ?? [],
  );
  type MutableNode = {
    name: string;
    children: Map<string, MutableNode>;
    file?: ArtifactFileView;
  };
  const root = new Map<string, MutableNode>();
  for (const location of files) {
    const segments = location.address
      .split(/[\\/]/u)
      .filter(Boolean)
      .slice(common.length);
    const name = segments.pop();
    if (name === undefined) continue;
    let children = root;
    for (const segment of segments) {
      const node = children.get(segment) ?? {
        name: segment,
        children: new Map(),
      };
      children.set(segment, node);
      children = node.children;
    }
    const revisionId = currentRevisionId(input, location);
    const byteLength = location.byteLength;

    children.set(name, {
      name,
      children: new Map(),
      file: {
        name,
        format: fileFormat(name),
        ...(revisionId === undefined ? {} : { revisionId }),
        ...(byteLength === undefined ? {} : { byteLength }),
        ...(location.downloadUrl === undefined
          ? {}
          : { downloadUrl: location.downloadUrl }),
        ...(interactionFor(input, revisionId) === undefined
          ? {}
          : { interaction: interactionFor(input, revisionId)! }),
      },
    });
  }
  const project = (
    nodes: Map<string, MutableNode>,
  ): readonly AssetFileTreeNode[] =>
    [...nodes.values()]
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((node) =>
        node.file === undefined
          ? { name: node.name, children: project(node.children) }
          : {
              name: node.file.name,
              format: node.file.format,
              ...(node.file.revisionId === undefined
                ? {}
                : { revisionId: node.file.revisionId }),
              ...(node.file.image === undefined
                ? {}
                : { image: node.file.image }),
              ...(node.file.byteLength === undefined
                ? {}
                : { byteLength: node.file.byteLength }),
              ...(node.file.downloadUrl === undefined
                ? {}
                : { downloadUrl: node.file.downloadUrl }),
              ...(node.file.interaction === undefined
                ? {}
                : { interaction: node.file.interaction }),
            },
      );
  return project(root);
}

/** 从观察材料投影消费者可见的文件；同集多技术与字幕都作为独立材料保留。 */
export function observedArtifactFiles(
  input: AssetViewFacts,
): readonly ArtifactFileView[] {
  return input.locations
    .filter((location) => location.kind === "observed")
    .map((location) => {
      const name = location.address.split(/[\\/]/u).at(-1) ?? "文件";
      const extension = /\.([^.]+)$/u.exec(name)?.[1]?.toUpperCase();
      const revisionId = currentRevisionId(input, location);
      const image =
        location.content.status === "confirmed"
          ? input.descriptions
              .find(
                (description) =>
                  description.target.kind === "artifact-revision" &&
                  description.target.artifactId === location.artifactId &&
                  description.target.revisionId === revisionId,
              )
              ?.artifactRoles.find(
                (role) => role.role === "asset.material-image",
              )?.address
          : undefined;
      const byteLength = location.byteLength;

      return {
        name,
        format: extension ?? "文件",
        ...(revisionId === undefined ? {} : { revisionId }),
        ...(image === undefined ? {} : { image }),
        ...(byteLength === undefined ? {} : { byteLength }),
        ...(location.downloadUrl === undefined
          ? {}
          : { downloadUrl: location.downloadUrl }),
        ...(interactionFor(input, revisionId) === undefined
          ? {}
          : { interaction: interactionFor(input, revisionId)! }),
      };
    });
}

function fanboxAttachments(
  candidates: AssetViewFacts["sourceArtifacts"],
): readonly {
  readonly name?: string;
  readonly byteLength?: string;
  readonly kind: "file" | "image";
}[] {
  return (candidates ?? [])
    .filter((candidate) => candidate.role.startsWith("fanbox.attachment."))
    .toSorted(
      (left, right) =>
        (left.selectionEvidence?.sourceOrdinal ?? Number.MAX_SAFE_INTEGER) -
        (right.selectionEvidence?.sourceOrdinal ?? Number.MAX_SAFE_INTEGER),
    )
    .map(({ role, selectionEvidence }) => ({
      kind: role === "fanbox.attachment.image" ? "image" : "file",
      ...(selectionEvidence?.suggestedFilename === undefined
        ? {}
        : { name: selectionEvidence.suggestedFilename }),
      ...(selectionEvidence?.declaredByteLength === undefined
        ? {}
        : { byteLength: String(selectionEvidence.declaredByteLength) }),
    }));
}

function dlsiteCredits(
  input: AssetViewFacts,
): readonly DlsiteViewCreditGroup[] {
  return [
    { heading: "配音", role: "voice" },
    { heading: "剧本", role: "scenario" },
    { heading: "插画", role: "illustration" },
    { heading: "作者", role: "author" },
  ].flatMap(({ heading, role }) => {
    const names = relationshipLabels(input, role);
    return names.length === 0 ? [] : [{ heading, names }];
  });
}

/**
 * 通过同一个视图投影已应用事实和提议事实。角色字符串仍属于证据词汇，
 * 绝不跨越该消费者边界。
 */
export function projectAssetView(input: AssetViewFacts): AssetViewModel {
  const component = assetViewComponent(input);
  const cover = subjectArtwork(input, input.id);

  const entities = new Map(
    (input.relatedEntities ?? []).map((entity) => [entity.id, entity.label]),
  );
  const relationships = (input.relationships ?? [])
    .filter((relationship) =>
      relationship.participants.some(
        (participant) => participant.entityId === input.id,
      ),
    )
    .flatMap((relationship) => {
      return relationship.participants.flatMap((participant) => {
        if (participant.role === "asset") return [];
        const label = entities.get(participant.entityId);
        return label === undefined
          ? []
          : [
              {
                heading:
                  relationship.type === "asset.contribution"
                    ? "参与者"
                    : "相关内容",
                label,
              } as const,
            ];
      });
    });
  const title =
    singleMetadata(subjectMetadata(input), "asset.title") ?? "未命名";
  const releaseDate = singleMetadata(
    subjectMetadata(input),
    "asset.release-date",
  );
  const publicationDateTime = singleMetadata(
    subjectMetadata(input),
    "asset.publication-datetime",
  );
  const introduction = singleMetadata(
    subjectMetadata(input),
    "asset.introduction",
  );
  const summary = singleMetadata(subjectMetadata(input), "asset.summary");
  const body = singleMetadata(subjectMetadata(input), "asset.body");
  const language = singleMetadata(
    subjectMetadata(input),
    "asset.declared-language",
  );
  const classifications = metadataValues(
    subjectMetadata(input),
    "asset.content-classification",
  );
  const fanboxEntitlement = singleMetadata(
    subjectMetadata(input),
    "fanbox.post.entitlement",
  );
  const fanboxCreator = joinedRelationshipLabels(input, "fanbox.post.creator");
  const fanboxLikeCount = singleMetadata(
    subjectMetadata(input),
    "fanbox.post.like-count",
  );
  const fanboxCommentCount = singleMetadata(
    subjectMetadata(input),
    "fanbox.post.comment-count",
  );
  const dlsiteCircle = joinedRelationshipLabels(input, "circle");
  const dlsitePriceJpy = singleMetadata(
    subjectMetadata(input),
    "dlsite.product.price-jpy",
  );
  const series = (input.relationships ?? [])
    .filter(
      (relationship) =>
        relationship.type === "asset.membership" &&
        relationship.participants.some(
          (participant) => participant.entityId === input.id,
        ),
    )
    .flatMap((relationship) =>
      relationship.participants.flatMap((participant) => {
        if (participant.role !== "dlsite.series.member") return [];
        const name = entities.get(participant.entityId);
        if (name === undefined) return [];
        const position = relationship.qualifiers?.find(
          (qualifier) => qualifier.key === "asset.membership.position",
        )?.value;
        return [
          {
            id: participant.entityId,
            relationshipId: relationship.id,
            name,
            ...(position === undefined ? {} : { position }),
          },
        ];
      }),
    );

  const runtimeMinutes = singleMetadata(
    subjectMetadata(input),
    "asset.runtime-minutes",
  );
  const filmGenres = metadataValues(subjectMetadata(input), "asset.genre");
  const filmDirectors = relationshipLabels(input, "director");
  const filmCast = relationshipLabels(input, "cast");
  const filmRatings = [
    { property: "rating.imdb", label: "IMDb" },
    { property: "rating.rotten-tomatoes", label: "烂番茄" },
    { property: "rating.metacritic", label: "Metacritic" },
  ].flatMap(({ property, label }) =>
    metadataValues(subjectMetadata(input), property).map((value) => ({
      label,
      value,
    })),
  );
  const filmSources = [
    ...(input.sourceAssociations ?? []),
    ...(input.sourceAssociations === undefined &&
    input.recognitionSourceAssociation !== undefined
      ? [input.recognitionSourceAssociation]
      : []),
  ].flatMap((association) => {
    const label = sourceLabel(association.sourceIdentity);
    return label === undefined
      ? []
      : [
          {
            label,
            ...(/^https?:\/\//u.test(association.nativeAddress)
              ? { officialPage: association.nativeAddress }
              : {}),
          },
        ];
  });
  const observedFiles = observedArtifactFiles(input);
  const bookIsbn13 = singleMetadata(subjectMetadata(input), "book.isbn-13");
  const bookPublisher = singleMetadata(
    subjectMetadata(input),
    "book.publisher",
  );
  const bookPublicationDate = singleMetadata(
    subjectMetadata(input),
    "book.publication-date",
  );
  const filmAwards = singleMetadata(subjectMetadata(input), "asset.awards");
  const filmBoxOffice = singleMetadata(
    subjectMetadata(input),
    "asset.box-office",
  );
  const firstObservedFile = observedFiles[0];
  const missingFacts = descriptiveMissingFacts(input);
  const primarySourceLabel = sourceLabel(
    input.recognitionSourceAssociation?.sourceIdentity,
  );
  const sources = (input.sourceAssociations ?? []).flatMap((association) =>
    association.sourceIdentity === undefined
      ? []
      : [
          {
            sourceIdentity: association.sourceIdentity,
            ...(sourceLabel(association.sourceIdentity) === undefined
              ? {}
              : { label: sourceLabel(association.sourceIdentity)! }),
            ...(/^https?:\/\//u.test(association.nativeAddress)
              ? { officialPage: association.nativeAddress }
              : {}),
          },
        ],
  );
  return {
    id: input.id,
    refreshTarget: { subjectId: input.id },
    cardComponent: component,
    detailComponent: component,
    title,
    factProblems: factProblems(input),
    ...(missingFacts.length === 0 ? {} : { missingFacts }),
    ...(input.informationReadiness === undefined
      ? {}
      : { informationReadiness: input.informationReadiness }),
    ...(introduction === undefined ? {} : { introduction }),
    ...(summary === undefined ? {} : { summary }),
    ...(body === undefined ? {} : { body }),
    ...(releaseDate === undefined ? {} : { releaseDate }),
    ...(publicationDateTime === undefined ? {} : { publicationDateTime }),
    ...(language === undefined ? {} : { language }),
    classifications,
    files: observedFiles,
    fileTree: observedFileTree(input),
    ...(cover === undefined ? {} : { cover }),
    available: input.locations.some((location) => location.kind === "observed"),
    sources,
    ...(input.recognitionSourceAssociation === undefined
      ? {}
      : {
          officialPage: input.recognitionSourceAssociation.nativeAddress,
          ...(primarySourceLabel === undefined
            ? {}
            : { sourceLabel: primarySourceLabel }),
        }),
    relationships,
    ...(component !== "fanbox"
      ? {}
      : {
          fanbox: {
            title,
            ...(publicationDateTime === undefined
              ? {}
              : { publicationDateTime }),
            ...(fanboxCreator === undefined ? {} : { creator: fanboxCreator }),
            ...(body === undefined ? {} : { body }),
            ...(cover === undefined ? {} : { cover }),
            hasOfficialCover: cover !== undefined,
            ...(fanboxEntitlement === "available" ||
            fanboxEntitlement === "restricted" ||
            fanboxEntitlement === "unverified"
              ? { entitlement: fanboxEntitlement }
              : {}),
            ...(fanboxLikeCount === undefined
              ? {}
              : { likeCount: fanboxLikeCount }),
            ...(fanboxCommentCount === undefined
              ? {}
              : { commentCount: fanboxCommentCount }),
            attachments: fanboxAttachments(input.sourceArtifacts),
          },
        }),
    ...(component !== "dlsite"
      ? {}
      : {
          dlsite: {
            title,
            ...(cover === undefined ? {} : { cover }),
            ...(releaseDate === undefined ? {} : { releaseDate }),
            ...(introduction === undefined ? {} : { introduction }),
            ...(dlsiteCircle === undefined ? {} : { circle: dlsiteCircle }),
            ...(dlsitePriceJpy === undefined
              ? {}
              : { priceJpy: dlsitePriceJpy }),
            languages: metadataValues(
              subjectMetadata(input),
              "asset.declared-language",
            ),
            classifications,
            genres: subjectMetadata(input)
              .filter((value) => value.property === "dlsite.product.genre")
              .flatMap((value) => {
                const vocabulary = value.qualifiers?.find(
                  (qualifier) => qualifier.key === "classification.vocabulary",
                )?.value;
                const termId = value.qualifiers?.find(
                  (qualifier) => qualifier.key === "classification.term-id",
                )?.value;
                return vocabulary === undefined || termId === undefined
                  ? []
                  : [{ vocabulary, termId, label: value.value }];
              }),
            credits: dlsiteCredits(input),
            fileTree: observedFileTree(input),
            series,
          },
        }),
    ...(component !== "book"
      ? {}
      : {
          book: {
            title,
            ...(cover === undefined ? {} : { cover }),
            contributors: contributionLabels(input),
            ...(bookIsbn13 === undefined ? {} : { isbn13: bookIsbn13 }),
            ...(bookPublisher === undefined
              ? {}
              : { publisher: bookPublisher }),
            ...(bookPublicationDate === undefined
              ? {}
              : { publicationDate: bookPublicationDate }),
            ...(language === undefined ? {} : { language }),
            ...(firstObservedFile === undefined
              ? {}
              : { format: firstObservedFile.format }),
            files: observedFiles,
          },
        }),
    ...(component !== "film"
      ? {}
      : {
          film: {
            title,
            ...(cover === undefined ? {} : { cover }),
            ...(releaseDate === undefined ? {} : { releaseDate }),
            ...(releaseDate === undefined
              ? {}
              : { year: releaseDate.slice(0, 4) }),
            ...(introduction === undefined ? {} : { introduction }),
            ...(runtimeMinutes === undefined ? {} : { runtimeMinutes }),
            genres: filmGenres,
            directors: filmDirectors,
            cast: filmCast,
            ratings: filmRatings,
            ...(filmAwards === undefined ? {} : { awards: filmAwards }),
            ...(filmBoxOffice === undefined
              ? {}
              : { boxOffice: filmBoxOffice }),
            sources: filmSources,
          },
        }),
  };
}

function contributionLabels(input: AssetViewFacts): readonly string[] {
  const entities = new Map(
    input.relatedEntities.map((entity) => [entity.id, entity.label]),
  );
  return [
    ...new Set(
      input.relationships
        .filter(
          (relationship) =>
            relationship.type === "asset.contribution" &&
            relationship.participants.some(
              (participant) =>
                participant.entityId === input.id &&
                participant.role === "asset",
            ),
        )
        .flatMap((relationship) =>
          relationship.participants.flatMap((participant) => {
            if (participant.role === "asset") return [];
            const label = entities.get(participant.entityId);
            return label === undefined ? [] : [label];
          }),
        ),
    ),
  ];
}

/**
 * 拥有目录分区和视图组件分派。交付层接收可直接渲染的展示模型，
 * 绝不会按提供方身份分组。
 */
export function projectCatalogue(
  facts: readonly AssetViewFacts[],
): readonly CatalogueViewModel[] {
  const currentBySubject = new Map<string, AssetViewFacts>();
  for (const fact of facts) {
    if (currentBySubject.has(fact.id)) currentBySubject.delete(fact.id);
    currentBySubject.set(fact.id, fact);
  }
  const current = [...currentBySubject.values()];
  const groups = projectBangumiCatalogue(current);
  const represented = new Set(
    groups.flatMap((group) => group.episodes.map((episode) => episode.assetId)),
  );
  return [
    ...groups,
    ...current
      .filter((fact) => !represented.has(fact.id))
      .map(projectAssetView),
  ];
}
