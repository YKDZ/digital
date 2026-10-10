import { expect, test } from "@playwright/test";

import {
  asRecord,
  asRecords,
  confirmProductReady,
  loadHandoff,
  requestJson,
} from "./support/managed-service.ts";

const editedLibraryName = "受控夹具资产库已改名";

test("外部服务模式：确认目标产品真的就绪后，浏览器从同一服务读回已收录内容并再次发起刷新工作流", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const handoff = await loadHandoff();
  expect(handoff.mode).toBe("provided");

  await page.goto("/settings/automation");
  const ready = await confirmProductReady(page);
  expect(ready.status).toBe(200);
  expect(ready.body).toContain('"service":"digital-web"');

  const snapshot = asRecord(await requestJson(page, "/api/settings"));
  expect(snapshot.productDataDirectory).toBe(handoff.productDataRoot);
  const libraries = asRecords(snapshot.libraries);
  expect(libraries.length).toBeGreaterThan(0);
  const library = libraries.find(
    (item) => item.displayName === editedLibraryName,
  );
  expect(library).toBeDefined();
  const libraryId = String(library!.id);

  // 已收录内容确实由目标容器的真实 API 提供，而不是调用方自己的记录。
  await page.goto(`/?library=${encodeURIComponent(libraryId)}`);
  const catalogue = asRecord(
    await requestJson(
      page,
      `/api/catalogue?library=${encodeURIComponent(libraryId)}`,
    ),
  );
  const assets = asRecords(catalogue.assets);
  expect(assets.length).toBeGreaterThan(0);
  const subjectId = String(assets[0]!.id);
  const detail = asRecord(
    asRecord(
      await requestJson(
        page,
        `/api/catalogue/${encodeURIComponent(subjectId)}?library=${encodeURIComponent(libraryId)}`,
      ),
    ).asset,
  );
  const coverAddress =
    typeof detail.cover === "string" &&
    detail.cover.startsWith("/api/artifacts/")
      ? detail.cover
      : undefined;
  if (coverAddress === undefined)
    throw new Error("目标服务的已收录内容没有真实封面地址");
  const response = await page.evaluate(async (address) => {
    const result = await fetch(address);
    return {
      status: result.status,
      contentType: result.headers.get("content-type"),
      bytes: (await result.arrayBuffer()).byteLength,
    };
  }, coverAddress);
  expect(response.status).toBe(200);
  expect(response.contentType).toBe("image/png");
  expect(response.bytes).toBeGreaterThan(0);

  const [refreshResponse] = await Promise.all([
    page.waitForResponse(
      (result) => new URL(result.url()).pathname === "/api/refresh",
    ),
    page.goto("/settings/automation").then(async () => {
      await page.getByRole("button", { name: "扫描", exact: true }).click();
    }),
  ]);
  const execution = asRecord(await refreshResponse.json());
  const executionId = String(execution.id);
  await expect
    .poll(
      async () =>
        String(
          asRecord(await requestJson(page, `/api/executions/${executionId}`))
            .status,
        ),
      { timeout: 240_000 },
    )
    .toBe("completed");
  const finished = asRecord(
    await requestJson(page, `/api/executions/${executionId}`),
  );
  // 目标服务早已收录过这个目录：真实产品对重复扫描会给出 accepted 或 no-change，
  // 两者都是完成态；rejected/failed 才说明调用方连上的服务没在工作。
  expect(finished.status).toBe("completed");
  expect(["accepted", "no-change"]).toContain(String(finished.outcome));

  // 收尾属于提供方：调用方只确认真实就绪仍未被打断。
  const stillReady = await confirmProductReady(page);
  expect(stillReady.status).toBe(200);
});
