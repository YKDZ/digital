import type { SourceConnectionInspection } from "@digital/application";
import {
  SourceConnectionAlreadyConfigured,
  SourceConnectionVersionConflict,
  TmdbSourceConnection,
  type ProductApplication,
} from "@digital/product-application";
import { publicApiErrorResponseSchema } from "@digital/public-api";
import {
  bangumiAuthorizationAttemptRequestSchema,
  bangumiAuthorizationStartSchema,
  bangumiOAuthClientConfigurationRequestSchema,
  bangumiOAuthClientConfigurationSchema,
  publicSourceConnectionListSchema,
  publicBangumiAuthorizationAttemptSchema,
  sourceConnectionMutationRequestSchema,
  sourceConnectionRevocationRequestSchema,
  sourceConnectionRevokedSchema,
  sourceConnectionStateResponseSchema,
  sourceConnectionVerificationSchema,
  fanboxSourceConnectionRevocationRequestSchema,
} from "@digital/public-api/source-connection-contract";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

type KeySourceConnection =
  | ProductApplication["workflow"]["sourceConnections"]["tmdb"]
  | ProductApplication["workflow"]["sourceConnections"]["omdb"];

/** 密钥类来源连接的中立 HTTP 路由；具体来源验证仍由对应来源能力执行。 */
export function createSourceConnectionsHttpApi(
  application: ProductApplication,
): Hono {
  const api = new Hono();

  api.put(
    "/source-connections/bangumi/client-configuration",
    async (context) => {
      const input = await context.req.json().catch(() => undefined);
      const parsed = safeParse(
        bangumiOAuthClientConfigurationRequestSchema,
        input,
      );
      if (!parsed.success)
        return context.json(
          sourceConnectionError(
            "invalid-request",
            "Bangumi OAuth 应用配置无效",
          ),
          400,
        );
      try {
        application.workflow.sourceConnections.bangumi.configureClient(
          parsed.output,
        );
        const result = safeParse(bangumiOAuthClientConfigurationSchema, {
          configured: true,
        });
        if (!result.success) throw new Error("Bangumi OAuth 应用配置结果无效");
        return context.json(result.output);
      } catch {
        return context.json(
          sourceConnectionError(
            "unavailable",
            "暂时无法保存 Bangumi OAuth 应用配置",
          ),
          503,
        );
      }
    },
  );

  api.get("/source-connections", (context) => {
    const result = safeParse(publicSourceConnectionListSchema, {
      items: application.workflow.sourceConnections
        .inspect()
        .map(publicConnection),
    });
    if (!result.success)
      return context.json(
        sourceConnectionError("unavailable", "暂时无法读取来源连接"),
        503,
      );
    return context.json(result.output);
  });

  api.get("/source-connections/:id", (context) => {
    const sourceId = context.req.param("id");
    const connection =
      sourceId === "bangumi"
        ? application.workflow.sourceConnections.bangumi
        : keyConnection(application, sourceId);
    if (connection === undefined)
      return context.json(
        sourceConnectionError("not-found", "没有此来源连接"),
        404,
      );
    const result = safeParse(
      sourceConnectionStateResponseSchema,
      publicConnection(connection.inspect()),
    );
    if (!result.success)
      return context.json(
        sourceConnectionError("unavailable", "暂时无法读取来源连接"),
        503,
      );
    return context.json(result.output);
  });

  api.post("/source-connections/:id", async (context) => {
    const input = await context.req.json().catch(() => undefined);
    const parsed = safeParse(sourceConnectionMutationRequestSchema, input);
    if (!parsed.success)
      return context.json(
        sourceConnectionError("invalid-request", "来源连接配置无效"),
        400,
      );
    const connection = keyConnection(application, context.req.param("id"));
    if (connection === undefined)
      return context.json(
        sourceConnectionError("not-found", "没有此来源连接"),
        404,
      );
    if (connection.inspect().credentialStatus === "invalid")
      return context.json(
        sourceConnectionError("unavailable", "来源连接私密存储不可用"),
        503,
      );

    try {
      const pending = configureConnection(
        connection,
        parsed.output.secret,
        parsed.output.expectedVersion,
      );
      return await verifyConnection(context, connection, pending);
    } catch (error) {
      return sourceConnectionMutationError(context, error);
    }
  });

  api.put("/source-connections/:id", async (context) => {
    const input = await context.req.json().catch(() => undefined);
    const parsed = safeParse(sourceConnectionMutationRequestSchema, input);
    if (!parsed.success)
      return context.json(
        sourceConnectionError("invalid-request", "来源连接配置无效"),
        400,
      );
    const connection = keyConnection(application, context.req.param("id"));
    if (connection === undefined)
      return context.json(
        sourceConnectionError("not-found", "没有此来源连接"),
        404,
      );
    if (connection.inspect().credentialStatus === "invalid")
      return context.json(
        sourceConnectionError("unavailable", "来源连接私密存储不可用"),
        503,
      );

    try {
      const pending = replaceConnection(
        connection,
        parsed.output.secret,
        parsed.output.expectedVersion,
      );
      return await verifyConnection(context, connection, pending);
    } catch (error) {
      return sourceConnectionMutationError(context, error);
    }
  });

  api.delete("/source-connections/:id", async (context) => {
    const input = await context.req.json().catch(() => undefined);
    const parsed = safeParse(sourceConnectionRevocationRequestSchema, input);
    if (!parsed.success)
      return context.json(
        sourceConnectionError("invalid-request", "来源连接配置无效"),
        400,
      );
    if (context.req.param("id") === "bangumi") {
      try {
        const revoked = application.workflow.sourceConnections.bangumi.revoke(
          parsed.output.expectedVersion,
        );
        const result = safeParse(sourceConnectionRevokedSchema, {
          connection: publicConnection(revoked),
          revoked: true,
        });
        if (!result.success) throw new Error("Bangumi 来源连接撤销结果无效");
        return context.json(result.output);
      } catch (error) {
        return sourceConnectionMutationError(context, error);
      }
    }
    const connection = keyConnection(application, context.req.param("id"));
    if (connection === undefined)
      return context.json(
        sourceConnectionError("not-found", "没有此来源连接"),
        404,
      );
    if (connection.inspect().credentialStatus === "invalid")
      return context.json(
        sourceConnectionError("unavailable", "来源连接私密存储不可用"),
        503,
      );

    try {
      const revoked = revokeConnection(
        connection,
        parsed.output.expectedVersion,
      );
      const result = safeParse(sourceConnectionRevokedSchema, {
        connection: publicConnection(revoked),
        revoked: true,
      });
      if (!result.success) throw new Error("来源连接撤销结果无效");
      return context.json(result.output);
    } catch (error) {
      return sourceConnectionMutationError(context, error);
    }
  });

  api.post("/source-connections/bangumi/authorize", (context) => {
    try {
      const started =
        application.workflow.sourceConnections.bangumi.beginAuthorization();
      const result = safeParse(bangumiAuthorizationStartSchema, started);
      if (!result.success) throw new Error("Bangumi 授权请求无效");
      return context.json(result.output);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("正在进行") ||
          error.message.includes("正在完成"))
      )
        return context.json(
          sourceConnectionError(
            "conflict",
            "Bangumi 授权正在处理，请稍候查看状态",
          ),
          409,
        );
      return context.json(
        sourceConnectionError("unavailable", "暂时无法发起 Bangumi 授权"),
        503,
      );
    }
  });

  api.get(
    "/source-connections/bangumi/authorizations/:attemptId",
    (context) => {
      const parsed = safeParse(bangumiAuthorizationAttemptRequestSchema, {
        attemptId: context.req.param("attemptId"),
      });
      if (!parsed.success)
        return context.json(
          sourceConnectionError("invalid-request", "Bangumi 授权请求编号无效"),
          400,
        );
      try {
        const attempt =
          application.workflow.sourceConnections.bangumi.getAuthorizationAttempt(
            parsed.output.attemptId,
          );
        const result = safeParse(
          publicBangumiAuthorizationAttemptSchema,
          attempt,
        );
        if (!result.success) throw new Error("Bangumi 授权状态无效");
        return context.json(result.output);
      } catch {
        return context.json(
          sourceConnectionError("unavailable", "暂时无法读取 Bangumi 授权状态"),
          503,
        );
      }
    },
  );

  api.post(
    "/source-connections/bangumi/authorizations/:attemptId/cancel",
    (context) => {
      const parsed = safeParse(bangumiAuthorizationAttemptRequestSchema, {
        attemptId: context.req.param("attemptId"),
      });
      if (!parsed.success)
        return context.json(
          sourceConnectionError("invalid-request", "Bangumi 授权请求编号无效"),
          400,
        );
      try {
        const attempt =
          application.workflow.sourceConnections.bangumi.cancelAuthorization(
            parsed.output.attemptId,
          );
        const result = safeParse(
          publicBangumiAuthorizationAttemptSchema,
          attempt,
        );
        if (!result.success) throw new Error("Bangumi 授权状态无效");
        return context.json(result.output);
      } catch {
        return context.json(
          sourceConnectionError("unavailable", "暂时无法取消 Bangumi 授权"),
          503,
        );
      }
    },
  );

  api.get("/source-connections/bangumi/callback", async (context) => {
    try {
      await application.workflow.sourceConnections.bangumi.completeAuthorizationCallback(
        context.req.url,
      );
      return oauthCallbackPage(context, "success");
    } catch (error) {
      return oauthCallbackPage(context, authorizationCallbackOutcome(error));
    }
  });

  api.delete("/source-connections/fanbox/:creatorId", async (context) => {
    const input = await context.req.json().catch(() => undefined);
    const parsed = safeParse(fanboxSourceConnectionRevocationRequestSchema, {
      ...(typeof input === "object" && input !== null ? input : {}),
      creatorId: context.req.param("creatorId"),
    });
    if (!parsed.success)
      return context.json(
        sourceConnectionError("invalid-request", "FANBOX 来源连接配置无效"),
        400,
      );
    try {
      const revoked = application.workflow.sourceConnections.fanbox.revoke({
        creatorId: parsed.output.creatorId,
        expectedVersion: parsed.output.expectedVersion,
      });
      const result = safeParse(sourceConnectionRevokedSchema, {
        connection: publicConnection(revoked),
        revoked: true,
      });
      if (!result.success) throw new Error("FANBOX 来源连接撤销结果无效");
      return context.json(result.output);
    } catch (error) {
      return sourceConnectionMutationError(context, error);
    }
  });

  return api;
}

