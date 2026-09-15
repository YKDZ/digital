import { describe, expect, it } from "vitest";

import { projectCatalogue } from "../src/index";

describe("Book View", () => {
  it("没有 ISBN 的本地出版资料仍可按书籍浏览，未知内容不补造类别", () => {
    const views = projectCatalogue([
      {
        id: "local-book",
        metadata: [
          { property: "asset.title", value: "本地书籍" },
          { property: "book.contributor", value: "作者" },
        ],
        artifactAssociations: [],
        locations: [],
      },
      { id: "unknown", metadata: [], artifactAssociations: [], locations: [] },
    ]);
    expect(views[0]).toMatchObject({
      cardComponent: "book",
      book: { contributors: ["作者"] },
    });
    expect(views[0]).not.toHaveProperty("book.isbn13");
    expect(views[1]).toMatchObject({ cardComponent: "generic" });
  });
  it("dispatches generic accepted book facts through one book component", () => {
    const [view] = projectCatalogue([
      {
        id: "book-asset",
        primaryCoverArtifactId: "cover",
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
            target: { kind: "entity", entityId: "book-asset" },
            artifactId: "cover",
            role: "asset.primary-cover",
          },
        ],
        locations: [
          {
            artifactId: "cover",
            kind: "managed",
            address: "/managed/cover.jpg",
          },
          {
            artifactId: "epub",
            kind: "observed",
            address: "/observed/幼女战记(1).epub",
          },
        ],
      },
    ]);

    expect(view).toMatchObject({
      id: "book-asset",
      cardComponent: "book",
      detailComponent: "book",
      refreshTarget: { subjectId: "book-asset" },
      officialPage: expect.stringContaining("9789864738281"),
      book: {
        title: "幼女战记(1)",
        cover: "/managed/cover.jpg",
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
