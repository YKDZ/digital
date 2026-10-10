import { readFile } from "node:fs/promises";

import type { Page } from "@playwright/test";

export const productReadyPath = "/api/ready";

export type ManagedServiceHandoff = {
  readonly mode: "owned" | "provided";
  readonly baseUrl: string;
  readonly environment: string;
  readonly workspacePath: string;
  readonly productDataRoot: string;
  readonly materialDirectory: string;
  readonly manifestPath: string;
  readonly sourceMode: string;
  readonly productLogFile: string;
  readonly run: {
    readonly pid?: number;
    readonly port?: number;
    readonly runId?: string;
    readonly address?: string;
  };
  readonly artifactsDirectory: string;
};

export function handoffPath(): string {
  const value = process.env.DIGITAL_ACCEPTANCE_HANDOFF;
  if (value === undefined || value.length === 0)
    throw new Error(
      "必须由验收调用方提供 DIGITAL_ACCEPTANCE_HANDOFF，指向真实服务交接记录",
    );
  return value;
}

export async function loadHandoff(): Promise<ManagedServiceHandoff> {
  return JSON.parse(
    await readFile(handoffPath(), "utf8"),
  ) as ManagedServiceHandoff;
}

type BrowserRequest = {
  readonly address: string;
  readonly method: string;
  readonly body: string | null;
};

/**
 * 浏览器侧读取真实服务：请求由正在提供页面的进程处理，测试进程里没有任何
 * 产品实现，也没有路由拦截。
 */
export async function requestJson(
  page: Page,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {},
): Promise<unknown> {
  return await page.evaluate(
    async (request) => {
      const response = await fetch(request.address, {
        method: request.method,
        ...(request.body === null
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: request.body,
            }),
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(
          `${request.method} ${request.address} → ${response.status} ${text}`,
        );
      return JSON.parse(text) as unknown;
    },
    {
      address: new URL(path, page.url()).toString(),
      method: init.method ?? "GET",
      body: init.body ?? null,
    } satisfies BrowserRequest,
  );
}

export async function requestThroughBrowser(
  page: Page,
  path: string,
): Promise<{ status: number; body: string }> {
  return await page.evaluate(async (address) => {
    const response = await fetch(address);
    return { status: response.status, body: await response.text() };
  }, new URL(path, page.url()).toString());
}

/** 就绪只认产品 `/api/ready` 的成功应答；首页可达与内容数量都不算。 */
export async function confirmProductReady(
  page: Page,
): Promise<{ status: number; body: string }> {
  const ready = await requestThroughBrowser(page, productReadyPath);
  if (ready.status !== 200 || !ready.body.includes('"ok":true'))
    throw new Error(
      `产品未通过 ${productReadyPath} 就绪确认：${JSON.stringify(ready)}`,
    );
  return ready;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`期望 JSON 对象，实际得到 ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

export function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new Error(`期望 JSON 数组，实际得到 ${JSON.stringify(value)}`);
  return value.map((item) => asRecord(item));
}
