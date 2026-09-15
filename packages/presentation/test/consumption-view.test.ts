import { describe, expect, it } from "vitest";

import { projectAssetView } from "../src/index";

describe("detail consumption projections", () => {
  it("gives every confirmed observed file its exact revision for download and playback selection", () => {
    const view = projectAssetView({
      id: "ordinary",
      metadata: [{ property: "asset.title", value: "普通文件" }],
      artifactAssociations: [],
      artifactRevisions: [
        { id: "revision-old", artifactId: "audio" },
        { id: "revision-mp3", artifactId: "audio" },
      ],
      currentLocationRevisions: [
        { locationId: "song", revisionId: "revision-mp3" },
      ],
      locations: [
        {
          id: "song",
          artifactId: "audio",
          kind: "observed",
          address: "/music/song.mp3",
        },
      ],
    });

    expect(view.files).toEqual([
      { name: "song.mp3", format: "MP3", revisionId: "revision-mp3" },
    ]);
  });

  it("keeps DLsite delivery directories and exact playable revisions in a presentation file tree", () => {
    const view = projectAssetView({
      id: "dlsite-work",
      sourceAssociation: {
        sourceIdentity: "dlsite",
        nativeAddress: "dlsite:RJ1",
      },
      metadata: [{ property: "asset.title", value: "作品" }],
      artifactAssociations: [],
      artifactRevisions: [
        { id: "revision-a", artifactId: "track-a" },
        { id: "revision-b", artifactId: "track-b" },
      ],
      currentLocationRevisions: [
        { locationId: "track-a-location", revisionId: "revision-a" },
        { locationId: "track-b-location", revisionId: "revision-b" },
      ],
      locations: [
        {
          id: "track-a-location",
          artifactId: "track-a",
          kind: "observed",
          address: "/media/work/CD1/01.mp3",
        },
        {
          id: "track-b-location",
          artifactId: "track-b",
          kind: "observed",
          address: "/media/work/CD2/02.mp3",
        },
      ],
    });

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
    const view = projectAssetView({
      id: "fanbox-post",
      sourceAssociation: {
        sourceIdentity: "fanbox",
        nativeAddress: "https://www.fanbox.cc/@creator/posts/1",
      },
      metadata: [{ property: "asset.title", value: "帖子" }],
      sourceArtifactCandidates: [
        {
          sourceRecordId: "record",
          role: "fanbox.attachment.image",
          mediaType: "image/jpeg",
          selectionEvidence: {
            suggestedFilename: "插图.jpg",
            declaredByteLength: 42,
            sourceOrdinal: 0,
          },
        },
        {
          sourceRecordId: "record",
          role: "fanbox.attachment.file",
          mediaType: "application/zip",
          selectionEvidence: {
            suggestedFilename: "附件.zip",
            sourceOrdinal: 1,
          },
        },
      ],
      artifactAssociations: [],
      locations: [],
    });

    expect(view.fanbox?.attachments).toEqual([
      { kind: "image", name: "插图.jpg", byteLength: "42" },
      { kind: "file", name: "附件.zip" },
    ]);
  });
});