function keyConnection(
  application: ProductApplication,
  id: string,
): KeySourceConnection | undefined {
  switch (id) {
    case "tmdb":
      return application.workflow.sourceConnections.tmdb;
    case "omdb":
      return application.workflow.sourceConnections.omdb;
    default:
      return undefined;
  }
}

function configureConnection(
  connection: KeySourceConnection,
  secret: string,
  expectedVersion: number,
): SourceConnectionInspection {
  return connection instanceof TmdbSourceConnection
    ? connection.configureAccessToken(secret, expectedVersion)
    : connection.configureApiKey(secret, expectedVersion);
}

function replaceConnection(
  connection: KeySourceConnection,
  secret: string,
  expectedVersion: number,
): SourceConnectionInspection {
  return connection instanceof TmdbSourceConnection
    ? connection.replaceAccessToken(secret, expectedVersion)
    : connection.replaceApiKey(secret, expectedVersion);
}

function revokeConnection(
  connection: KeySourceConnection,
  expectedVersion: number,
): SourceConnectionInspection {
  return connection.revoke(expectedVersion);
}

async function verifyConnection(
  context: Context,
  connection: KeySourceConnection,
  pending: SourceConnectionInspection,
) {
  const verified = await connection.verify();
  const result = safeParse(sourceConnectionVerificationSchema, {
    connection: publicConnection(verified),
    verification:
      verified.version !== pending.version
        ? "superseded"
        : verified.availability === "available"
          ? "verified"
          : verified.reason === "verification-failed"
            ? "failed"
            : "superseded",
  });
  if (!result.success) throw new Error("来源连接验证结果无效");
  return context.json(result.output);
}

