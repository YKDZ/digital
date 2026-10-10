import { defineConfig } from "@playwright/test";

/**
 * 真实 HTTP 产品链路专用配置：只运行需要服务交接记录的两个场景，
 * 普通页面 E2E 入口（playwright.config.ts）不发现它们，二者互不牵连。
 */
const externalBaseUrlName = "PLAYWRIGHT_EXTERNAL_BASE_URL";
const handoffEnvName = "DIGITAL_ACCEPTANCE_HANDOFF";

function requiredHttpBaseUrl(): string {
  const value = process.env[externalBaseUrlName]?.trim();
  if (!value)
    throw new Error(
      `真实 HTTP 场景必须由验收调用方通过 ${externalBaseUrlName} 给出正在服务的地址`,
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${externalBaseUrlName} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${externalBaseUrlName} must use HTTP or HTTPS`);
  return url.toString();
}

if (!process.env[handoffEnvName]?.trim())
  throw new Error(
    `真实 HTTP 场景必须由验收调用方提供 ${handoffEnvName}，指向真实服务交接记录`,
  );

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: [
    "managed-service-product-chain.spec.ts",
    "provided-service-verification.spec.ts",
  ],
  timeout: 60_000,
  use: {
    baseURL: requiredHttpBaseUrl(),
    trace: "retain-on-failure",
  },
  projects: [{ name: "managed-service-http" }],
});
