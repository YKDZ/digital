import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AssetRefreshWorkflow,
  CurrentUserPlaybackInteraction,
} from "@digital/application";
import { runProduct } from "@digital/composition";
import type { AssetViewFacts } from "@digital/presentation";
import { createWebDelivery } from "@digital/web-delivery";
import { describe, expect, it, vi } from "vitest";

const facts: AssetViewFacts = {
  id: "detail-subject",
  sourceAssociations: [],
  descriptions: [],
  relatedEntities: [],
  relationships: [],
  locations: [
    {
      id: "detail-location",
      artifactId: "detail-artifact",
      kind: "observed",
      address: "/managed/clip.wav",
      content: {
        status: "confirmed",
        target: {
          kind: "artifact-revision",
          artifactId: "detail-artifact",
          revisionId: "detail-revision",
        },
      },
    },
  ],
};

describe("catalogue detail playback interaction", () => {
  it.each([true, false])(
    "reads the exact current revision with saved interaction=%s",
    async (saved) => {
      vi.spyOn(
        AssetRefreshWorkflow.prototype,
        "inspectCurrentCatalogueSubject",
      ).mockResolvedValue(facts);
      vi.spyOn(
        AssetRefreshWorkflow.prototype,
        "fulfillInformation",
      ).mockImplementation(async ({ requirement }) => ({
        requirement,
        subjects: [],
      }));
      vi.spyOn(
        AssetRefreshWorkflow.prototype,
        "inspectRetryableSourceEnrichments",
      ).mockResolvedValue([]);
      vi.spyOn(
        AssetRefreshWorkflow.prototype,
        "assetLibraryIdsOwningSubject",
      ).mockResolvedValue([]);
      const interactions = vi
        .spyOn(CurrentUserPlaybackInteraction.prototype, "read")
        .mockResolvedValue(
          saved
            ? [
                {
                  artifactRevisionId: "detail-revision",
                  positionMilliseconds: 90_210,
                  completed: false,
                },
              ]
            : [],
        );
      // 当前事实与用户状态沿既有 Application 读取端口提供；不扫描或创建内容。
      const product = runProduct(
        {
          productDataDirectory: path.join(tmpdir(), randomUUID()),
          environment: {},
        },
        {
          start: (application) => {
            vi.spyOn(
              application,
              "observedFileDownloadForLocation",
            ).mockResolvedValue(undefined);
            return createWebDelivery(application);
          },
        },
      );
      try {
        const response = await product.result.api.request(
          "/catalogue/detail-subject",
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.asset.files).toHaveLength(1);
        expect(body.asset.files[0].revisionId).toBe("detail-revision");
        if (saved)
          expect(body.asset.files[0].interaction).toEqual({
            positionMilliseconds: 90_210,
            completed: false,
          });
        else expect(body.asset.files[0]).not.toHaveProperty("interaction");
        expect(interactions).toHaveBeenCalledWith(["detail-revision"]);
      } finally {
        await product.close();
        vi.restoreAllMocks();
      }
    },
  );
});
