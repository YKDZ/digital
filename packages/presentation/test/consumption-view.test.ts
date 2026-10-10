import { describe, expect, it } from "vitest";

import { projectAssetView } from "../src/index";
import { entityDescription, viewFacts, viewLocation } from "./view-facts.ts";

describe("detail consumption projections", () => {
  it("gives every confirmed observed file its exact revision for download and playback selection", () => {
    // 一个产物可有多份修订版；当前读取只在精确位置上声明「当前内容是哪一份」，
    // 展示层据此给出可播放/可下载的精确修订版，绝不把该产物的其它修订版也算进来。
    const view = projectAssetView(
      viewFacts({
        id: "ordinary",
        descriptions: [
          entityDescription("ordinary", [["asset.title", "普通文件"]]),
        ],
        locations: [
          viewLocation({
            id: "song",
            artifactId: "audio",
            kind: "observed",
            address: "/music/song.mp3",
            confirmedRevisionId: "revision-mp3",
          }),
        ],
      }),
    );

    expect(view.files).toEqual([
      { name: "song.mp3", format: "MP3", revisionId: "revision-mp3" },
    ]);
  });

  it("keeps DLsite delivery directories and exact playable revisions in a presentation file tree", () => {
    const view = projectAssetView(
      viewFacts({
        id: "dlsite-work",
        sourceAssociations: [
          { sourceIdentity: "dlsite", nativeAddress: "dlsite:RJ1" },
        ],
        descriptions: [
          entityDescription("dlsite-work", [["asset.title", "作品"]]),
        ],
        locations: [
          viewLocation({
            id: "track-a-location",
            artifactId: "track-a",
            kind: "observed",
            address: "/media/work/CD1/01.mp3",
            confirmedRevisionId: "revision-a",
          }),
          viewLocation({
            id: "track-b-location",
            artifactId: "track-b",
            kind: "observed",
            address: "/media/work/CD2/02.mp3",
            confirmedRevisionId: "revision-b",
          }),
        ],
      }),
    );

    expect(view.dlsite?.fileTree).toEqual([
      {
        name: "CD1",
        children: [{ name: "01.mp3", format: "MP3", revisionId: "revision-a" }],
      },
      {
        name: "CD2",
        children: [{ name: "02.mp3", format: "MP3", revisionId: "revision-b" }],
      },
    ]);
  });

  it("projects FANBOX attachment kinds without turning the source role into a UI field", () => {
    const view = projectAssetView(
      viewFacts({
        id: "fanbox-post",
        sourceAssociations: [
          {
            sourceIdentity: "fanbox",
            nativeAddress: "https://www.fanbox.cc/@creator/posts/1",
          },
        ],
        descriptions: [
          entityDescription("fanbox-post", [["asset.title", "帖子"]]),
        ],
        sourceArtifacts: [
          {
            role: "fanbox.attachment.image",
            mediaType: "image/jpeg",
            selectionEvidence: {
              suggestedFilename: "插图.jpg",
              declaredByteLength: 42,
              sourceOrdinal: 0,
            },
          },
          {
            role: "fanbox.attachment.file",
            mediaType: "application/zip",
            selectionEvidence: {
              suggestedFilename: "附件.zip",
              sourceOrdinal: 1,
            },
          },
        ],
      }),
    );

    expect(view.fanbox?.attachments).toEqual([
      { kind: "image", name: "插图.jpg", byteLength: "42" },
      { kind: "file", name: "附件.zip" },
    ]);
    expect(JSON.stringify(view)).not.toContain("fanbox.attachment.");
  });
});
