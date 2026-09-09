import { Hono } from "hono";
import type { Hono as HonoType } from "hono";

import {
  beginBangumiAuthorization,
  catalogueSurface,
  catalogueSnapshot,
  catalogueSubject,
  completeBangumiAuthorizationCallback,
  artifactDownloadResponse,
  artifactDeliveryErrorResponse,
  confirmedObservedArtifactDownloadResponse,
  managedArtifactResponse,
  playbackMediaResponse,
  playbackPlanResponse,
  revokeBangumiAuthorization,
  startRefresh,
  updateAutomation,
  updatePreview,
  settingsSnapshot,
  updateSettingsRoot,
  updateSettingsConnection,
  intakeSnapshot,
  updateIntake,
  inspectIntakeContent,
  sourceInputRequirements,
  startSourceEnrichment,
  inspectSourceEnrichment,
  startSourceAssociationDecision,
  inspectSourceAssociationDecision,
  inspectCorrectionSubject,
  selectSourceAssociationDecisionCandidate,
  retrySourceAssociationDecision,
  startRecognitionRetraction,
  startObservedMaterialAssociation,
  inspectObservedMaterialAssociation,
  confirmObservedMaterialAssociation,
} from "./web-delivery.ts";

type ApiCommands = {
  readonly startRefresh: typeof startRefresh;
  readonly beginBangumiAuthorization: typeof beginBangumiAuthorization;
  readonly completeBangumiAuthorizationCallback: typeof completeBangumiAuthorizationCallback;
  readonly revokeBangumiAuthorization: typeof revokeBangumiAuthorization;
  readonly startSourceAssociationDecision: typeof startSourceAssociationDecision;
  readonly inspectSourceAssociationDecision: typeof inspectSourceAssociationDecision;
  readonly inspectCorrectionSubject: typeof inspectCorrectionSubject;
  readonly selectSourceAssociationDecisionCandidate: typeof selectSourceAssociationDecisionCandidate;
  readonly retrySourceAssociationDecision: typeof retrySourceAssociationDecision;
  readonly startRecognitionRetraction: typeof startRecognitionRetraction;
  readonly updatePreview: typeof updatePreview;
};

const defaultCommands: ApiCommands = {
  startRefresh,
  beginBangumiAuthorization,
  completeBangumiAuthorizationCallback,
  revokeBangumiAuthorization,
  startSourceAssociationDecision,
  inspectSourceAssociationDecision,
  inspectCorrectionSubject,
  selectSourceAssociationDecisionCandidate,
  retrySourceAssociationDecision,
  startRecognitionRetraction,
  updatePreview,
};