function publicConnection(connection: SourceConnectionInspection) {
  const { id, version, credentialStatus, availability, verifiedAt, reason } =
    connection;
  return {
    id,
    version,
    credentialStatus,
    availability,
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function sourceConnectionMutationError(context: Context, error: unknown) {
  if (
    error instanceof SourceConnectionVersionConflict ||
    error instanceof SourceConnectionAlreadyConfigured
  )
    return context.json(
      sourceConnectionError("conflict", "来源连接已变化，请重新读取后重试"),
      409,
    );
  return context.json(
    sourceConnectionError("unavailable", "来源连接暂时不可用"),
    503,
  );
}

function sourceConnectionError(
  code: "invalid-request" | "conflict" | "not-found" | "unavailable",
  message: string,
) {
  const result = safeParse(publicApiErrorResponseSchema, {
    error: { code, message },
  });
  if (!result.success) throw new Error("来源连接错误结果无效");
  return result.output;
}

type OAuthCallbackOutcome =
  | "success"
  | "cancelled"
  | "failed"
  | "invalid"
  | "superseded";

function authorizationCallbackOutcome(error: unknown): OAuthCallbackOutcome {
  if (!(error instanceof Error)) return "failed";
  if (error.message.includes("授权已取消")) return "cancelled";
  if (error.message.includes("授权未完成")) return "failed";
  if (error.message.includes("配置已变化")) return "superseded";
  if (error.message.includes("回调状态无效或已过期")) return "invalid";
  return "failed";
}

function oauthCallbackPage(context: Context, outcome: OAuthCallbackOutcome) {
  const messages: Record<OAuthCallbackOutcome, string> = {
    success: "Bangumi 授权已完成。请返回终端查看连接状态。",
    cancelled: "Bangumi 授权已取消。请返回终端查看连接状态。",
    failed: "Bangumi 授权失败。请返回终端查看结果并重新尝试。",
    invalid: "此授权链接无效或已过期。请返回终端重新发起。",
    superseded: "此授权请求已失效。请返回终端重新发起。",
  };
  context.header("Cache-Control", "no-store");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  return context.html(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>来源授权</title><body><main><p>${messages[outcome]}</p></main></body></html>`,
    outcome === "invalid" ? 400 : 200,
  );
}
