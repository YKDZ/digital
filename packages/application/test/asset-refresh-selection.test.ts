import { describe, expect, it } from "vitest";

import {
  assertAssetRefreshSelection,
  freezeAssetRefreshSelection,
} from "../src/index.ts";

describe("Asset Refresh Selection", () => {
  it("deduplicates exact targets while retaining every distinct explanation path", async () => {
    const observedRoot = {
      version: "observed-root-snapshot/1" as const,
      id: "library-root",
      configVersion: 1,
      containerPath: "/library",
      canonicalPath: "/library",
      readOnly: true as const,
      symlinkMode: "do-not-follow" as const,
      allowedTargetRootIds: [],
      authorizedTargetRoots: [],
    };
    const frozen = await freezeAssetRefreshSelection({
      version: "asset-refresh-selection/1",
      subjects: [
        {
          subjectId: "episode-b",
          explanations: [{ path: ["series", "season 2", "episode B"] }],
        },
        {
          subjectId: "episode-b",
          explanations: [{ path: ["recent", "episode B"] }],
        },
      ],
      filesystemScopes: [
        {
          root: "/library/series",
          observedRoot,
          relativeScope: "series",
          explanations: [{ path: ["filesystem", "series alias"] }],
        },
        {
          root: "/library/series",
          observedRoot,
          relativeScope: "series",
          explanations: [{ path: ["filesystem", "series"] }],
        },
      ],
    });

    expect(frozen).toEqual({
      version: "asset-refresh-selection/1",
      subjects: [
        {
          subjectId: "episode-b",
          explanations: [
            { path: ["recent", "episode B"] },
            { path: ["series", "season 2", "episode B"] },
          ],
        },
      ],
      filesystemScopes: [
        {
          root: "/library/series",
          observedRoot,
          relativeScope: "series",
          explanations: [
            { path: ["filesystem", "series alias"] },
            { path: ["filesystem", "series"] },
          ],
        },
      ],
    });
  });

  it("rejects a root-only persisted-looking scope from new workflow input", () => {
    expect(() =>
      assertAssetRefreshSelection({
        version: "asset-refresh-selection/1",
        subjects: [],
        filesystemScopes: [
          {
            root: "/library/legacy",
            explanations: [{ path: ["legacy", "root-only"] }],
          },
        ],
      }),
    ).toThrow("Asset Refresh Selection targets are invalid");
  });

  it("rejects a location spelling that is not derived from its frozen registered scope", () => {
    const observedRoot = {
      version: "observed-root-snapshot/1" as const,
      id: "library-root",
      configVersion: 1,
      containerPath: "/library",
      canonicalPath: "/library",
      readOnly: true as const,
      symlinkMode: "do-not-follow" as const,
      allowedTargetRootIds: [],
      authorizedTargetRoots: [],
    };

    expect(() =>
      assertAssetRefreshSelection({
        version: "asset-refresh-selection/1",
        subjects: [],
        filesystemScopes: [
          {
            root: "/another-registered-root/season-1",
            observedRoot,
            relativeScope: "season-1",
            explanations: [{ path: ["malformed", "location"] }],
          },
        ],
      }),
    ).toThrow("Asset Refresh Selection targets are invalid");
  });
});