export function createApi(
  configuredCommands: Partial<ApiCommands> = {},
): HonoType {
  const commands: ApiCommands = { ...defaultCommands, ...configuredCommands };
  return new Hono()
    .get("/intake", async (c) => {
      try {
        return c.json(
          await intakeSnapshot({
            ...(c.req.query("rootId") === undefined
              ? {}
              : { rootId: c.req.query("rootId")! }),
            ...(c.req.query("executionId") === undefined
              ? {}
              : { executionId: c.req.query("executionId")! }),
          }),
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .get("/intake/reviews/:id", async (c) => {
      try {
        return c.json(await inspectIntakeContent(c.req.param("id")));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/intake", async (c) => {
      try {
        return c.json(await updateIntake(await c.req.json()));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/settings/connections", async (c) => {
      try {
        return c.json(await updateSettingsConnection(await c.req.json()));
      } catch {
        return c.json(
          { error: "来源操作未完成，请检查连接信息或刷新后重试" },
          400,
        );
      }
    })
    .get("/settings", async (c) => {
      try {
        return c.json(await settingsSnapshot());
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/settings/roots", async (c) => {
      try {
        return c.json(await updateSettingsRoot(await c.req.json()));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
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
                c.req.query("q"),
                c.req.query("category"),
                c.req.query("sort"),
              ),
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .get("/catalogue/:subjectId", async (c) => {
      try {
        const subject = await catalogueSubject(c.req.param("subjectId"));
        return subject === undefined
          ? c.json({ error: "未找到内容" }, 404)
          : c.json(subject);
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
    .get("/observed-file-downloads/:selectionId", async (c) => {
      try {
        return await confirmedObservedArtifactDownloadResponse(
          c.req.param("selectionId"),
          c.req.raw,
        );
      } catch (error) {
        return artifactDeliveryErrorResponse(error);
      }
    })
    .get("/artifact-downloads/:revisionId", async (c) => {
      try {
        return await artifactDownloadResponse(
          c.req.param("revisionId"),
          c.req.raw,
        );
      } catch (error) {
        return artifactDeliveryErrorResponse(error);
      }
    })
    .post("/playback-plans/:revisionId", async (c) => {
      try {
        return c.json(
          await playbackPlanResponse(
            c.req.param("revisionId"),
            await c.req.json(),
          ),
        );
      } catch (error) {
        return artifactDeliveryErrorResponse(error);
      }
    })
    .get("/playback-media/:revisionId/:blobDigest", async (c) => {
      try {
        return await playbackMediaResponse(
          c.req.param("revisionId"),
          c.req.param("blobDigest"),
          c.req.raw,
        );
      } catch (error) {
        return artifactDeliveryErrorResponse(error);
      }
    })
    .post("/refresh", async (c) => {
      try {
        return c.json(await commands.startRefresh(await c.req.json()), 201);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .get("/source-inputs", (c) => c.json(sourceInputRequirements()))
    .get("/source-enrichments/:id", async (c) => {
      try {
        const result = await inspectSourceEnrichment(c.req.param("id"));
        return result === undefined
          ? c.json({ error: "未找到来源补充记录" }, 404)
          : c.json(result);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/source-enrichments", async (c) => {
      try {
        return c.json(await startSourceEnrichment(await c.req.json()), 201);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/source-association-decisions", async (c) => {
      try {
        return c.json(
          await commands.startSourceAssociationDecision(await c.req.json()),
          202,
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .get("/correction-subjects/:id", async (c) => {
      try {
        const result = await commands.inspectCorrectionSubject(
          c.req.param("id"),
        );
        return result === undefined
          ? c.json({ error: "未找到可更正内容" }, 404)
          : c.json(result);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .get("/source-association-decisions/:id", async (c) => {
      try {
        const result = await commands.inspectSourceAssociationDecision(
          c.req.param("id"),
        );
        return result === undefined
          ? c.json({ error: "未找到来源关联决定" }, 404)
          : c.json(result);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/source-association-decisions/:id/select", async (c) => {
      try {
        return c.json(
          await commands.selectSourceAssociationDecisionCandidate(
            c.req.param("id"),
            await c.req.json(),
          ),
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/source-association-decisions/:id/retry", async (c) => {
      try {
        return c.json(
          await commands.retrySourceAssociationDecision(c.req.param("id")),
          202,
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/recognition-retractions", async (c) => {
      try {
        return c.json(
          await commands.startRecognitionRetraction(await c.req.json()),
          202,
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .post("/observed-material-associations", async (c) => {
      try {
        return c.json(
          await startObservedMaterialAssociation(await c.req.json()),
          202,
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .get("/observed-material-associations/:id", async (c) => {
      try {
        return c.json(
          await inspectObservedMaterialAssociation(c.req.param("id")),
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 404);
      }
    })
    .post("/observed-material-associations/:id/confirm", async (c) => {
      try {
        const body = await c.req.json();
        if (body === null || typeof body !== "object" || Array.isArray(body))
          throw new Error("观察材料确认请求无效");
        return c.json(
          await confirmObservedMaterialAssociation({
            ...body,
            executionId: c.req.param("id"),
          }),
          202,
        );
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
        const connection = await commands.completeBangumiAuthorizationCallback(
          c.req.url,
        );
        if (c.req.header("accept")?.includes("text/html"))
          return c.redirect("/settings/automation?authorization=complete");
        return c.json(connection);
      } catch (error) {
        if (c.req.header("accept")?.includes("text/html"))
          return c.redirect("/settings/automation?authorization=failed");
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
        const body: unknown = await c.req.json();
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          JSON.stringify(Object.keys(body).toSorted()) !==
            JSON.stringify(["action", "actorId", "previewId"]) ||
          !["apply", "reject"].includes(
            (body as { action?: unknown }).action as string,
          ) ||
          typeof (body as { actorId?: unknown }).actorId !== "string" ||
          (body as { actorId: string }).actorId.trim().length === 0 ||
          typeof (body as { previewId?: unknown }).previewId !== "string" ||
          (body as { previewId: string }).previewId.trim().length === 0
        )
          throw new Error("变更影响预演操作无效");
        return c.json(
          await commands.updatePreview(
            body as {
              action: "apply" | "reject";
              actorId: string;
              previewId: string;
            },
          ),
        );
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
  text: string | undefined,
  category: string | undefined,
  sort: string | undefined,
) {
  if (surface === "automation") return catalogueSurface({ surface });
  if (
    surface === "current-catalogue" &&
    (text !== undefined || category !== undefined || sort !== undefined)
  ) {
    if (sort !== undefined && sort !== "recent" && sort !== "name")
      throw new Error("排序方式无效");
    return catalogueSurface({
      surface,
      page: cataloguePageRequest(cursor, limit),
      query: {
        ...(text === undefined ? {} : { text }),
        ...(category === undefined ? {} : { category }),
        sort: sort ?? "recent",
      },
    });
  }
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
