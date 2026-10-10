import { describe, expect, it } from "vitest";

import { projectAssetView } from "../src/index.ts";
import {
  entityDescription,
  revisionDescription,
  viewFacts,
  viewLocation,
} from "./view-facts.ts";

describe("作品封面与文件图片归属", () => {
  it("只选择当前作品的有效封面，不让其他主体或普通附件补位", () => {
    const withoutOwnCover = projectAssetView(
      viewFacts({
        id: "audio-work",
        descriptions: [
          entityDescription("audio-work", [["asset.title", "音声作品"]]),
          entityDescription(
            "script-book",
            [],
            [["asset.primary-cover", "script-page", "/managed/script.png"]],
          ),
          revisionDescription(
            "script-pdf",
            "script-revision",
            [],
            [["asset.material-image", "script-page", "/managed/script.png"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "script-page-location",
            artifactId: "script-page",
            kind: "managed",
            address: "/managed/script.png",
          }),
          viewLocation({
            id: "script-pdf-location",
            artifactId: "script-pdf",
            kind: "observed",
            address: "/media/台本.pdf",
            confirmedRevisionId: "script-revision",
          }),
        ],
      }),
    );

    expect(withoutOwnCover.cover).toBeUndefined();
    expect(withoutOwnCover.files).toEqual([
      {
        name: "台本.pdf",
        format: "PDF",
        revisionId: "script-revision",
        image: "/managed/script.png",
      },
    ]);

    const withOwnCover = projectAssetView(
      viewFacts({
        id: "audio-work",
        descriptions: [
          entityDescription(
            "audio-work",
            [],
            [
              [
                "asset.primary-cover",
                "official-cover",
                "/managed/official.jpg",
              ],
            ],
          ),
          entityDescription(
            "other-work",
            [],
            [["asset.primary-cover", "other-cover", "/managed/other.jpg"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "other-cover-location",
            artifactId: "other-cover",
            kind: "managed",
            address: "/managed/other.jpg",
          }),
          viewLocation({
            id: "official-cover-location",
            artifactId: "official-cover",
            kind: "managed",
            address: "/managed/official.jpg",
          }),
        ],
      }),
    );
    expect(withOwnCover.cover).toBe("/managed/official.jpg");
  });

  it("不把旧修订版的图片投影到当前文件", () => {
    const view = projectAssetView(
      viewFacts({
        id: "book",
        descriptions: [
          revisionDescription(
            "book-pdf",
            "old-revision",
            [],
            [["asset.material-image", "old-page", "/managed/old.png"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "book-pdf-location",
            artifactId: "book-pdf",
            kind: "observed",
            address: "/media/book.pdf",
            confirmedRevisionId: "current-revision",
          }),
          viewLocation({
            id: "old-page-location",
            artifactId: "old-page",
            kind: "managed",
            address: "/managed/old.png",
          }),
        ],
      }),
    );

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
    const view = projectAssetView(
      viewFacts({
        id: "single-book",
        descriptions: [
          entityDescription(
            "single-book",
            [],
            [["asset.primary-cover", "page-image", "/managed/single.png"]],
          ),
          revisionDescription(
            "single-pdf",
            "single-revision",
            [],
            [["asset.material-image", "page-image", "/managed/single.png"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "single-pdf-location",
            artifactId: "single-pdf",
            kind: "observed",
            address: "/media/single.pdf",
            confirmedRevisionId: "single-revision",
          }),
          viewLocation({
            id: "page-image-location",
            artifactId: "page-image",
            kind: "managed",
            address: "/managed/single.png",
          }),
        ],
      }),
    );

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
