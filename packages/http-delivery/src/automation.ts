import {
  AssetLibraryConfigurationConflict,
  AssetLibraryNotFound,
  InvalidAssetLibraryConfiguration,
  InvalidObservedRootDirectory,
  InvalidObservedRelativeScope,
  ObservedRootConfigurationConflict,
  ObservedRootUnavailable,
  type AutomationIntent,
  type AutomationTriggerResult,
} from "@digital/application";
import type { ProductApplication } from "@digital/product-application";
import {
  automationIntentIdRequestSchema,
  disableAutomationIntentResultSchema,
  enableAutomationIntentRequestSchema,
  enableAutomationIntentResultSchema,
  publicApiErrorResponseSchema,
  publicAutomationIntentListSchema,
  publicAutomationTriggerResultSchema,
  type PublicAutomationTriggerResult,
} from "@digital/public-api";
import { Hono, type Context } from "hono";
import { safeParse } from "valibot";

type ApiCode =
  | "invalid-request"
  | "conflict"
  | "not-found"
  | "not-ready"
  | "unavailable";

/** 自动刷新通过产品用例与共同执行宿主操作；此处不读取展示面板或来源配置细节。 */
export function createAutomationHttpApi(application: ProductApplication): Hono {
  const api = new Hono();

  api.get("/automation-intents", async (context) => {
    try {
      const items = await application.workflow.listAutomationIntents();
      const result = safeParse(publicAutomationIntentListSchema, {
        items: await Promise.all(
          items.map(
            async (intent) => await publicAutomationIntent(application, intent),
          ),
        ),
      });
      if (!result.success) throw new Error("自动刷新设置无法投影");
      return context.json(result.output);
    } catch {
      return context.json(
        errorResponse("unavailable", "暂时无法读取自动刷新设置"),
        503,
      );
    }
  });

  api.post("/automation-intents", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const input = safeParse(enableAutomationIntentRequestSchema, body);
    if (!input.success)
      return context.json(
        errorResponse("invalid-request", "自动刷新设置无效"),
        400,
      );

    try {
      const library = await application.workflow.assetLibraries.get(
        input.output.assetLibraryId,
      );
      if (library === undefined)
        return context.json(
          errorResponse("not-found", "资产库不存在或已移除"),
          404,
        );
      const directories =
        await application.workflow.assetLibraries.directoryViews(library.id);
      const directory = directories.find(
        ({ directoryId }) => directoryId === input.output.directoryId,
      );
      if (directory === undefined || directory.status !== "active")
        return context.json(
          errorResponse("conflict", "资产库目录已变更，请重新读取后再操作"),
          409,
        );
      if (!directory.reachable)
        return context.json(
          errorResponse(
            "not-ready",
            "自动刷新目录当前不可用，请检查资产库设置",
          ),
          409,
        );
      const [intent, initial] = await enableAutomationIntent(application, {
        assetLibraryId: input.output.assetLibraryId,
        observedRootId: directory.observedRootId,
        relativeScope: input.output.relativeScope,
        intervalMilliseconds: input.output.intervalMilliseconds,
        acceptTrusted: input.output.acceptTrusted,
      });
      const result = safeParse(enableAutomationIntentResultSchema, {
        intent: await publicAutomationIntent(
          application,
          intent,
          input.output.directoryId,
        ),
        ...(initial === undefined ? {} : { initial }),
      });
      if (!result.success) throw new Error("自动刷新设置无法投影");
      return context.json(result.output, 201);
    } catch (error) {
      return automationError(context, error);
    }
  });

  api.post("/automation-intents/:id/disable", async (context) => {
    const id = safeParse(automationIntentIdRequestSchema, {
      intentId: context.req.param("id"),
    });
    if (!id.success)
      return context.json(
        errorResponse("invalid-request", "自动刷新设置无效"),
        400,
      );
    try {
      if (!(await hasIntent(application, id.output.intentId)))
        return context.json(
          errorResponse("not-found", "自动刷新设置不存在或已移除"),
          404,
        );
      await application.workflow.disableAutomation(id.output.intentId);
      const result = safeParse(disableAutomationIntentResultSchema, {
        status: "disabled",
      });
      if (!result.success) throw new Error("自动刷新设置无法投影");
      return context.json(result.output);
    } catch (error) {
      return automationError(context, error);
    }
  });

  api.post("/automation-intents/:id/scan-now", async (context) => {
    const id = safeParse(automationIntentIdRequestSchema, {
      intentId: context.req.param("id"),
    });
    if (!id.success)
      return context.json(
        errorResponse("invalid-request", "自动刷新设置无效"),
        400,
      );
    try {
      if (!(await hasIntent(application, id.output.intentId)))
        return context.json(
          errorResponse("not-found", "自动刷新设置不存在或已移除"),
          404,
        );
      const result = await triggerAutomationIntent(
        application,
        id.output.intentId,
      );
      const validated = safeParse(publicAutomationTriggerResultSchema, result);
      if (!validated.success) throw new Error("自动刷新结果无法投影");
      return context.json(validated.output);
    } catch (error) {
      return automationError(context, error);
    }
  });

  return api;
}

