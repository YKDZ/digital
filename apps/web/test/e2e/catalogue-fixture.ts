import type {
  AssetViewModel,
  BangumiSeriesViewModel,
} from "@digital/web-delivery/client";
import type { Page } from "@playwright/test";

type AssetFixture =
  | (Pick<AssetViewModel, "id" | "title"> & Partial<AssetViewModel>)
  | BangumiSeriesViewModel;
export type CatalogueFixture = {
  readonly configured: boolean;
  readonly assets: readonly AssetFixture[];
  readonly executions: readonly unknown[];
  readonly automation: readonly unknown[];
  readonly observedRoots?: readonly {
    readonly id: string;
    readonly displayName: string;
  }[];
};

export async function mockCataloguePage(
  page: Page,
  catalogue: CatalogueFixture,
) {
  const assets = catalogue.assets.map(
    (asset): AssetViewModel | BangumiSeriesViewModel =>
      "component" in asset
        ? asset
        : {
            refreshTarget: { subjectId: asset.id },
            cardComponent: "generic",
            detailComponent: "generic",
            available: true,
            classifications: [],
            relationships: [],
            ...asset,
          },
  );
  await page.route("**/api/catalogue**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/catalogue/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/api/catalogue/".length),
      );
      const asset = assets.find(
        (item) =>
          item.id === id ||
          ("works" in item &&
            item.episodes.some((episode) => episode.assetId === id)),
      );
      await route.fulfill(
        asset === undefined
          ? { status: 404, json: { error: "未找到内容" } }
          : {
              json: {
                asset,
                ...("works" in asset && asset.id !== id
                  ? { selectedEpisodeId: id }
                  : {}),
              },
            },
      );
    } else if (url.searchParams.get("surface") === "current-catalogue") {
      await route.fulfill({
        json: {
          surface: "current-catalogue",
          configured: catalogue.configured,
          assets,
          total: assets.length,
          categories: [],
          pagination: {},
        },
      });
    } else await route.fulfill({ json: { ...catalogue, assets } });
  });
  await page.route("**/api/intake**", async (route) => {
    const url = new URL(route.request().url());
    const roots = catalogue.observedRoots ?? [];
    const rootId = url.searchParams.get("rootId") ?? roots[0]?.id;
    const executionId = url.searchParams.get("executionId");
    await route.fulfill({
      json: {
        roots,
        ...(rootId === undefined ? {} : { rootId }),
        files: [],
        contents: [],
        ...(executionId === null
          ? {}
          : {
              execution: {
                id: executionId,
                folder: "示例文件位置",
                intent: "scan-now",
                status: "completed",
                outcome: "no-change",
                dispositions: [],
              },
            }),
      },
    });
  });
}
