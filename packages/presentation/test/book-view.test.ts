import { describe, expect, it } from "vitest";

import { projectCatalogue } from "../src/index.ts";

describe("Book View", () => {
  it("dispatches generic accepted book facts through one book component", () => {
    const [view] = projectCatalogue([
      {
        id: "book-asset",
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
          { artifactId: "cover", role: "asset.primary-cover" },
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
