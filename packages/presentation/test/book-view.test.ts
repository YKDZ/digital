import { describe, expect, it } from "vitest";

import { projectCatalogue } from "../src/index";
import {
  entityDescription,
  relatedEntity,
  viewFacts,
  viewLocation,
  viewRelationship,
} from "./view-facts.ts";

describe("Book View", () => {
  it("没有 ISBN 的本地出版资料仍可按书籍浏览，未知内容不补造类别", () => {
    // 现行契约把「这是书」的分派依据与「谁参与」的展示依据分开：
    // book.contributor 属性坐标仍足以分派到书籍视图，署名本身来自当前参与关系。
    const views = projectCatalogue([
      viewFacts({
        id: "local-book",
        descriptions: [
          entityDescription("local-book", [
            ["asset.title", "本地书籍"],
            ["book.contributor", "作者"],
          ]),
        ],
        relatedEntities: [
          relatedEntity({
            id: "local-contributor",
            label: "作者",
            sourceIdentity: "library",
            identityNamespace: "library.contributor",
            sourceKey: "local-contributor",
          }),
        ],
        relationships: [
          viewRelationship("contribution-local-book", "asset.contribution", [
            ["local-book", "asset"],
            ["local-contributor", "book.contributor"],
          ]),
        ],
      }),
      viewFacts({ id: "unknown" }),
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
      viewFacts({
        id: "book-asset",
        recognitionSourceAssociation: {
          sourceIdentity: "nbinet",
          nativeAddress:
            "https://nbinet.primo.exlibrisgroup.com/discovery/search?q=isbn%2Cexact%2C9789864738281",
        },
        sourceAssociations: [
          {
            sourceIdentity: "nbinet",
            nativeAddress:
              "https://nbinet.primo.exlibrisgroup.com/discovery/search?q=isbn%2Cexact%2C9789864738281",
          },
        ],
        descriptions: [
          entityDescription(
            "book-asset",
            [
              ["asset.title", "幼女战记(1)"],
              ["asset.declared-language", "zh"],
              ["book.isbn-13", "9789864738281"],
              ["book.publisher", "臺灣角川"],
              ["book.publication-date", "2017"],
            ],
            [["asset.primary-cover", "cover", "/managed/cover.jpg"]],
          ),
        ],
        relatedEntities: [
          relatedEntity({
            id: "book-contributor",
            label: "Carlo Zen 東條チカ",
            sourceIdentity: "nbinet",
            identityNamespace: "nbinet.contributor",
            sourceKey: "book-contributor",
          }),
        ],
        relationships: [
          viewRelationship("contribution-book-asset", "asset.contribution", [
            ["book-asset", "asset"],
            ["book-contributor", "book.contributor"],
          ]),
        ],
        locations: [
          viewLocation({
            id: "cover-location",
            artifactId: "cover",
            kind: "managed",
            address: "/managed/cover.jpg",
          }),
          viewLocation({
            id: "epub-location",
            artifactId: "epub",
            kind: "observed",
            address: "/observed/幼女战记(1).epub",
          }),
        ],
      }),
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
