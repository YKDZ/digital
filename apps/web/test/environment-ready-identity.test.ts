import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";

import { createApp } from "#/server/app";
import {
  readyAttestation,
  readyNonceHeader,
  resolveReadyIdentity,
  type ReadyIdentity,
} from "#/server/environment-ready-identity";
import { createProcessLifecycleRegistry } from "#/server/process-lifecycle";

const identity: ReadyIdentity = {
  environmentId: "env-1",
  runId: "run-1",
  readyKey: "a".repeat(64),
};

const temporaryDirectories: string[] = [];

async function configPath(
  contents: string,
  name = "launch.json",
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "digital-web-ready-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, name);
  await writeFile(file, contents);
  return file;
}

/** 外层启动只交来一个私有配置路径，产品侧据此建立最小身份。 */
describe("环境启动配置的身份解析", () => {
  it("没有配置路径时按独立部署处理", () => {
    expect(resolveReadyIdentity({})).toEqual({ absent: true });
  });

  it("配置可信时交出精确身份，协议或密钥可疑时如实报告问题", async () => {
    const good = await configPath(
      JSON.stringify({
        protocol: "digital-environment-launch-v1",
        ...identity,
      }),
    );
    expect(
      resolveReadyIdentity({ DIGITAL_ENVIRONMENT_LAUNCH_CONFIG: good }),
    ).toEqual({ identity });

    const wrongProtocol = await configPath(
      JSON.stringify({ protocol: "other", ...identity }),
    );
    expect(
      resolveReadyIdentity({
        DIGITAL_ENVIRONMENT_LAUNCH_CONFIG: wrongProtocol,
      }),
    ).toEqual({ problem: "环境启动配置协议未知" });

    const weakKey = await configPath(
      JSON.stringify({
        protocol: "digital-environment-launch-v1",
        environmentId: "env-1",
        runId: "run-1",
        readyKey: "short",
      }),
    );
    expect(
      resolveReadyIdentity({ DIGITAL_ENVIRONMENT_LAUNCH_CONFIG: weakKey }),
    ).toEqual({ problem: "环境启动配置字段 readyKey 不是合法密钥" });

    const missing = resolveReadyIdentity({
      DIGITAL_ENVIRONMENT_LAUNCH_CONFIG: path.join(
        await configPath("{}", "gone.json"),
        "absent.json",
      ),
    });
    expect("problem" in missing ? missing.problem : "").toContain("无法读取");
  });
});

const readyDelivery = {
  api: new Hono(),
  startCatalogueAutomation: async () => undefined,
  catalogueReady: () => true,
  catalogueReadinessFailure: () => undefined,
};

function createRegistry() {
  return createProcessLifecycleRegistry(
    {
      addSignalListener() {},
      removeSignalListener() {},
      forceExit() {},
    },
    { closeTerminalProcessResources: async () => undefined },
  );
}

/** ready 证明只在带一次性 nonce 的请求上追加，普通响应形状与独立部署一致。 */
describe("真实 ready 响应的环境证明", () => {
  async function appFor(options: { readyIdentity?: ReadyIdentity }) {
    const bootstrap = await createApp(readyDelivery, {
      attachVike: false,
      lifecycle: createRegistry(),
      closeProduct: async () => undefined,
      ...options,
    });
    bootstrap.publish();
    return bootstrap.app;
  }

  it("带 nonce 的认证请求得到绑定 nonce 的签名", async () => {
    const app = await appFor({ readyIdentity: identity });
    const nonce = "nonce-7c1f";
    const response = await app.request("/api/ready", {
      headers: { [readyNonceHeader]: nonce },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(body).toEqual({
      ok: true,
      service: "digital-web",
      runId: identity.runId,
      attestation: createHmac("sha256", identity.readyKey)
        .update(
          JSON.stringify([
            "digital-environment-ready-v1",
            identity.environmentId,
            identity.runId,
            nonce,
          ]),
        )
        .digest("hex"),
    });

    const other = await app.request("/api/ready", {
      headers: { [readyNonceHeader]: "nonce-9a2b" },
    });
    const otherBody = (await other.json()) as { attestation: string };
    expect(otherBody.attestation).not.toBe(body.attestation);
  });

  it("普通请求与无身份服务的 ready 响应不含身份证明", async () => {
    const withIdentity = await appFor({ readyIdentity: identity });
    const plain = await withIdentity.request("/api/ready");
    expect(await plain.json()).toEqual({ ok: true, service: "digital-web" });

    const standalone = await appFor({});
    const challenged = await standalone.request("/api/ready", {
      headers: { [readyNonceHeader]: "nonce-1" },
    });
    expect(await challenged.json()).toEqual({
      ok: true,
      service: "digital-web",
    });
  });

  it("签名对固定字段数组计算，字段顺序不同即产生不同证明", () => {
    const produced = readyAttestation(identity, "nonce-1");
    expect(produced.runId).toBe(identity.runId);
    expect(produced.attestation).toBe(
      createHmac("sha256", identity.readyKey)
        .update(
          JSON.stringify([
            "digital-environment-ready-v1",
            identity.environmentId,
            identity.runId,
            "nonce-1",
          ]),
        )
        .digest("hex"),
    );
  });
});

afterAll(async () => {
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
});
