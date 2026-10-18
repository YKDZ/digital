import {
  automationIntentIdRequestSchema,
  disableAutomationIntentResultSchema,
  enableAutomationIntentRequestSchema,
  enableAutomationIntentResultSchema,
  publicAutomationIntentListSchema,
  publicAutomationTriggerResultSchema,
  type EnableAutomationIntentRequest,
  type EnableAutomationIntentResult,
  type PublicAutomationIntent,
  type PublicAutomationTriggerResult,
} from "./automation-contract.ts";
import type {
  PublicApiJsonRequest,
  PublicApiJsonRequestOptions,
  PublicApiRequestValidation,
} from "./source-connection-client.ts";

export type PublicAutomationClientMethods = {
  listAutomationIntents(): Promise<{
    readonly items: readonly PublicAutomationIntent[];
  }>;
  enableAutomationIntent(
    input: EnableAutomationIntentRequest,
  ): Promise<EnableAutomationIntentResult>;
  disableAutomationIntent(intentId: string): Promise<{ status: "disabled" }>;
  triggerAutomationIntent(
    intentId: string,
  ): Promise<PublicAutomationTriggerResult>;
};

/** 自动化设置与执行入口属于唯一公共产品客户端。 */
export function automationClientMethods(input: {
  readonly apiBaseUrl: URL;
  readonly requestJson: PublicApiJsonRequest;
  readonly validateRequest: PublicApiRequestValidation;
  readonly jsonRequest: PublicApiJsonRequestOptions;
}): PublicAutomationClientMethods {
  const collectionUrl = new URL("automation-intents", input.apiBaseUrl);
  return {
    async listAutomationIntents() {
      return await input.requestJson(
        collectionUrl,
        { headers: { accept: "application/json" } },
        publicAutomationIntentListSchema,
      );
    },
    async enableAutomationIntent(inputValue) {
      const request = input.validateRequest(
        enableAutomationIntentRequestSchema,
        inputValue,
        "自动刷新设置无效",
      );
      return await input.requestJson(
        collectionUrl,
        input.jsonRequest("POST", request),
        enableAutomationIntentResultSchema,
      );
    },
    async disableAutomationIntent(intentId) {
      const validatedId = validateIntentId(intentId, input.validateRequest);
      return await input.requestJson(
        new URL(
          `automation-intents/${encodeURIComponent(validatedId)}/disable`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", {}),
        disableAutomationIntentResultSchema,
      );
    },
    async triggerAutomationIntent(intentId) {
      const validatedId = validateIntentId(intentId, input.validateRequest);
      return await input.requestJson(
        new URL(
          `automation-intents/${encodeURIComponent(validatedId)}/scan-now`,
          input.apiBaseUrl,
        ),
        input.jsonRequest("POST", {}),
        publicAutomationTriggerResultSchema,
      );
    },
  };
}

function validateIntentId(
  intentId: string,
  validateRequest: PublicApiRequestValidation,
): string {
  const result = validateRequest(
    automationIntentIdRequestSchema,
    { intentId },
    "自动刷新设置无效",
  );
  return result.intentId;
}
