import type { ProductApplication } from "@digital/product-application";
import { publicApiErrorResponseSchema } from "@digital/public-api";
import {
  createFanboxConnectionRequestRequestSchema,
  createFanboxConnectionRequestResponseSchema,
  fanboxConnectionRequestCompletionRequestSchema,
  fanboxConnectionRequestIdRequestSchema,
  fanboxConnectionRequestPairingRequestSchema,
  publicFanboxConnectionRequestSchema,
} from "@digital/public-api/source-connection-contract";
import { Hono } from "hono";
import { safeParse } from "valibot";

/** FANBOX 的限时连接配对入口；Cookie 只传入产品连接用例，不出现在结果或日志中。 */
export function createFanboxConnectionRequestsHttpApi(
  application: ProductApplication,
): Hono {
  const api = new Hono();
  const connections = () => application.workflow.sourceConnections.fanbox;

  api.post("/fanbox-connection-requests", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const parsed = safeParse(createFanboxConnectionRequestRequestSchema, body);
    if (!parsed.success)
      return context.json(
        errorResponse("invalid-request", "FANBOX 连接请求无效"),
        400,
      );
    try {
      const created = connections().createConnectionRequest(parsed.output);
      const result = safeParse(
        createFanboxConnectionRequestResponseSchema,
        created,
      );
      if (!result.success) throw new Error("FANBOX 连接请求结果无效");
      return context.json(result.output, 201);
    } catch {
      return context.json(
        errorResponse("unavailable", "暂时无法发起 FANBOX 连接"),
        503,
      );
    }
  });

  api.get("/fanbox-connection-requests/:requestId", (context) => {
    const parsed = safeParse(fanboxConnectionRequestIdRequestSchema, {
      requestId: context.req.param("requestId"),
    });
    if (!parsed.success)
      return context.json(
        errorResponse("invalid-request", "FANBOX 连接请求编号无效"),
        400,
      );
    const request = connections().inspectConnectionRequest(
      parsed.output.requestId,
    );
    if (request === undefined)
      return context.json(errorResponse("not-found", "没有此连接请求"), 404);
    const result = safeParse(publicFanboxConnectionRequestSchema, request);
    if (!result.success)
      return context.json(
        errorResponse("unavailable", "暂时无法读取连接请求"),
        503,
      );
    return context.json(result.output);
  });

  api.post(
    "/fanbox-connection-requests/:requestId/pairing",
    async (context) => {
      const body = await context.req.json().catch(() => undefined);
      const parsed = safeParse(fanboxConnectionRequestPairingRequestSchema, {
        ...(typeof body === "object" && body !== null ? body : {}),
        requestId: context.req.param("requestId"),
      });
      if (!parsed.success)
        return context.json(
          errorResponse("invalid-request", "FANBOX 配对信息无效"),
          400,
        );
      const request = connections().inspectConnectionRequestForPairing(
        parsed.output,
      );
      if (request === undefined)
        return context.json(errorResponse("not-found", "没有此连接请求"), 404);
      const result = safeParse(publicFanboxConnectionRequestSchema, request);
      if (!result.success)
        return context.json(
          errorResponse("unavailable", "暂时无法读取连接请求"),
          503,
        );
      return context.json(result.output);
    },
  );

  api.post(
    "/fanbox-connection-requests/:requestId/complete",
    async (context) => {
      const body = await context.req.json().catch(() => undefined);
      const parsed = safeParse(fanboxConnectionRequestCompletionRequestSchema, {
        ...(typeof body === "object" && body !== null ? body : {}),
        requestId: context.req.param("requestId"),
      });
      if (!parsed.success)
        return context.json(
          errorResponse("invalid-request", "FANBOX 浏览器连接信息无效"),
          400,
        );
      try {
        const request = await connections().completeConnectionRequest(
          parsed.output,
        );
        if (request === undefined)
          return context.json(
            errorResponse("not-found", "没有此连接请求"),
            404,
          );
        const result = safeParse(publicFanboxConnectionRequestSchema, request);
        if (!result.success) throw new Error("FANBOX 连接验证结果无效");
        return context.json(result.output);
      } catch {
        return context.json(
          errorResponse("unavailable", "FANBOX 连接验证暂时不可用"),
          503,
        );
      }
    },
  );

  api.post("/fanbox-connection-requests/:requestId/cancel", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const parsed = safeParse(fanboxConnectionRequestPairingRequestSchema, {
      ...(typeof body === "object" && body !== null ? body : {}),
      requestId: context.req.param("requestId"),
    });
    if (!parsed.success)
      return context.json(
        errorResponse("invalid-request", "FANBOX 配对信息无效"),
        400,
      );
    const request = connections().cancelConnectionRequest(parsed.output);
    if (request === undefined)
      return context.json(errorResponse("not-found", "没有此连接请求"), 404);
    const result = safeParse(publicFanboxConnectionRequestSchema, request);
    if (!result.success)
      return context.json(
        errorResponse("unavailable", "暂时无法取消连接请求"),
        503,
      );
    return context.json(result.output);
  });

  return api;
}

function errorResponse(
  code: "invalid-request" | "not-found" | "unavailable",
  message: string,
) {
  const result = safeParse(publicApiErrorResponseSchema, {
    error: { code, message },
  });
  if (!result.success) throw new Error("FANBOX 连接错误结果无效");
  return result.output;
}
