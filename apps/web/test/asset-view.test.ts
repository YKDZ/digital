import type { EffectiveDescriptionRead } from "@digital/application";
import { projectAssetView } from "@digital/presentation";
import { describe, expect, it } from "vitest";

const acceptedDescription = (
  entityId: string,
  properties: readonly (readonly [string, string])[],
  artifactRoles: EffectiveDescriptionRead["artifactRoles"] = [],
): EffectiveDescriptionRead => ({
  target: { kind: "entity", entityId },
  metadataUsageContext: "asset.ordinary",
  metadataScope: { kind: "all-available" },
  metadata: properties.map(([property, value]) => ({
    property,
    result: {
      status: "resolved",
      values: [
        {
          property,
          value,
          sourceIdentity: "test",
          sourceSlot: property,
          reasoning: { kind: "unranked-source-assertion" },
          assertions: [
            {
              target: { kind: "entity", entityId },
              sourceSlot: property,
              sourceRecordIds: ["record-1"],
            },
          ],
          sourceRecordIds: ["record-1"],
        },
      ],
    },
  })),
  missingArtifactRoles: [],
  conflicts: [],
  artifactRoles,
});

const primaryCover = (
  entityId: string,
  artifactId: string,
  address: string,
): EffectiveDescriptionRead["artifactRoles"][number] => ({
  role: "asset.primary-cover",
  artifactId,
  associationIds: [`association-${entityId}-${artifactId}`],
  address,
});

