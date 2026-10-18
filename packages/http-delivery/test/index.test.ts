import type { ProductApplication } from "@digital/product-application";
import { expect, it } from "vitest";

import { createPublicHttpApi } from "../src/index.ts";

it("keeps application failures unavailable for asset and unrecognized reads", async () => {
  for (const [path, method] of [
    ["/assets", "listCurrentCataloguePage"],
    ["/unrecognized-materials", "listUnrecognizedLibraryScanObservationPage"],
  ] as const) {
    const workflow = {
      assetLibraries: { get: async () => undefined },
      [method]: async () => {
        throw new Error("catalogue storage failure");
      },
    };
    const application = { workflow } as unknown as ProductApplication;
    const response = await createPublicHttpApi(application).request(path);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unavailable" },
    });
  }
});
