import {
  requestCatalogue,
  type CatalogueSnapshot,
  type CatalogueSurfaceResponse,
} from "@digital/web-delivery/client";
import { afterEach, expect, it, vi } from "vitest";

import { useCatalogue } from "#/composables/use-catalogue";

function snapshot(input: {
  readonly assets?: readonly { readonly id: string }[];
  readonly executions?: readonly { readonly id: string }[];
  readonly attention?: readonly { readonly id: string }[];
  readonly catalogueCursor?: string;
  readonly historyCursor?: string;
  readonly attentionCursor?: string;
}): CatalogueSnapshot {
  return {
    configured: true,
    assets: input.assets ?? [],
    executions: input.executions ?? [],
    attention: input.attention ?? [],
    automation: [],
    observedRoots: [],
    pagination: {
      currentCatalogue:
        input.catalogueCursor === undefined
          ? {}
          : { nextCursor: input.catalogueCursor },
      workflowHistory:
        input.historyCursor === undefined
          ? {}
          : { nextCursor: input.historyCursor },
      currentAttention:
        input.attentionCursor === undefined
          ? {}
          : { nextCursor: input.attentionCursor },
    },
  } as unknown as CatalogueSnapshot;
}

afterEach(() => vi.unstubAllGlobals());

function emptySurfaceResponse(
  surface: CatalogueSurfaceResponse["surface"],
): CatalogueSurfaceResponse {
  if (surface === "current-catalogue")
    return { surface, configured: true, assets: [], pagination: {} };
  if (surface === "workflow-history")
    return { surface, configured: true, executions: [], pagination: {} };
  if (surface === "current-attention")
    return { surface, configured: true, attention: [], pagination: {} };
  return { surface, configured: true, automation: [] };
}

it("encodes three discriminated surface page requests", async () => {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const address =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const surface = new URL(
      address,
      "https://digital.invalid",
    ).searchParams.get("surface") as CatalogueSurfaceResponse["surface"];
    return new Response(JSON.stringify(emptySurfaceResponse(surface)), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetch);

  await requestCatalogue({
    surface: "current-catalogue",
    page: { cursor: "asset-c", limit: 7 },
  });
  await requestCatalogue({
    surface: "workflow-history",
    page: { cursor: "history-c", limit: 8 },
  });
  await requestCatalogue({
    surface: "current-attention",
    page: { cursor: "attention-c", limit: 9 },
  });

  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/catalogue?surface=current-catalogue&cursor=asset-c&limit=7",
    "/api/catalogue?surface=workflow-history&cursor=history-c&limit=8",
    "/api/catalogue?surface=current-attention&cursor=attention-c&limit=9",
  ]);
});

it("appends only the requested surface without resetting either sibling", async () => {
  const responses = [
    snapshot({
      assets: [{ id: "asset-1" }],
      executions: [{ id: "history-1" }],
      attention: [{ id: "attention-1" }],
      catalogueCursor: "asset-next",
      historyCursor: "history-next",
      attentionCursor: "attention-next",
    }),
    {
      surface: "current-catalogue",
      configured: true,
      assets: [{ id: "asset-2" }],
      pagination: {},
    },
    {
      surface: "workflow-history",
      configured: true,
      executions: [{ id: "history-2" }],
      pagination: {},
    },
    {
      surface: "current-attention",
      configured: true,
      attention: [{ id: "attention-2" }],
      pagination: {},
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(responses.shift()), { status: 200 }),
    ),
  );
  const state = useCatalogue();
  await state.reload();
  await state.loadMoreCatalogue();
  expect(state.catalogue.value.assets.map(({ id }) => id)).toEqual([
    "asset-1",
    "asset-2",
  ]);
  expect(state.catalogue.value.executions.map(({ id }) => id)).toEqual([
    "history-1",
  ]);
  expect(state.catalogue.value.attention.map(({ id }) => id)).toEqual([
    "attention-1",
  ]);
  expect(state.catalogue.value.pagination.workflowHistory.nextCursor).toBe(
    "history-next",
  );
  expect(state.catalogue.value.pagination.currentAttention.nextCursor).toBe(
    "attention-next",
  );

  await state.loadMoreHistory();
  expect(state.catalogue.value.executions.map(({ id }) => id)).toEqual([
    "history-1",
    "history-2",
  ]);
  expect(state.catalogue.value.assets.map(({ id }) => id)).toEqual([
    "asset-1",
    "asset-2",
  ]);
  expect(state.catalogue.value.attention.map(({ id }) => id)).toEqual([
    "attention-1",
  ]);
  expect(state.catalogue.value.pagination.currentAttention.nextCursor).toBe(
    "attention-next",
  );

  await state.loadMoreAttention();
  expect(state.catalogue.value.attention.map(({ id }) => id)).toEqual([
    "attention-1",
    "attention-2",
  ]);
  expect(state.catalogue.value.assets.map(({ id }) => id)).toEqual([
    "asset-1",
    "asset-2",
  ]);
  expect(state.catalogue.value.executions.map(({ id }) => id)).toEqual([
    "history-1",
    "history-2",
  ]);
});
