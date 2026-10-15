import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ControlledRequestRefusal,
  ControlledSourceIoStartupProblem,
  loadControlledSourceIo,
  refusingSessionTransport,
  resolveSourceIoFromEnvironment,
  sourceIoConfigVariable,
  sourceIoIdentityVariable,
  sourceIoModeVariable,
  type ControlledSourceIoManifestInput,
} from "../src/source-io.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeManifest(
  entries: ControlledSourceIoManifestInput["ordinary"],
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "t06-controlled-io-"));
  temporaryDirectories.push(directory);
  for (const entry of entries) {
    const responsePath = path.join(directory, entry.responseFile);
    await mkdir(path.dirname(responsePath), { recursive: true });
    await writeFile(responsePath, `响应正文 ${entry.id}`);
  }
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ formatVersion: 1, ordinary: entries }),
  );
  return manifestPath;
}

const ajaxEntry: ControlledSourceIoManifestInput["ordinary"][number] = {
  id: "dlsite-product-ajax",
  url: "https://www.dlsite.com/maniax/product/info/ajax?product_id=RJ01668691",
  method: "GET",
  status: 200,
  mediaType: "application/json",
  responseFile: "responses/ajax.json",
};

const pageEntry: ControlledSourceIoManifestInput["ordinary"][number] = {
  id: "dlsite-product-page",
  url: "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
  method: "GET",
  status: 200,
  mediaType: "text/html",
  finalUrl: "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
  responseFile: "responses/page.html",
};

describe("受控来源清单的加载与请求匹配", () => {
  it("按精确方法与地址命中，每次调用给出独立字节", async () => {
    const loaded = await loadControlledSourceIo({
      manifestPath: await writeManifest([ajaxEntry, pageEntry]),
    });
    expect(loaded.entryIds).toEqual([
      "dlsite-product-ajax",
      "dlsite-product-page",
    ]);

    const first = await loaded.request(ajaxEntry.url);
    expect(first.ok).toBe(true);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/json");
    const second = await loaded.request(ajaxEntry.url);
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    firstBytes[0] = 0;
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      new TextEncoder().encode("响应正文 dlsite-product-ajax"),
    );

    const page = await loaded.request(pageEntry.url);
    expect(page.url).toBe(pageEntry.finalUrl);
    await expect(
      loaded.request(ajaxEntry.url, { method: "post" }),
    ).rejects.toBeInstanceOf(ControlledRequestRefusal);
  });

  it("未列入清单的地址、额外参数与不同查询值都被拒绝", async () => {
    const loaded = await loadControlledSourceIo({
      manifestPath: await writeManifest([ajaxEntry]),
    });
    for (const url of [
      "https://www.dlsite.com/maniax/product/info/ajax?product_id=RJ01497788",
      "https://www.dlsite.com/maniax/product/info/ajax",
      "https://api.themoviedb.org/3/movie/1?api_key=合成令牌",
      "https://img.dlsite.jp/modpub/images2/work/doujin/RJ01669000/RJ01668691_img_main.png",
    ]) {
      const refusal = await loaded
        .request(url)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ControlledRequestRefusal);
    }
    const refusal = await loaded
      .request(
        "https://api.themoviedb.org/3/movie/1?api_key=合成令牌&session=abc123",
      )
      .catch((error: unknown) => error);
    expect((refusal as ControlledRequestRefusal).message).toContain(
      "GET https://api.themoviedb.org/3/movie/1",
    );
    expect((refusal as ControlledRequestRefusal).message).not.toMatch(
      /api_key|session|合成令牌/u,
    );
  });

  it("清单要求的请求头与请求体条件不满足时拒绝", async () => {
    const conditional: ControlledSourceIoManifestInput["ordinary"][number] = {
      ...ajaxEntry,
      id: "conditional",
      require: {
        headers: { "x-language": "ja-jp" },
        body: "product=RJ01668691",
      },
    };
    const loaded = await loadControlledSourceIo({
      manifestPath: await writeManifest([conditional]),
    });
    await expect(
      loaded.request(conditional.url, {
        headers: { "x-language": "en-us" },
        body: "product=RJ01668691",
      }),
    ).rejects.toBeInstanceOf(ControlledRequestRefusal);
    await expect(
      loaded.request(conditional.url, {
        headers: { "x-language": "ja-jp" },
        body: "product=OTHER",
      }),
    ).rejects.toBeInstanceOf(ControlledRequestRefusal);
    const matched = await loaded.request(conditional.url, {
      headers: { "x-language": "ja-jp" },
      body: "product=RJ01668691",
    });
    expect(matched.ok).toBe(true);
  });

  it("内容身份只由条目与响应摘要决定，与声明顺序无关", async () => {
    const first = await loadControlledSourceIo({
      manifestPath: await writeManifest([ajaxEntry, pageEntry]),
    });
    const second = await loadControlledSourceIo({
      manifestPath: await writeManifest([pageEntry, ajaxEntry]),
    });
    expect(first.contentIdentity).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(second.contentIdentity).toBe(first.contentIdentity);
    const mismatch = await loadControlledSourceIo({
      manifestPath: await writeManifest([ajaxEntry]),
      expectedContentIdentity: first.contentIdentity,
    }).catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(ControlledSourceIoStartupProblem);
  });

  it("未知字段、越界响应文件与不完整地址都在读取阶段失败", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t06-controlled-io-"));
    temporaryDirectories.push(directory);
    const cases = [
      { formatVersion: 2, ordinary: [ajaxEntry] },
      { formatVersion: 1, ordinary: [{ ...ajaxEntry, extra: 1 }] },
      { formatVersion: 1, ordinary: [ajaxEntry], session: [] },
      {
        formatVersion: 1,
        ordinary: [{ ...ajaxEntry, responseFile: "../outside.json" }],
      },
      {
        formatVersion: 1,
        ordinary: [
          {
            ...ajaxEntry,
            url: "https://www.dlsite.com/maniax/../product/info/ajax?product_id=RJ01668691",
          },
        ],
      },
      { formatVersion: 1, ordinary: [ajaxEntry, ajaxEntry] },
    ];
    for (const document of cases) {
      const manifestPath = path.join(directory, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(document));
      const failure = await loadControlledSourceIo({
        manifestPath,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ControlledSourceIoStartupProblem);
    }
  });
});

