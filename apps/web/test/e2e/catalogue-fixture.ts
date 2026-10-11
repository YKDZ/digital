import type {
  AssetViewModel,
  BangumiSeriesViewModel,
  ExecutionViewModel,
} from "@digital/web-delivery/client";
import type { Page } from "@playwright/test";

type AssetFixture =
  | (Pick<AssetViewModel, "id" | "title"> & Partial<AssetViewModel>)
  | BangumiSeriesViewModel;
/**
 * 夹具里的一条刷新记录：必填字段与交付 DTO 对齐，其余可选字段沿用 DTO 形状，
 * 因此建议视图的当前/建议资产必须本身就是可展示的完整视图。
 */
type ExecutionFixture = Pick<
  ExecutionViewModel,
  "id" | "folder" | "intent" | "status" | "dispositions"
> &
  Omit<
    Partial<ExecutionViewModel>,
    "id" | "folder" | "intent" | "status" | "dispositions"
  >;
export type CatalogueFixture = {
  readonly configured: boolean;
  readonly assets: readonly AssetFixture[];
  readonly executions: readonly ExecutionFixture[];
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
  /**
   * 记录详情页会按记录号单独请求执行投影，因此这里给出同一条记录的完整视图；
   * 未登记的记录按现行接口返回 404，不回退到列表里的其它记录。
   */
  await page.route("**/api/executions/*", async (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.slice("/api/executions/".length),
    );
    const record = catalogue.executions.find((item) => item.id === id);
    await route.fulfill(
      record === undefined
        ? { status: 404, json: { error: "未找到该刷新记录" } }
        : { json: record },
    );
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