async function publicAutomationIntent(
  application: ProductApplication,
  intent: AutomationIntent,
  knownDirectoryId?: string,
) {
  let directoryId = knownDirectoryId;
  if (directoryId === undefined) {
    const library = await application.workflow.assetLibraries.get(
      intent.scope.assetLibraryId,
    );
    if (library !== undefined) {
      const directory = (
        await application.workflow.assetLibraries.directoryViews(library.id)
      ).find(
        ({ observedRootId }) => observedRootId === intent.scope.observedRootId,
      );
      directoryId = directory?.directoryId;
    }
  }
  return {
    id: intent.id,
    scope: {
      assetLibraryId: intent.scope.assetLibraryId,
      ...(directoryId === undefined ? {} : { directoryId }),
      relativeScope: intent.scope.relativeScope,
    },
    enabled: intent.enabled,
    ...(intent.disabledReason === undefined
      ? {}
      : { disabledReason: intent.disabledReason }),
    intervalMilliseconds: intent.intervalMilliseconds,
    acceptTrusted: intent.acceptTrusted,
  };
}

async function hasIntent(
  application: ProductApplication,
  intentId: string,
): Promise<boolean> {
  return (await application.workflow.listAutomationIntents()).some(
    ({ id }) => id === intentId,
  );
}

async function enableAutomationIntent(
  application: ProductApplication,
  input: {
    readonly assetLibraryId: string;
    readonly observedRootId: string;
    readonly relativeScope?: string | undefined;
    readonly intervalMilliseconds: number;
    readonly acceptTrusted: boolean;
  },
): Promise<[AutomationIntent, PublicAutomationTriggerResult | undefined]> {
  let intent: AutomationIntent | undefined;
  let initialResult: AutomationTriggerResult | undefined;
  let initialExecutionId: string | undefined;
  const invocation = application.execution.invoke(async (control) => {
    const result = await application.workflow.enableAutomation({
      assetLibraryId: input.assetLibraryId,
      observedRootId: input.observedRootId,
      relativeScope: input.relativeScope ?? ".",
      intervalMilliseconds: input.intervalMilliseconds,
      acceptTrusted: input.acceptTrusted,
      onIntentCreated(created) {
        intent = created;
      },
      onInitialExecutionStarted(workflowExecution) {
        initialExecutionId = workflowExecution.id;
        control.executionStarted(workflowExecution.id);
      },
      onInitialCheckpoint() {
        control.safeCheckpoint();
      },
    });
    intent ??= result.intent;
    initialResult = result.initial;
  });
  try {
    await invocation;
  } catch (error) {
    if (intent === undefined) throw error;
    if (
      initialExecutionId === undefined &&
      initialResult?.status !== "skipped" &&
      initialResult?.status !== "disabled"
    )
      throw error;
  }
  if (intent === undefined) throw new Error("自动刷新设置未能保存");
  if (initialExecutionId !== undefined)
    return [intent, { status: "started", executionId: initialExecutionId }];
  if (initialResult !== undefined)
    return [intent, publicAutomationTriggerResult(initialResult)];
  throw new Error("自动刷新设置未返回首次执行结果");
}

async function triggerAutomationIntent(
  application: ProductApplication,
  intentId: string,
): Promise<PublicAutomationTriggerResult> {
  let result: AutomationTriggerResult | undefined;
  let executionId: string | undefined;
  const invocation = application.execution.invoke(async (control) => {
    result = await application.workflow.triggerAutomation(
      intentId,
      "scan-now",
      new Date(),
      {
        onExecutionStarted(execution) {
          executionId = execution.id;
          control.executionStarted(execution.id);
        },
        onCheckpoint() {
          control.safeCheckpoint();
        },
      },
    );
  });
  try {
    await invocation;
  } catch (error) {
    if (executionId === undefined) throw error;
  }
  if (executionId !== undefined) return { status: "started", executionId };
  if (result === undefined) throw new Error("自动刷新操作没有返回执行状态");
  return publicAutomationTriggerResult(result);
}

function publicAutomationTriggerResult(
  result: AutomationTriggerResult,
): PublicAutomationTriggerResult {
  if (result.status === "started")
    return {
      status: "started",
      executionId: result.execution.execution.id,
    };
  if (result.status === "disabled")
    return { status: "disabled", reason: "自动刷新设置已停用" };
  return {
    status: "skipped",
    reason: "当前条件下无法启动自动刷新，本次未重复执行",
  };
}

function automationError(context: Context, error: unknown) {
  if (
    error instanceof InvalidAssetLibraryConfiguration ||
    error instanceof InvalidObservedRootDirectory ||
    error instanceof InvalidObservedRelativeScope
  )
    return context.json(
      errorResponse("invalid-request", "自动刷新设置无效"),
      400,
    );
  if (error instanceof AssetLibraryNotFound)
    return context.json(
      errorResponse("not-found", "资产库不存在或已移除"),
      404,
    );
  if (
    error instanceof AssetLibraryConfigurationConflict ||
    error instanceof ObservedRootConfigurationConflict
  )
    return context.json(
      errorResponse("conflict", "资产库配置已更新，请重新读取后再操作"),
      409,
    );
  if (error instanceof ObservedRootUnavailable)
    return context.json(
      errorResponse("not-ready", "自动刷新目录当前不可用，请检查资产库设置"),
      409,
    );
  return context.json(
    errorResponse("unavailable", "自动刷新操作暂时不可用，请稍后重试"),
    503,
  );
}

function errorResponse(code: ApiCode, message: string) {
  return safeParse(publicApiErrorResponseSchema, { error: { code, message } })
    .output;
}
