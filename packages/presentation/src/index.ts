import type {
  AcceptedAssetState,
  EffectiveMetadata,
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

/** 图书视图实际消费的信息；来源/提供方保持开放。 */
export const bookViewInformationRequirement: InformationRequirement = {
  metadataUsageContext: "asset.book-view",
  metadata: [
    { property: "asset.title", necessity: "required" },
    { property: "book.contributor", necessity: "optional" },
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
  relationshipTypes: [],
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
    readonly credits: readonly DlsiteViewCreditGroup[];
    readonly fileTree?: readonly AssetFileTreeNode[];
    readonly series?: {
      readonly name: string;
      readonly position?: string;
    };
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

export type AssetViewFacts = {
  readonly id: string;
  readonly primaryCoverArtifactId?: string;
  /** 所有当前来源关联；其中一项可能仍是识别溯源。 */
  readonly sourceAssociations?: readonly {
    readonly sourceIdentity?: string;
    readonly nativeAddress: string;
  }[];
  /** @deprecated 请使用 `sourceAssociations`；为现有来源视图保留。 */
  readonly sourceAssociation?: {
    readonly sourceIdentity?: string;
    readonly nativeAddress: string;
  };
  /**
   * 为该视图使用上下文选出的有效元数据。展示层接收选定值，而不是无序的来源断言集合。
   */
  readonly metadata: readonly (Pick<EffectiveMetadata, "property" | "value"> & {
    readonly subjectId?: string;
    readonly sourceSlot?: string;
  })[];
  readonly sourceArtifactCandidates?: readonly {
    readonly sourceRecordId: string;
    readonly role: string;
    readonly mediaType: string;
    readonly selectionEvidence?: {
      readonly suggestedFilename?: string;
      readonly declaredByteLength?: number;
      readonly sourceOrdinal?: number;
    };
  }[];
  /** 当前相关实体只接收唯一生效种类投影，绝不接收来源解释候选。 */
  readonly currentRelatedEntities?: readonly Pick<
    NonNullable<AcceptedAssetState["currentRelatedEntities"]>[number],
    | "id"
    | "label"
    | "kind"
    | "sourceIdentity"
    | "identityNamespace"
    | "sourceKey"
  >[];
  readonly relationships?: readonly {
    readonly type: string;
    readonly participants: readonly {
      readonly entityId: string;
      readonly role: string;
    }[];
    readonly qualifiers?: readonly {
      readonly key: string;
      readonly value: string;
    }[];
  }[];
  readonly artifactAssociations: readonly {
    readonly target:
      | { readonly kind: "entity"; readonly entityId: string }
      | {
          readonly kind: "artifact-revision";
          readonly artifactId: string;
          readonly revisionId: string;
        };
    readonly artifactId: string;
    readonly role: string;
    readonly observedArtifactPart?: {
      readonly artifactId: string;
      readonly revisionId: string;
      readonly locator: string;
    };
  }[];
  readonly artifactRevisions?: readonly {
    readonly id: string;
    readonly artifactId: string;
    readonly blobDigest?: string;
  }[];
  readonly blobs?: readonly {
    readonly digest: string;
    readonly byteLength: number;
  }[];
  /** 当前观察与精确确认选出的 Location→revision；历史修订版本身不构成 target。 */
  readonly currentLocationRevisions?: readonly {
    readonly locationId: string;
    readonly revisionId: string;
  }[];
  readonly locations: readonly {
    readonly id?: string;
    readonly artifactId: string;
    readonly kind: "managed" | "observed";
    readonly address: string;
    readonly byteLength?: number;
    readonly downloadUrl?: string;
  }[];
  readonly interactionStates?: readonly {
    readonly artifactRevisionId: string;
    readonly positionMilliseconds: number;
    readonly completed: boolean;
  }[];
};

export type CatalogueViewModel = AssetViewModel | BangumiSeriesViewModel;

function singleMetadata(
  metadata: AssetViewFacts["metadata"],
  property: string,
): string | undefined {
  const values = metadataValues(metadata, property);
  return values.length === 1 ? values[0] : undefined;
}

function metadataValues(
  metadata: AssetViewFacts["metadata"],
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
    "sourceAssociations" | "sourceAssociation" | "metadata"
  >,
): AssetViewComponent {
  const identities = [
    ...(input.sourceAssociations ?? []).map(
      (association) => association.sourceIdentity,
    ),
    input.sourceAssociation?.sourceIdentity,
  ];
  if (identities.includes("fanbox")) return "fanbox";
  if (identities.includes("dlsite")) return "dlsite";
  if (identities.includes("tmdb")) return "film";
  if (identities.includes("bangumi")) return "bangumi";
  if (
    input.metadata.some(
      (item) =>
        item.property === "asset.content-classification" &&
        item.value === "book",
    ) ||
    input.metadata.some((item) =>
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
    "sourceAssociations" | "sourceAssociation" | "metadata"
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
    (input.currentRelatedEntities ?? []).map((entity) => [
      entity.id,
      entity.label,
    ]),
  );
  return (input.relationships ?? []).flatMap((relationship) => {
    return relationship.participants.flatMap((participant) => {
      if (participant.role !== role) return [];
      const label = entities.get(participant.entityId);
      return label === undefined ? [] : [label];
    });
  });
}

function firstRelationshipLabel(
  input: AssetViewFacts,
  role: string,
): string | undefined {
  return relationshipLabels(input, role)[0];
}

function fileFormat(name: string): string {
  return /\.([^.]+)$/u.exec(name)?.[1]?.toUpperCase() ?? "文件";
}

function currentRevisionId(
  input: AssetViewFacts,
  location: AssetViewFacts["locations"][number],
): string | undefined {
  if (location.kind === "managed") {
    const revisions = (input.artifactRevisions ?? []).filter(
      (revision) => revision.artifactId === location.artifactId,
    );
    return revisions.length === 1 ? revisions[0]?.id : undefined;
  }
  if (location.id === undefined) return undefined;
  return input.currentLocationRevisions?.find(
    (candidate) => candidate.locationId === location.id,
  )?.revisionId;
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
    const revision = (input.artifactRevisions ?? []).find(
      (candidate) =>
        candidate.id === revisionId &&
        candidate.artifactId === location.artifactId,
    );
    const byteLength =
      location.byteLength ??
      input.blobs?.find((blob) => blob.digest === revision?.blobDigest)
        ?.byteLength;
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

function fanboxAttachments(
  candidates: AssetViewFacts["sourceArtifactCandidates"],
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
  const cover = input.locations.find(
    (location) =>
      location.artifactId === input.primaryCoverArtifactId &&
      location.kind === "managed",
  )?.address;
  const entities = new Map(
    (input.currentRelatedEntities ?? []).map((entity) => [
      entity.id,
      entity.label,
    ]),
  );
  const relationships = (input.relationships ?? []).flatMap((relationship) => {
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
  const title = singleMetadata(input.metadata, "asset.title") ?? "未命名";
  const releaseDate = singleMetadata(input.metadata, "asset.release-date");
  const publicationDateTime = singleMetadata(
    input.metadata,
    "asset.publication-datetime",
  );
  const introduction = singleMetadata(input.metadata, "asset.introduction");
  const summary = singleMetadata(input.metadata, "asset.summary");
  const body = singleMetadata(input.metadata, "asset.body");
  const language = singleMetadata(input.metadata, "asset.declared-language");
  const classifications = metadataValues(
    input.metadata,
    "asset.content-classification",
  );
  const fanboxEntitlement = singleMetadata(
    input.metadata,
    "fanbox.post.entitlement",
  );
  const fanboxCreator = firstRelationshipLabel(input, "fanbox.post.creator");
  const fanboxLikeCount = singleMetadata(
    input.metadata,
    "fanbox.post.like-count",
  );
  const fanboxCommentCount = singleMetadata(
    input.metadata,
    "fanbox.post.comment-count",
  );
  const dlsiteCircle = firstRelationshipLabel(input, "circle");
  const dlsitePriceJpy = singleMetadata(
    input.metadata,
    "dlsite.product.price-jpy",
  );
  const seriesName = firstRelationshipLabel(input, "dlsite.series.member");
  const seriesPosition = relationshipQualifier(
    input,
    "dlsite.series.member",
    "asset.membership.position",
  );
  const runtimeMinutes = singleMetadata(
    input.metadata,
    "asset.runtime-minutes",
  );
  const filmGenres = metadataValues(input.metadata, "asset.genre");
  const filmDirectors = relationshipLabels(input, "director");
  const filmCast = relationshipLabels(input, "cast");
  const filmRatings = [
    { property: "rating.imdb", label: "IMDb" },
    { property: "rating.rotten-tomatoes", label: "烂番茄" },
    { property: "rating.metacritic", label: "Metacritic" },
  ].flatMap(({ property, label }) =>
    metadataValues(input.metadata, property).map((value) => ({ label, value })),
  );
  const filmSources = [
    ...(input.sourceAssociations ?? []),
    ...(input.sourceAssociations === undefined &&
    input.sourceAssociation !== undefined
      ? [input.sourceAssociation]
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
  const observedFiles = input.locations
    .filter((location) => location.kind === "observed")
    .map((location) => {
      const name = location.address.split(/[\\/]/u).at(-1) ?? "文件";
      const extension = /\.([^.]+)$/u.exec(name)?.[1]?.toUpperCase();
      const revisionId = currentRevisionId(input, location);
      const imageAssociation = input.artifactAssociations.find(
        (association) =>
          association.target.kind === "artifact-revision" &&
          association.role === "asset.material-image" &&
          association.observedArtifactPart?.artifactId ===
            location.artifactId &&
          association.target.artifactId === location.artifactId &&
          association.target.revisionId ===
            association.observedArtifactPart.revisionId &&
          input.artifactRevisions?.some(
            (revision) =>
              revision.id === association.observedArtifactPart?.revisionId &&
              revision.artifactId === location.artifactId,
          ),
      );
      const image = input.locations.find(
        (candidate) =>
          candidate.kind === "managed" &&
          candidate.artifactId === imageAssociation?.artifactId,
      )?.address;
      const artifactRevisions = (input.artifactRevisions ?? []).filter(
        (revision) => revision.artifactId === location.artifactId,
      );
      const revision = artifactRevisions.find(
        (candidate) => candidate.id === revisionId,
      );
      const byteLength =
        location.byteLength ??
        input.blobs?.find((blob) => blob.digest === revision?.blobDigest)
          ?.byteLength;
      return {
        name,
        format: extension ?? "文件",
        ...(revision === undefined ? {} : { revisionId: revision.id }),
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
  const bookIsbn13 = singleMetadata(input.metadata, "book.isbn-13");
  const bookPublisher = singleMetadata(input.metadata, "book.publisher");
  const bookPublicationDate = singleMetadata(
    input.metadata,
    "book.publication-date",
  );
  const filmAwards = singleMetadata(input.metadata, "asset.awards");
  const filmBoxOffice = singleMetadata(input.metadata, "asset.box-office");
  const firstObservedFile = observedFiles[0];
  const primarySourceLabel = sourceLabel(
    input.sourceAssociation?.sourceIdentity,
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
    ...(input.sourceAssociation === undefined
      ? {}
      : {
          officialPage: input.sourceAssociation.nativeAddress,
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
            attachments: fanboxAttachments(input.sourceArtifactCandidates),
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
              input.metadata,
              "asset.declared-language",
            ),
            classifications,
            credits: dlsiteCredits(input),
            fileTree: observedFileTree(input),
            ...(seriesName === undefined
              ? {}
              : {
                  series: {
                    name: seriesName,
                    ...(seriesPosition === undefined
                      ? {}
                      : { position: seriesPosition }),
                  },
                }),
          },
        }),
    ...(component !== "book"
      ? {}
      : {
          book: {
            title,
            ...(cover === undefined ? {} : { cover }),
            contributors: metadataValues(input.metadata, "book.contributor"),
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

function relationshipQualifier(
  input: AssetViewFacts,
  role: string,
  key: string,
): string | undefined {
  return input.relationships
    ?.find((relationship) =>
      relationship.participants.some(
        (participant) => participant.role === role,
      ),
    )
    ?.qualifiers?.find((qualifier) => qualifier.key === key)?.value;
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
  const bangumi: AssetViewFacts[] = [];
  const ordinary: AssetViewFacts[] = [];
  for (const fact of current) {
    (fact.sourceAssociation?.sourceIdentity === "bangumi"
      ? bangumi
      : ordinary
    ).push(fact);
  }
  return [
    ...projectBangumiCatalogue(bangumi),
    ...ordinary.map(projectAssetView),
  ];
}
