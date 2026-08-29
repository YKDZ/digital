import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  catalogueReadinessFailure,
  createWebDelivery,
} from "@digital/web-delivery";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createWebServer } from "#/server/app";
import { processLifecycle } from "#/server/process-lifecycle";

import { prepareWebProductData } from "./prepare-catalogue";

describe("catalogue startup delivery gates", () => {
  it("injects one product application into Web delivery at the executable composition root", async () => {
    let configured: boolean | undefined;
    const app = createWebServer(
      { environment: {} },
      {
        attachVike: false,
        createDelivery(application) {
          configured = application.configured;
          return {
            api: new Hono(),
            catalogueReady: () => false,
            catalogueReadinessFailure: () => undefined,
            shutdown: async () => undefined,
            startCatalogueAutomation: async () => undefined,
          };
        },
      },
    );

    await expect(app.request("/api/live")).resolves.toMatchObject({
      status: 200,
    });
    expect(configured).toBe(false);
  });

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

  it("starts the newly bound product after the prior composition root closes in the same process", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-disposable-web-restart-"),
    );
    const productDataDirectory = path.join(root, "product-data");
    let closeReplacement: (() => Promise<void>) | undefined;
    try {
      await prepareWebProductData(productDataDirectory);
      const configuration = { productDataDirectory, environment: {} };
      let initialStart: Promise<void> | undefined;
      createWebServer(configuration, {
        attachVike: false,
        createDelivery(application) {
          const startAutomation = application.startAutomation.bind(application);
          vi.spyOn(application, "startAutomation").mockImplementation(
            async (options) => {
              initialStart = startAutomation(options);
              await initialStart;
            },
          );
          return createWebDelivery(application);
        },
      });
      await initialStart;

      const replacement = processLifecycle.register({
        async shutdown() {},
      });
      closeReplacement = async () => await replacement.dispose();
      await replacement.ready;

      let reboundStartCalls = 0;
      let reboundStart: Promise<void> | undefined;
      const rebound = createWebServer(configuration, {
        attachVike: false,
        createDelivery(application) {
          const startAutomation = application.startAutomation.bind(application);
          vi.spyOn(application, "startAutomation").mockImplementation(
            async (options) => {
              reboundStartCalls += 1;
              reboundStart = startAutomation(options);
              await reboundStart;
            },
          );
          return createWebDelivery(application);
        },
      });

      expect(reboundStartCalls).toBe(1);
      await reboundStart;
      await expect(rebound.request("/api/ready")).resolves.toMatchObject({
        status: 200,
      });
      await expect(rebound.request("/api/catalogue")).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      const closer = processLifecycle.register({
        async shutdown() {},
      });
      await closer.ready;
      await closer.dispose();
      await closeReplacement?.();
      await rm(root, { recursive: true, force: true });
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
    const app = createWebServer(
      { environment: {} },
      {
        api,
        startCatalogueAutomation: () => startup,
        catalogueReady: () => ready,
        attachVike: false,
        createDelivery() {
          return {
            api,
            catalogueReady: () => ready,
            catalogueReadinessFailure: () => undefined,
            shutdown: async () => undefined,
            startCatalogueAutomation: () => startup,
          };
        },
      },
    );

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
