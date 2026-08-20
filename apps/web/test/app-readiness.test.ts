import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createApp } from "#/server/app";
import { catalogueReadinessFailure } from "#/server/catalogue";

describe("catalogue startup delivery gates", () => {
  it("gives an actionable, path-free readiness reason when product data is not configured", () => {
    const previous = process.env.DIGITAL_PRODUCT_DATA;
    delete process.env.DIGITAL_PRODUCT_DATA;
    try {
      expect(catalogueReadinessFailure()).toContain("DIGITAL_PRODUCT_DATA");
      expect(catalogueReadinessFailure()).not.toContain("/");
    } finally {
      if (previous === undefined) delete process.env.DIGITAL_PRODUCT_DATA;
      else process.env.DIGITAL_PRODUCT_DATA = previous;
    }
  });

  it("answers liveness immediately, keeps readiness and business admission closed while recovery waits, then admits after recovery", async () => {
    let releaseStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    let ready = false;
    let catalogueCalls = 0;
    const api = new Hono().get("/catalogue", (context) => {
      catalogueCalls += 1;
      return context.json({ catalogue: true });
    });
    const app = createApp({
      api,
      startCatalogueAutomation: () => startup,
      catalogueReady: () => ready,
      attachVike: false,
    });

    await expect(app.request("/api/live")).resolves.toMatchObject({
      status: 200,
    });
    await expect(app.request("/api/ready")).resolves.toMatchObject({
      status: 503,
    });
    const pendingBusiness = app.request("/api/catalogue");
    await Promise.resolve();
    expect(catalogueCalls).toBe(0);

    releaseStartup();
    await expect(pendingBusiness).resolves.toMatchObject({ status: 503 });
    expect(catalogueCalls).toBe(0);
    ready = true;
    await expect(app.request("/api/ready")).resolves.toMatchObject({
      status: 200,
    });
    await expect(app.request("/api/catalogue")).resolves.toMatchObject({
      status: 200,
    });
    expect(catalogueCalls).toBe(1);
  });
});
