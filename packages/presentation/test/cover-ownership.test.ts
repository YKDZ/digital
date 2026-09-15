import { describe, expect, it } from "vitest";

import { projectAssetView } from "../src/index.ts";

describe("作品封面与文件图片归属", () => {
  it("只选择当前作品的有效封面，不让其他主体或普通附件补位", () => {
    const withoutOwnCover = projectAssetView({
      id: "audio-work",
      metadata: [{ property: "asset.title", value: "音声作品" }],
      artifactAssociations: [
        {
          target: { kind: "entity", entityId: "script-book" },
          artifactId: "script-page",
          role: "asset.primary-cover",
        },
        {
          target: {
            kind: "artifact-revision",
            artifactId: "script-pdf",
            revisionId: "script-revision",
          },
          artifactId: "script-page",
          role: "asset.material-image",
          observedArtifactPart: {
            artifactId: "script-pdf",
            revisionId: "script-revision",
            locator: "pdf:page[1]",
          },
        },
      ],
      artifactRevisions: [{ id: "script-revision", artifactId: "script-pdf" }],
      currentLocationRevisions: [
        { locationId: "script-pdf-location", revisionId: "script-revision" },
      ],
      locations: [
        {
          artifactId: "script-page",
          kind: "managed",
          address: "/managed/script.png",
        },
        {
          id: "script-pdf-location",
          artifactId: "script-pdf",
          kind: "observed",
          address: "/media/台本.pdf",
        },
      ],
    });

    expect(withoutOwnCover.cover).toBeUndefined();
    expect(withoutOwnCover.files).toEqual([
      {
        name: "台本.pdf",
        format: "PDF",
        revisionId: "script-revision",
        image: "/managed/script.png",
      },
    ]);

    const withOwnCover = projectAssetView({
      id: "audio-work",
      primaryCoverArtifactId: "official-cover",
      metadata: [],
      artifactAssociations: [
        ...withoutOwnCover.files!.flatMap(() => [
          {
            target: { kind: "entity", entityId: "other-work" },
            artifactId: "other-cover",
            role: "asset.primary-cover",
          },
        ]),
        {
          target: { kind: "entity", entityId: "audio-work" },
          artifactId: "official-cover",
          role: "asset.primary-cover",
        },
      ],
      locations: [
        {
          artifactId: "other-cover",
          kind: "managed",
          address: "/managed/other.jpg",
        },
        {
          artifactId: "official-cover",
          kind: "managed",
          address: "/managed/official.jpg",
        },
      ],
    });
    expect(withOwnCover.cover).toBe("/managed/official.jpg");
  });

  it("不把旧修订版的图片投影到当前文件", () => {
    const view = projectAssetView({
      id: "book",
      metadata: [],
      artifactAssociations: [
        {
          target: {
            kind: "artifact-revision",
            artifactId: "book-pdf",
            revisionId: "old-revision",
          },
          artifactId: "old-page",
          role: "asset.material-image",
          observedArtifactPart: {
            artifactId: "book-pdf",
            revisionId: "old-revision",
            locator: "pdf:page[1]",
          },
        },
      ],
      artifactRevisions: [{ id: "current-revision", artifactId: "book-pdf" }],
      currentLocationRevisions: [
        { locationId: "book-pdf-location", revisionId: "current-revision" },
      ],
      locations: [
        {
          id: "book-pdf-location",
          artifactId: "book-pdf",
          kind: "observed",
          address: "/media/book.pdf",
        },
        {
          artifactId: "old-page",
          kind: "managed",
          address: "/managed/old.png",
        },
      ],
    });

    expect(view.cover).toBeUndefined();
    expect(view.files).toEqual([
      {
        name: "book.pdf",
        format: "PDF",
        revisionId: "current-revision",
      },
    ]);
  });

  it("明确单文件承载整项内容时同一精确图片可同时服务作品与文件", () => {
    const view = projectAssetView({
      id: "single-book",
      primaryCoverArtifactId: "page-image",
      metadata: [],
      artifactAssociations: [
        {
          target: { kind: "entity", entityId: "single-book" },
          artifactId: "page-image",
          role: "asset.primary-cover",
        },
        {
          target: {
            kind: "artifact-revision",
            artifactId: "single-pdf",
            revisionId: "single-revision",
          },
          artifactId: "page-image",
          role: "asset.material-image",
          observedArtifactPart: {
            artifactId: "single-pdf",
            revisionId: "single-revision",
            locator: "pdf:page[1]",
          },
        },
      ],
      artifactRevisions: [{ id: "single-revision", artifactId: "single-pdf" }],
      currentLocationRevisions: [
        { locationId: "single-pdf-location", revisionId: "single-revision" },
      ],
      locations: [
        {
          id: "single-pdf-location",
          artifactId: "single-pdf",
          kind: "observed",
          address: "/media/single.pdf",
        },
        {
          artifactId: "page-image",
          kind: "managed",
          address: "/managed/single.png",
        },
      ],
    });

    expect(view.cover).toBe("/managed/single.png");
    expect(view.files).toEqual([
      {
        name: "single.pdf",
        format: "PDF",
        revisionId: "single-revision",
        image: "/managed/single.png",
      },
    ]);
  });
});