describe("可执行根的受控来源启动解析", () => {
  it("未声明模式保留真实启动，显式受控的任何缺项都在准入前失败", async () => {
    await expect(resolveSourceIoFromEnvironment({})).resolves.toEqual({
      mode: "real",
    });
    const manifestPath = await writeManifest([ajaxEntry]);
    const loaded = await loadControlledSourceIo({ manifestPath });
    await expect(
      resolveSourceIoFromEnvironment({
        [sourceIoModeVariable]: "controlled",
        [sourceIoConfigVariable]: manifestPath,
        [sourceIoIdentityVariable]: loaded.contentIdentity,
      }),
    ).resolves.toMatchObject({ mode: "controlled" });

    const failures: Readonly<Record<string, string | undefined>>[] = [
      { [sourceIoModeVariable]: "controlled" },
      {
        [sourceIoModeVariable]: "controlled",
        [sourceIoConfigVariable]: manifestPath,
      },
      {
        [sourceIoModeVariable]: "controlled",
        [sourceIoConfigVariable]: "relative/manifest.json",
        [sourceIoIdentityVariable]: loaded.contentIdentity,
      },
      {
        [sourceIoModeVariable]: "controlled",
        [sourceIoConfigVariable]: manifestPath,
        [sourceIoIdentityVariable]: "sha256:不完整",
      },
      {
        [sourceIoModeVariable]: "controlled",
        [sourceIoConfigVariable]: path.join(
          path.dirname(manifestPath),
          "缺失.json",
        ),
        [sourceIoIdentityVariable]: loaded.contentIdentity,
      },
      {
        [sourceIoModeVariable]: "offline",
        [sourceIoConfigVariable]: manifestPath,
      },
      {
        [sourceIoModeVariable]: "real",
        [sourceIoConfigVariable]: manifestPath,
      },
      { [sourceIoModeVariable]: "未整合来源" },
    ];
    for (const environment of failures) {
      await expect(
        resolveSourceIoFromEnvironment({ ...environment }),
      ).rejects.toBeInstanceOf(ControlledSourceIoStartupProblem);
    }
  });

  it("显式离线注入完整依赖集合，普通请求与会话都在到达网络之前被拒", async () => {
    const resolved = await resolveSourceIoFromEnvironment({
      [sourceIoModeVariable]: "offline",
    });
    expect(resolved).toMatchObject({ mode: "offline" });
    if (resolved.mode === "real") throw new Error("离线选择不得落回真实装配");
    await expect(
      resolved.request(
        "https://www.dlsite.com/maniax/product/info/ajax?product_id=RJ01668691",
      ),
    ).rejects.toBeInstanceOf(ControlledRequestRefusal);
    await expect(
      resolved.sessionTransport.transact({
        creatorId: "offline-creator",
        privateContext: {
          format: "fanbox-browser-request-context/2",
          userAgent: "offline-test",
          cookies: [],
        },
        use: async (get) => await get({ kind: "login-status" }),
      }),
    ).rejects.toBeInstanceOf(ControlledRequestRefusal);
  });
});

describe("受控 FANBOX 会话 transport", () => {
  it("任何会话事务都被拒绝，关闭后不再提供事务", async () => {
    const transport = refusingSessionTransport();
    await expect(transport.transact()).rejects.toBeInstanceOf(
      ControlledRequestRefusal,
    );
    await transport.close();
    await expect(transport.transact()).rejects.toThrow(
      "受控 FANBOX 会话 transport 已关闭",
    );
  });
});
