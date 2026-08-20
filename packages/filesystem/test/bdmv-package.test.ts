import { describe, expect, it } from "vitest";

import { BdmvFilesystemPackageInterpreter } from "../src/index.ts";

const snapshot = (
  files: readonly string[],
  directories: readonly string[],
) => ({
  id: "snapshot",
  root: "/library/movie",
  complete: true,
  files: files.map((relativePath) => ({
    relativePath,
    size: 1,
    modifiedAt: "2026-07-31T00:00:00.000Z",
  })),
  directories: directories.map((relativePath) => ({
    relativePath,
    modifiedAt: "2026-07-31T00:00:00.000Z",
  })),
  excluded: [],
  observedAt: "2026-07-31T00:00:00.000Z",
});

describe("BDMV filesystem package parser", () => {
  it("identifies only a complete BDMV root as one filesystem-package Artifact boundary", () => {
    const interpreter = new BdmvFilesystemPackageInterpreter();

    expect(
      interpreter.interpretPackage(
        snapshot(
          [
            "BDMV/index.bdmv",
            "BDMV/MovieObject.bdmv",
            "BDMV/PLAYLIST/00000.mpls",
            "BDMV/STREAM/00000.m2ts",
          ],
          [".", "BDMV", "BDMV/PLAYLIST", "BDMV/STREAM"],
        ),
      ),
    ).toEqual({ observedArtifactBoundary: "filesystem-package" });
    expect(
      interpreter.interpretPackage(snapshot(["movie.mkv"], ["."])),
    ).toBeUndefined();
    expect(
      interpreter.interpretPackage(
        snapshot(
          ["BDMV/index.bdmv", "BDMV/STREAM/00000.m2ts"],
          [".", "BDMV", "BDMV/STREAM"],
        ),
      ),
    ).toBeUndefined();
  });
});
