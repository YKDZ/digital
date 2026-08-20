import type {
  EffectiveMetadata,
  InformationRequirement,
} from "@digital/application";
import * as v from "valibot";

export type { InformationRequirement } from "@digital/application";

import {
  type BangumiSeriesViewModel,
  projectBangumiCatalogue,
} from "./bangumi.js";
import { nameSchema } from "./name-schema.js";

export * from "./asset-refresh-selection.js";
export * from "./bangumi.js";

export type Greeting = { message: string };

export function greet(name: string): Greeting {
  return { message: `Hello, ${v.parse(nameSchema, name)}` };
}

/** The general Asset View's complete, delivery-neutral information demand. */
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
  artifactRoles: [{ role: "asset.primary-cover", necessity: "optional" }],
  relationshipTypes: [
    { type: "asset.*", necessity: "optional" },
    { type: "bangumi.subject.related", necessity: "optional" },
  ],
};

/** Information the Book View actually consumes; source/provider remains open. */
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
  artifactRoles: [{ role: "asset.primary-cover", necessity: "optional" }],
  relationshipTypes: [],
};

/** Information the Film View consumes; source/provider remains open. */
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
 * The DLsite Asset View's whole delivery-independent input declaration.
 *
 * This is intentionally owned by the View boundary rather than its card,
 * detail, file-tree, or delivery route.  Application sees only these open
 * fact coordinates and the ordinary effective-metadata usage context.
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
    { property: "asset.series-position", necessity: "optional" },
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
 * The formal General Asset View's consumer-facing shape.  Its source input is
 * deliberately structural: Application supplies neutral facts, while this
 * bounded context chooses the names, groupings, and omissions a consumer sees.
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

export type AssetViewModel = {
  readonly id: string;
  /** Exact delivery subject; the server resolves mutable scope/designation. */
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
  readonly available: boolean;
  readonly officialPage?: string;
  readonly sourceLabel?: string;
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
    readonly files: readonly {
      readonly name: string;
      readonly format: string;
    }[];
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
  /** Every current Source Association; one may still be recognition provenance. */
  readonly sourceAssociations?: readonly {
    readonly sourceIdentity?: string;
    readonly nativeAddress: string;
  }[];
  /** @deprecated Use sourceAssociations; retained for existing source Views. */
  readonly sourceAssociation?: {
    readonly sourceIdentity?: string;
    readonly nativeAddress: string;
  };
  /**
   * Effective Metadata selected for this View's usage context. Presentation
   * receives selected values, not an unordered bag of source assertions.
   */
  readonly metadata: readonly (Pick<EffectiveMetadata, "property" | "value"> & {
    readonly subjectId?: string;
    readonly sourceSlot?: string;
  })[];
  readonly entities?: readonly {
    readonly id: string;
    readonly label: string;
    readonly sourceIdentity?: string;
    readonly identityNamespace?: string;
    readonly sourceKey?: string;
  }[];
  readonly relationships?: readonly {
    readonly subjectId?: string;
    readonly participantId: string;
    readonly type: string;
    readonly role: string;
  }[];
  readonly artifactAssociations: readonly {
    readonly subjectId?: string;
    readonly artifactId: string;
    readonly role: string;
  }[];
  readonly locations: readonly {
    readonly artifactId: string;
    readonly kind: "managed" | "observed";
    readonly address: string;
  }[];
};

export type CatalogueViewModel = AssetViewModel | BangumiSeriesViewModel;

function firstMetadata(
  metadata: AssetViewFacts["metadata"],
  property: string,
): string | undefined {
  return metadata.find((item) => item.property === property)?.value;
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
 * Presentation owns component dispatch and therefore the complete requirement
 * authority for that component. Delivery never asks Application for a global
 * union of every View's optional data.
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
  if (input.metadata.some((item) => item.property === "book.isbn-13"))
    return "book";
  return "generic";
}

/**
 * Resolves the one complete requirement of the presentation selected from
 * current facts. Generic, FANBOX, and Bangumi presentation use the general
 * view declaration until each owns a more specific requirement.
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
    (input.entities ?? []).map((entity) => [entity.id, entity.label]),
  );
  return (input.relationships ?? []).flatMap((relationship) => {
    if (relationship.role !== role) return [];
    const label = entities.get(relationship.participantId);
    return label === undefined ? [] : [label];
  });
}

function firstRelationshipLabel(
  input: AssetViewFacts,
  role: string,
): string | undefined {
  return relationshipLabels(input, role)[0];
}

function fanboxAttachments(
  metadata: AssetViewFacts["metadata"],
): readonly { readonly name?: string; readonly byteLength?: string }[] {
  const byKey = new Map<string, { name?: string; byteLength?: string }>();
  const keyFor = (item: AssetViewFacts["metadata"][number]) =>
    /^fanbox\.post\.attachment:([^:]+):/u.exec(item.sourceSlot ?? "")?.[1] ??
    `${item.property}:${byKey.size}`;
  for (const item of metadata) {
    if (
      item.property !== "fanbox.attachment.name" &&
      item.property !== "fanbox.attachment.byte-length"
    )
      continue;
    const key = keyFor(item);
    const current = byKey.get(key) ?? {};
    byKey.set(
      key,
      item.property === "fanbox.attachment.name"
        ? { ...current, name: item.value }
        : { ...current, byteLength: item.value },
    );
  }
  return [...byKey.values()];
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
 * Projects applied facts and proposed facts through one view.  Role strings
 * remain evidence vocabulary and never cross this consumer boundary.
 */
