import { Hono } from "hono";
import type { Hono as HonoType } from "hono";

import {
  beginBangumiAuthorization,
  catalogueSurface,
  catalogueSnapshot,
  completeBangumiAuthorizationCallback,
  managedArtifactResponse,
  revokeBangumiAuthorization,
  startRefresh,
  updateAutomation,
  updatePreview,
} from "#/server/catalogue";

type ApiCommands = {
  readonly startRefresh: typeof startRefresh;
  readonly beginBangumiAuthorization: typeof beginBangumiAuthorization;
  readonly completeBangumiAuthorizationCallback: typeof completeBangumiAuthorizationCallback;
  readonly revokeBangumiAuthorization: typeof revokeBangumiAuthorization;
};

const defaultCommands: ApiCommands = {
  startRefresh,
  beginBangumiAuthorization,
  completeBangumiAuthorizationCallback,
  revokeBangumiAuthorization,
};

export function createApi(
  configuredCommands: Partial<ApiCommands> = {},
): HonoType {
  const commands: ApiCommands = { ...defaultCommands, ...configuredCommands };
  return new Hono()
    .get("/health", (c) => c.json({ ok: true, service: "digital-web" }))
    .get("/live", (c) => c.json({ ok: true, service: "digital-web" }))
    .get("/catalogue", async (c) => {
      try {
        return c.json(
          c.req.query("surface") === undefined
            ? await catalogueSnapshot({
                currentCatalogue: cataloguePageRequest(
                  c.req.query("catalogueCursor"),
                  c.req.query("catalogueLimit"),
                ),
                workflowHistory: cataloguePageRequest(
                  c.req.query("historyCursor"),
                  c.req.query("historyLimit"),
                ),
                currentAttention: cataloguePageRequest(
                  c.req.query("attentionCursor"),
                  c.req.query("attentionLimit"),
                ),
              })
            : await catalogueSurfaceRequest(
                c.req.query("surface"),
                c.req.query("cursor"),
                c.req.query("limit"),
              ),
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .get("/artifacts/:digest", async (c) => {
      try {
        const artifact = await managedArtifactResponse(c.req.param("digest"));
        const body = artifact.bytes.buffer.slice(
          artifact.bytes.byteOffset,
          artifact.bytes.byteOffset + artifact.bytes.byteLength,
        ) as ArrayBuffer;
        return new Response(body, {
          headers: {
            "content-type": artifact.mediaType,
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 404);
      }
    })
    .post("/refresh", async (c) => {
      try {
        return c.json(await commands.startRefresh(await c.req.json()), 201);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/source-connections/bangumi/authorize", (c) => {
      try {
        return c.json(commands.beginBangumiAuthorization(), 201);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .get("/source-connections/bangumi/callback", async (c) => {
      try {
        return c.json(
          await commands.completeBangumiAuthorizationCallback(c.req.url),
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/source-connections/bangumi/revoke", async (c) => {
      try {
        const expectedVersion = expectedSourceConnectionVersion(
          await c.req.json(),
        );
        return c.json(commands.revokeBangumiAuthorization(expectedVersion));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/automation", async (c) => {
      try {
        return c.json(await updateAutomation(await c.req.json()));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/preview", async (c) => {
      try {
        return c.json(await updatePreview(await c.req.json()));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    });
}

export const api: HonoType = createApi();

function cataloguePageRequest(
  cursor: string | undefined,
  limit: string | undefined,
) {
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  };
}

function catalogueSurfaceRequest(
  surface: string | undefined,
  cursor: string | undefined,
  limit: string | undefined,
) {
  if (surface === "automation") return catalogueSurface({ surface });
  if (
    surface === "current-catalogue" ||
    surface === "workflow-history" ||
    surface === "current-attention"
  ) {
    return catalogueSurface({
      surface,
      page: cataloguePageRequest(cursor, limit),
    });
  }
  throw new Error("未知内容目录 surface");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作暂时无法完成";
}

function expectedSourceConnectionVersion(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("来源连接版本无效");
  const expectedVersion = (value as { readonly expectedVersion?: unknown })
    .expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  )
    throw new Error("来源连接版本无效");
  return expectedVersion;
}
