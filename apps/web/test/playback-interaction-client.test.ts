import { savePlaybackInteraction } from "@digital/web-delivery";
import { describe, expect, it, vi } from "vitest";

describe("playback interaction API client", () => {
  it("sends only exact revision interaction state and rejects a failed save", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      savePlaybackInteraction({
        revisionId: "revision-1",
        positionMilliseconds: 4_000,
        completed: false,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/playback-interactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revisionId: "revision-1",
        positionMilliseconds: 4_000,
        completed: false,
      }),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "播放交互状态无效" }, { status: 400 }),
      ),
    );
    await expect(
      savePlaybackInteraction({
        revisionId: "revision-1",
        positionMilliseconds: -1,
        completed: false,
      }),
    ).rejects.toThrow("播放交互状态无效");
  });
});