describe("formal asset view", () => {
  it("projects current and proposed asset facts into the same natural view", () => {
    const view = projectAssetView({
      id: "asset-1",
      sourceAssociations: [
        {
          sourceIdentity: "example",
          nativeAddress: "https://example.test/posts/1",
        },
      ],
      descriptions: [
        acceptedDescription(
          "asset-1",
          [
            ["asset.title", "作品标题"],
            ["asset.summary", "摘要"],
            ["asset.body", "正文"],
            ["asset.publication-datetime", "2025-01-01T00:00:00Z"],
          ],
          [primaryCover("asset-1", "cover", "/managed/cover.jpg")],
        ),
      ],
      relatedEntities: [
        {
          id: "creator",
          label: "创作者",
          kind: { status: "ordinary" },
          sourceIdentity: "test",
          sourceKey: "creator",
          identityNamespace: "test.creator",
        },
      ],
      relationships: [
        {
          id: "relationship-1",
          sourceRecordIds: ["record-1"],
          participants: [
            { entityId: "asset-1", role: "asset" },
            { entityId: "creator", role: "fanbox.post.creator" },
          ],
          type: "asset.contribution",
        },
      ],
      locations: [
        {
          id: "location-cover",
          artifactId: "cover",
          kind: "managed",
          address: "/managed/cover.jpg",
          content: { status: "unconfirmed" },
        },
      ],
    });

    expect(view).toMatchObject({
      id: "asset-1",
      cardComponent: "generic",
      detailComponent: "generic",
      title: "作品标题",
      summary: "摘要",
      body: "正文",
      publicationDateTime: "2025-01-01T00:00:00Z",
      cover: "/managed/cover.jpg",
      relationships: [{ heading: "参与者", label: "创作者" }],
    });
    expect(JSON.stringify(view)).not.toContain("fanbox.post.creator");
  });

  it("projects a FANBOX view payload without exposing source role vocabulary", () => {
    const view = projectAssetView({
      id: "asset-fanbox",
      sourceAssociations: [
        {
          sourceIdentity: "fanbox",
          nativeAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
        },
      ],
      descriptions: [
        acceptedDescription("asset-fanbox", [
          ["asset.title", "年始の挨拶"],
          ["asset.publication-datetime", "2025-01-01T00:11:17+09:00"],
          ["asset.body", "本文"],
          ["fanbox.post.entitlement", "available"],
          ["fanbox.post.like-count", "1030"],
          ["fanbox.post.comment-count", "89"],
        ]),
      ],
      sourceArtifacts: [
        {
          role: "fanbox.attachment.file",
          mediaType: "video/mp4",
          selectionEvidence: {
            suggestedFilename: "bonus.mp4",
            declaredByteLength: 42,
            sourceOrdinal: 0,
          },
        },
      ],
      relatedEntities: [
        {
          id: "creator",
          label: "Custom_Udon",
          kind: { status: "ordinary" },
          sourceIdentity: "test",
          sourceKey: "creator",
          identityNamespace: "test.creator",
        },
      ],
      relationships: [
        {
          id: "relationship-1",
          sourceRecordIds: ["record-1"],
          participants: [
            { entityId: "asset-fanbox", role: "asset" },
            { entityId: "creator", role: "fanbox.post.creator" },
          ],
          type: "asset.contribution",
        },
      ],
      locations: [
        {
          id: "location-poster",
          artifactId: "poster",
          kind: "observed",
          address: "/library/post/poster.jpg",
          content: { status: "unconfirmed" },
          byteLength: 10,
          downloadUrl: "/download/poster",
        },
        {
          id: "location-video",
          artifactId: "video",
          kind: "observed",
          address: "/library/post/video/bonus.mp4",
          content: { status: "unconfirmed" },
          byteLength: 42,
          downloadUrl: "/download/video",
        },
      ],
    });

    expect(view).toMatchObject({
      cardComponent: "fanbox",
      detailComponent: "fanbox",
      fileTree: [
        {
          name: "poster.jpg",
          format: "JPG",
          byteLength: 10,
          downloadUrl: "/download/poster",
        },
        {
          name: "video",
          children: [
            {
              name: "bonus.mp4",
              format: "MP4",
              byteLength: 42,
              downloadUrl: "/download/video",
            },
          ],
        },
      ],
      fanbox: {
        title: "年始の挨拶",
        creator: "Custom_Udon",
        body: "本文",
        hasOfficialCover: false,
        entitlement: "available",
        likeCount: "1030",
        commentCount: "89",
        attachments: [{ name: "bonus.mp4", byteLength: "42" }],
      },
    });
    expect(JSON.stringify(view)).not.toContain("fanbox.post.creator");
  });

  it("projects a DLsite view payload with source-specific display grouping", () => {
    const view = projectAssetView({
      id: "asset-dlsite",
      sourceAssociations: [
        {
          sourceIdentity: "dlsite",
          nativeAddress:
            "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
        },
      ],
      descriptions: [
        acceptedDescription(
          "asset-dlsite",
          [
            ["asset.title", "音声作品"],
            ["asset.release-date", "2026-07-17"],
            ["asset.introduction", "紹介文"],
            ["asset.declared-language", "JPN"],
            ["dlsite.product.price-jpy", "0"],
          ],
          [primaryCover("asset-dlsite", "cover", "/managed/cover.jpg")],
        ),
      ],
      relatedEntities: [
        {
          id: "circle",
          label: "サークル",
          kind: { status: "ordinary" },
          sourceIdentity: "test",
          sourceKey: "circle",
          identityNamespace: "test.circle",
        },
        {
          id: "voice",
          label: "声優",
          kind: { status: "ordinary" },
          sourceIdentity: "test",
          sourceKey: "voice",
          identityNamespace: "test.voice",
        },
        {
          id: "series",
          label: "シリーズ",
          kind: { status: "ordinary" },
          sourceIdentity: "test",
          sourceKey: "series",
          identityNamespace: "test.series",
        },
      ],
      relationships: [
        {
          id: "relationship-circle",
          sourceRecordIds: ["record-1"],
          participants: [
            { entityId: "asset-dlsite", role: "asset" },
            { entityId: "circle", role: "circle" },
          ],
          type: "asset.contribution",
        },
        {
          id: "relationship-voice",
          sourceRecordIds: ["record-1"],
          participants: [
            { entityId: "asset-dlsite", role: "asset" },
            { entityId: "voice", role: "voice" },
          ],
          type: "asset.contribution",
        },
        {
          id: "relationship-series",
          sourceRecordIds: ["record-1"],
          participants: [
            { entityId: "asset-dlsite", role: "asset" },
            { entityId: "series", role: "dlsite.series.member" },
          ],
          type: "asset.membership",
          qualifiers: [{ key: "asset.membership.position", value: "2" }],
        },
      ],
      locations: [
        {
          id: "location-cover",
          artifactId: "cover",
          kind: "managed",
          address: "/managed/cover.jpg",
          content: { status: "unconfirmed" },
        },
      ],
    });

    expect(view).toMatchObject({
      cardComponent: "dlsite",
      detailComponent: "dlsite",
      dlsite: {
        title: "音声作品",
        circle: "サークル",
        priceJpy: "0",
        languages: ["JPN"],
        credits: [{ heading: "配音", names: ["声優"] }],
        series: [{ name: "シリーズ", position: "2" }],
      },
    });
  });

  it("projects a book shelf and detail payload from generic accepted facts", () => {
    const view = projectAssetView({
      id: "asset-book",
      sourceAssociations: [
        {
          sourceIdentity: "nbinet",
          nativeAddress:
            "https://nbinet.primo.exlibrisgroup.com/discovery/search?q=isbn%2Cexact%2C9789864738281",
        },
      ],
      descriptions: [
        acceptedDescription(
          "asset-book",
          [
            ["asset.title", "幼女战记(1)"],
            ["asset.declared-language", "zh"],
            ["book.isbn-13", "9789864738281"],
            ["book.publisher", "臺灣角川"],
            ["book.publication-date", "2017"],
          ],
          [primaryCover("asset-book", "cover", "/managed/cover.jpg")],
        ),
      ],
      relatedEntities: [
        {
          id: "contributor",
          label: "Carlo Zen 東條チカ",
          kind: { status: "ordinary" },
          sourceIdentity: "nbinet",
          sourceKey: "contributor",
          identityNamespace: "nbinet.contributor",
        },
      ],
      relationships: [
        {
          id: "relationship-contributor",
          sourceRecordIds: ["record-1"],
          participants: [
            { entityId: "asset-book", role: "asset" },
            { entityId: "contributor", role: "book.contributor" },
          ],
          type: "asset.contribution",
        },
      ],
      locations: [
        {
          id: "location-cover",
          artifactId: "cover",
          kind: "managed",
          address: "/managed/cover.jpg",
          content: { status: "unconfirmed" },
        },
        {
          id: "location-epub",
          artifactId: "epub",
          kind: "observed",
          address: "/observed/幼女战记(1).epub",
          content: { status: "unconfirmed" },
        },
      ],
    });

    expect(view).toMatchObject({
      cardComponent: "book",
      detailComponent: "book",
      book: {
        title: "幼女战记(1)",
        contributors: ["Carlo Zen 東條チカ"],
        isbn13: "9789864738281",
        publisher: "臺灣角川",
        publicationDate: "2017",
        language: "zh",
        format: "EPUB",
        files: [{ name: "幼女战记(1).epub", format: "EPUB" }],
      },
    });
  });
});
