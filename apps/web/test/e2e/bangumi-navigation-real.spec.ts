import { runProduct } from "@digital/composition";
import {
  createWebDelivery,
  type BangumiSeriesViewModel,
} from "@digital/web-delivery";
import { expect, test } from "@playwright/test";

const productDataDirectory =
  process.env.DIGITAL_BANGUMI_NAVIGATION_PRODUCT_DATA;

test.skip(
  productDataDirectory === undefined,
  "需要由验收运行提供可写的真实产品数据副本",
);

test("真实番剧投影保留季深链、精确单集和返回季", async ({ page }) => {
  const product = runProduct(
    { productDataDirectory: productDataDirectory!, environment: {} },
    { start: createWebDelivery },
  );
  try {
    const catalogueResponse = await product.result.api.request("/catalogue");
    expect(catalogueResponse.ok).toBe(true);
    const catalogue = (await catalogueResponse.json()) as {
      readonly assets: readonly BangumiSeriesViewModel[];
    };
    const seriesCandidates = catalogue.assets.filter(
      (asset) => asset.component === "bangumi",
    );
    const detailCandidates = await Promise.all(
      seriesCandidates.map(async (candidate) => {
        const detailResponse = await product.result.api.request(
          `/catalogue/${encodeURIComponent(candidate.id)}`,
        );
        expect(detailResponse.ok).toBe(true);
        return (await detailResponse.json()) as {
          readonly asset: BangumiSeriesViewModel;
        };
      }),
    );
    const series = detailCandidates
      .map((detail) => detail.asset)
      .find(
        (asset) =>
          asset.works.length >= 2 &&
          asset.works.some((work) =>
            work.episodes.some(
              (episode) => episode.localPosition !== episode.continuousPosition,
            ),
          ),
      );
    expect(series).toBeDefined();
    if (series === undefined) return;

    const secondWork = series.works.find((work) =>
      work.episodes.some(
        (episode) => episode.localPosition !== episode.continuousPosition,
      ),
    );
    expect(secondWork).toBeDefined();
    if (secondWork === undefined) return;
    const pressureEpisode = secondWork.episodes.find(
      (episode) => episode.localPosition !== episode.continuousPosition,
    );
    expect(pressureEpisode).toBeDefined();
    if (pressureEpisode === undefined) return;

    await page.route(/\/api\//u, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      url.pathname = url.pathname.replace(/^\/api/u, "");
      const response = await product.result.api.request(url.toString(), {
        method: request.method(),
        headers: request.headers(),
        ...(request.postData() === null ? {} : { body: request.postData()! }),
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });

    const seriesPath = `/series/${encodeURIComponent(series.id)}`;
    const selectedSeasonPath = `${seriesPath}?season=${encodeURIComponent(secondWork.id)}`;
    await page.goto(selectedSeasonPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(
      secondWork.episodes.length,
    );
    await page.reload();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(
      secondWork.episodes.length,
    );

    await page.goto(seriesPath, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: secondWork.title }).click();
    await expect(page).toHaveURL(selectedSeasonPath);
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(
      secondWork.episodes.length,
    );
    await page.reload();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(
      secondWork.episodes.length,
    );
    await page.goBack();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(
      series.works[0]!.episodes.length,
    );
    await page.goForward();
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(
      secondWork.episodes.length,
    );

    const episode = page
      .getByTestId("bangumi-episode-card")
      .filter({ hasText: `第 ${pressureEpisode.localPosition} 集` });
    await expect(episode).toHaveCount(1);
    await expect(episode).toHaveAttribute(
      "href",
      `/assets/${encodeURIComponent(pressureEpisode.assetId)}`,
    );
    await episode.click();
    await expect(page).toHaveURL(
      `/assets/${encodeURIComponent(pressureEpisode.assetId)}`,
    );
    await expect(page.getByTestId("bangumi-episode-detail")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("bangumi-episode-detail")).toBeVisible();
    await expect(
      page.getByText(`连续第 ${pressureEpisode.continuousPosition} 集`),
    ).toBeVisible();
    const returnLink = page.getByRole("link", {
      name: `返回${secondWork.title}`,
    });
    await expect(returnLink).toHaveAttribute("href", selectedSeasonPath);
    await returnLink.click();
    await expect(page).toHaveURL(selectedSeasonPath);
    await expect(page.getByTestId("bangumi-episode-card")).toHaveCount(
      secondWork.episodes.length,
    );
  } finally {
    await product.close();
  }
});
