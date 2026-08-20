import type { AssetRefreshWorkflow } from "@digital/application";
import { describe, expect, it } from "vitest";

import { resolveAssetRefreshSelection } from "../src/index.ts";

describe("Asset Refresh Selection resolver", () => {
  it("resolves a synthetic parent and explicit multi-selection without losing repeated subject paths", () => {
    const shared = {
      key: "episode-b",
      label: "Episode B",
      subjectId: "episode-b",
      children: [],
    };
    const season = {
      key: "season",
      label: "Season 1",
      children: [
        {
          key: "episode-a",
          label: "Episode A",
          subjectId: "episode-a",
          children: [],
        },
        shared,
      ],
    };
    const recent = {
      key: "recent",
      label: "Recent",
      children: [shared],
    };

    const selection = resolveAssetRefreshSelection([season, recent]);

    expect(selection.subjects).toEqual([
      {
        subjectId: "episode-a",
        explanations: [{ path: ["Season 1", "Episode A"] }],
      },
      {
        subjectId: "episode-b",
        explanations: [
          { path: ["Season 1", "Episode B"] },
          { path: ["Recent", "Episode B"] },
        ],
      },
    ]);
  });

  it("rejects a cycle in the explicit projection", () => {
    const parent: {
      key: string;
      label: string;
      children: unknown[];
    } = {
      key: "parent",
      label: "Parent",
      children: [],
    };
    parent.children.push(parent);

    expect(() => resolveAssetRefreshSelection([parent])).toThrow(
      "Asset Refresh projection contains a cycle",
    );
  });

  it("passes a resolved multi-subject selection directly to Application", async () => {
    const collected: string[] = [];
    const collectors = new Map([
      ["episode-a", async () => collected.push("episode-a")],
      ["episode-b", async () => collected.push("episode-b")],
    ]);
    const workflow = {
      async refreshMetadata(input) {
        for (const target of input.selection.subjects) {
          await collectors.get(target.subjectId)?.();
        }
        return {
          execution: {
            targetDispositions: input.selection.subjects.map((target) => ({
              key: `subject:${target.subjectId}`,
              target: { kind: "subject" as const, subjectId: target.subjectId },
              status: "completed" as const,
            })),
          },
        } as Awaited<ReturnType<AssetRefreshWorkflow["refreshMetadata"]>>;
      },
    } satisfies Pick<AssetRefreshWorkflow, "refreshMetadata">;
    const selection = resolveAssetRefreshSelection([
      {
        key: "season",
        label: "Season 1",
        children: [
          {
            key: "episode-a",
            label: "Episode A",
            subjectId: "episode-a",
            children: [],
          },
          {
            key: "episode-b",
            label: "Episode B",
            subjectId: "episode-b",
            children: [],
          },
        ],
      },
    ]);

    const result = await workflow.refreshMetadata({ selection });

    expect(collected).toEqual(["episode-a", "episode-b"]);
    expect(result.execution.targetDispositions).toEqual([
      expect.objectContaining({
        target: { kind: "subject", subjectId: "episode-a" },
      }),
      expect.objectContaining({
        target: { kind: "subject", subjectId: "episode-b" },
      }),
    ]);
  });
});