export function projectAssetView(input: AssetViewFacts): AssetViewModel {
  const component = assetViewComponent(input);
  const coverAssociation = input.artifactAssociations.find(
    (association) => association.role === "asset.primary-cover",
  );
  const cover = input.locations.find(
    (location) =>
      location.artifactId === coverAssociation?.artifactId &&
      location.kind === "managed",
  )?.address;
  const entities = new Map(
    (input.entities ?? []).map((entity) => [entity.id, entity.label]),
  );
  const relationships = (input.relationships ?? []).flatMap((relationship) => {
    const label = entities.get(relationship.participantId);
    if (label === undefined) return [];
    return [
      {
        heading:
          relationship.type === "asset.contribution" ? "参与者" : "相关内容",
        label,
      } as const,
    ];
  });
  const title = firstMetadata(input.metadata, "asset.title") ?? "未命名内容";
  const releaseDate = firstMetadata(input.metadata, "asset.release-date");
  const publicationDateTime = firstMetadata(
    input.metadata,
    "asset.publication-datetime",
  );
  const introduction = firstMetadata(input.metadata, "asset.introduction");
  const summary = firstMetadata(input.metadata, "asset.summary");
  const body = firstMetadata(input.metadata, "asset.body");
  const language = firstMetadata(input.metadata, "asset.declared-language");
  const classifications = metadataValues(
    input.metadata,
    "asset.content-classification",
  );
  const fanboxEntitlement = firstMetadata(
    input.metadata,
    "fanbox.post.entitlement",
  );
  const fanboxCreator = firstRelationshipLabel(input, "fanbox.post.creator");
  const fanboxLikeCount = firstMetadata(
    input.metadata,
    "fanbox.post.like-count",
  );
  const fanboxCommentCount = firstMetadata(
    input.metadata,
    "fanbox.post.comment-count",
  );
  const dlsiteCircle = firstRelationshipLabel(input, "circle");
  const dlsitePriceJpy = firstMetadata(
    input.metadata,
    "dlsite.product.price-jpy",
  );
  const seriesName = firstRelationshipLabel(input, "dlsite.series.member");
  const seriesPosition = firstMetadata(input.metadata, "asset.series-position");
  const runtimeMinutes = firstMetadata(input.metadata, "asset.runtime-minutes");
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
      return { name, format: extension ?? "文件" };
    });
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
    ...(cover === undefined ? {} : { cover }),
    available: input.locations.some((location) => location.kind === "observed"),
    ...(input.sourceAssociation === undefined
      ? {}
      : {
          officialPage: input.sourceAssociation.nativeAddress,
          sourceLabel: sourceLabel(input.sourceAssociation.sourceIdentity),
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
            attachments: fanboxAttachments(input.metadata),
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
            ...(firstMetadata(input.metadata, "book.isbn-13") === undefined
              ? {}
              : { isbn13: firstMetadata(input.metadata, "book.isbn-13") }),
            ...(firstMetadata(input.metadata, "book.publisher") === undefined
              ? {}
              : { publisher: firstMetadata(input.metadata, "book.publisher") }),
            ...(firstMetadata(input.metadata, "book.publication-date") ===
            undefined
              ? {}
              : {
                  publicationDate: firstMetadata(
                    input.metadata,
                    "book.publication-date",
                  ),
                }),
            ...(language === undefined ? {} : { language }),
            ...(observedFiles[0] === undefined
              ? {}
              : { format: observedFiles[0].format }),
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
            ...(firstMetadata(input.metadata, "asset.awards") === undefined
              ? {}
              : { awards: firstMetadata(input.metadata, "asset.awards") }),
            ...(firstMetadata(input.metadata, "asset.box-office") === undefined
              ? {}
              : {
                  boxOffice: firstMetadata(input.metadata, "asset.box-office"),
                }),
            sources: filmSources,
          },
        }),
  };
}

/**
 * Owns catalogue partition and View Component dispatch. Delivery receives
 * ready-to-render Presentation models and never groups by provider identity.
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
