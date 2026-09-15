import { projectAssetView } from "@digital/presentation";
import { describe, expect, it } from "vitest";

describe("formal asset view", () => {
  it("projects current and proposed asset facts into the same natural view", () => {
    const view = projectAssetView({
      id: "asset-1",
      sourceAssociation: {
        nativeAddress: "https://example.test/posts/1",
      },
      metadata: [
        { property: "asset.title", value: "作品标题" },
        { property: "asset.summary", value: "摘要" },
        { property: "asset.body", value: "正文" },
        {
          property: "asset.publication-datetime",
          value: "2025-01-01T00:00:00Z",
        },
      ],
      currentRelatedEntities: [
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
          participants: [{ entityId: "creator", role: "fanbox.post.creator" }],
          type: "asset.contribution",
        },
      ],
      artifactAssociations: [
        {
          target: { kind: "entity", entityId: "asset-1" },
          artifactId: "cover",
          role: "asset.primary-cover",
        },
      ],
      primaryCoverArtifactId: "cover",
      locations: [
        { artifactId: "cover", kind: "managed", address: "/managed/cover.jpg" },
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
      sourceAssociation: {
        sourceIdentity: "fanbox",
        nativeAddress: "https://www.fanbox.cc/@customudon/posts/9135862",
      },
      metadata: [
        { property: "asset.title", value: "年始の挨拶" },
        {
          property: "asset.publication-datetime",
          value: "2025-01-01T00:11:17+09:00",
        },
        { property: "asset.body", value: "本文" },
        { property: "fanbox.post.entitlement", value: "available" },
        { property: "fanbox.post.like-count", value: "1030" },
        { property: "fanbox.post.comment-count", value: "89" },
      ],
      sourceArtifactCandidates: [
        {
          sourceRecordId: "detail",
          role: "fanbox.attachment.file",
          mediaType: "video/mp4",
          selectionEvidence: {
            suggestedFilename: "bonus.mp4",
            declaredByteLength: 42,
            sourceOrdinal: 0,
          },
        },
      ],
      currentRelatedEntities: [
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
          participants: [{ entityId: "creator", role: "fanbox.post.creator" }],
          type: "asset.contribution",
        },
      ],
      artifactAssociations: [],
      locations: [
        {
          artifactId: "poster",
          kind: "observed",
          address: "/library/post/poster.jpg",
          byteLength: 10,
          downloadUrl: "/download/poster",
        },
        {
          artifactId: "video",
          kind: "observed",
          address: "/library/post/video/bonus.mp4",
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
      sourceAssociation: {
        sourceIdentity: "dlsite",
        nativeAddress:
          "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
      },
      metadata: [
        { property: "asset.title", value: "音声作品" },
        { property: "asset.release-date", value: "2026-07-17" },
        { property: "asset.introduction", value: "紹介文" },
        { property: "asset.declared-language", value: "JPN" },
        { property: "dlsite.product.price-jpy", value: "0" },
      ],
      currentRelatedEntities: [
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
          participants: [{ entityId: "circle", role: "circle" }],
          type: "asset.contribution",
        },
        {
          participants: [{ entityId: "voice", role: "voice" }],
          type: "asset.contribution",
        },
        {
          participants: [{ entityId: "series", role: "dlsite.series.member" }],
          type: "asset.membership",
          qualifiers: [{ key: "asset.membership.position", value: "2" }],
        },
      ],
      artifactAssociations: [
        {
          target: { kind: "entity", entityId: "asset-dlsite" },
          artifactId: "cover",
          role: "asset.primary-cover",
        },
      ],
      primaryCoverArtifactId: "cover",
      locations: [
        { artifactId: "cover", kind: "managed", address: "/managed/cover.jpg" },
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
        series: { name: "シリーズ", position: "2" },
      },
    });
  });

  it("projects a book shelf and detail payload from generic accepted facts", () => {
    const view = projectAssetView({
      id: "asset-book",
      sourceAssociation: {
        sourceIdentity: "nbinet",
        nativeAddress:
          "https://nbinet.primo.exlibrisgroup.com/discovery/search?q=isbn%2Cexact%2C9789864738281",
      },
      metadata: [
        { property: "asset.title", value: "幼女战记(1)" },
        { property: "asset.declared-language", value: "zh" },
        { property: "book.contributor", value: "Carlo Zen 東條チカ" },
        { property: "book.isbn-13", value: "9789864738281" },
        { property: "book.publisher", value: "臺灣角川" },
        { property: "book.publication-date", value: "2017" },
      ],
      artifactAssociations: [
        {
          target: { kind: "entity", entityId: "asset-book" },
          artifactId: "cover",
          role: "asset.primary-cover",
        },
      ],
      primaryCoverArtifactId: "cover",
      locations: [
        { artifactId: "cover", kind: "managed", address: "/managed/cover.jpg" },
        {
          artifactId: "epub",
          kind: "observed",
          address: "/observed/幼女战记(1).epub",
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
