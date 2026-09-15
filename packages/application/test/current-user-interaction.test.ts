import { describe, expect, it } from "vitest";

import {
  CurrentUserPlaybackInteraction,
  type CurrentUserInteractionPersistence,
} from "../src/current-user-interaction.ts";

describe("current user playback interaction", () => {
  it("keeps position and completion on the exact artifact revision", async () => {
    const states = new Map<
      string,
      { positionMilliseconds: number; completed: boolean }
    >();
    const persistence: CurrentUserInteractionPersistence = {
      async readPlaybackInteractions(revisionIds) {
        return revisionIds.flatMap((artifactRevisionId) => {
          const state = states.get(artifactRevisionId);
          return state === undefined ? [] : [{ artifactRevisionId, ...state }];
        });
      },
      async savePlaybackInteraction(input) {
        states.set(input.artifactRevisionId, {
          positionMilliseconds: input.positionMilliseconds,
          completed: input.completed,
        });
      },
    };
    const interactions = new CurrentUserPlaybackInteraction(persistence);

    await interactions.save({
      artifactRevisionId: "revision-old",
      positionMilliseconds: 12_000,
      completed: true,
    });

    await expect(interactions.read(["revision-new"])).resolves.toEqual([]);
    await expect(interactions.read(["revision-old"])).resolves.toEqual([
      {
        artifactRevisionId: "revision-old",
        positionMilliseconds: 12_000,
        completed: true,
      },
    ]);
  });
});
