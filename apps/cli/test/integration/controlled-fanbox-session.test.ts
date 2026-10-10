import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadControlledSourceIo } from "@digital/test-support/source-io";
import { expect, it } from "vitest";

import { prepareCliProductData } from "../prepare-catalogue.ts";

const execFileAsync = promisify(execFile);

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const cliEntry = path.join(workspaceRoot, "apps", "cli", "dist", "cli.js");
const fixtureDirectory = path.join(
  workspaceRoot,
  "fixtures",
  "controlled-fanbox-session",
);
const materialDirectory = path.join(fixtureDirectory, "material");
const credentialFile = path.join(
  fixtureDirectory,
  "connections",
  "synthetic-customudon.json",
);

const creatorId = "customudon";
const postId = "7225781";
const postTitle = "Movie | コスプレ4";
const publicationAddress = `https://www.fanbox.cc/@${creatorId}/posts/${postId}`;

type ChildResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * 正式构建的 CLI 可执行文件在独立操作系统子进程中运行：每次命令都自己完成受控来源选择、
 * 打开产品根、再关闭。子进程环境只给出白名单变量，不继承父进程的任何来源秘密。
 */
async function runFormalCli(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<ChildResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliEntry, ...args],
      {
        cwd: workspaceRoot,
        env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 300_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (failure) {
    const error = failure as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
    };
  }
}

async function controlledEnvironment(input: {
  readonly manifest: string;
  readonly data: string;
}): Promise<Record<string, string>> {
  const manifestPath = path.join(fixtureDirectory, input.manifest);
  const { contentIdentity } = await loadControlledSourceIo({ manifestPath });
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    DIGITAL_PRODUCT_DATA: input.data,
    DIGITAL_SOURCE_IO_MODE: "controlled",
    DIGITAL_SOURCE_IO_CONFIG: manifestPath,
    DIGITAL_SOURCE_IO_IDENTITY: contentIdentity,
  };
}

async function disposableRoot(marker: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `digital-disposable-${marker}-`));
}

function jsonValues(stdout: string): any[] {
  const values: any[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    values.push(JSON.parse(trimmed) as any);
  }
  return values;
}

/** 正式检查投影里的已接受主体视角：单项执行与多边界执行都覆盖。 */
function acceptedView(inspection: any): any {
  return inspection?.accepted ?? inspection?.itemResults?.[0]?.accepted;
}

it("正式 CLI 子进程经产品保存合成会话连接、由目录识别形成帖子并托管来源主图", async () => {
  const temporary = await disposableRoot("t09-cli-fanbox");
  const data = path.join(temporary, "data");
  const managedDirectory = path.join(data, "managed-artifacts");
  try {
    await prepareCliProductData(data);
    const env = await controlledEnvironment({
      manifest: "manifest.json",
      data,
    });
    const imported = await runFormalCli(
      ["fanbox-connection-import", creatorId, credentialFile],
      env,
    );
    expect(imported.code, imported.stderr).toBe(0);
    const connection = jsonValues(imported.stdout).at(-1);
    expect(connection).toMatchObject({
      creatorId,
      version: 1,
      credentialStatus: "configured",
      availability: "available",
    });
    // 合成凭据不回显在 CLI 的任何输出通道里。
    const credential = JSON.parse(await readFile(credentialFile, "utf8")) as {
      userAgent: string;
      cookies: { name: string; value: string }[];
    };
    const echoed = `${imported.stdout}${imported.stderr}`;
    for (const secret of [
      "FANBOXSESSID",
      credential.cookies[0]!.value,
      credential.userAgent,
    ])
      expect(echoed).not.toContain(secret);

    const created = await runFormalCli(
      [
        "library-create",
        "受控 FANBOX 会话库",
        "--directory",
        materialDirectory,
        "--profile",
        "fanbox",
        "--source",
        "fanbox",
        "--json",
      ],
      env,
    );
    expect(created.code, created.stderr).toBe(0);
    const rootIds = jsonValues(created.stdout).at(-1)!.rootIds as string[];
    expect(rootIds).toHaveLength(1);

    // 帖子只经正式扫描与识别工作流形成：任何命令都没有收到 postId。
    const scanned = await runFormalCli(
      ["scan", rootIds[0]!, "--scope", ".", "--json"],
      env,
    );
    expect(scanned.code, scanned.stderr).toBe(0);
    const inspection = jsonValues(scanned.stdout).at(-1);
    expect(inspection.execution.outcome).toBe("accepted");
    const accepted = acceptedView(inspection);
    expect(accepted.entity.id).toMatch(/^entity_/u);
    expect(accepted.sourceAssociations).toEqual([
      { sourceIdentity: "fanbox", nativeAddress: publicationAddress },
    ]);

    const facts = JSON.stringify(accepted.facts);
    expect(facts).toContain(postTitle);
    expect(facts).toContain("2023-12-31T17:10:55+09:00");
    // 交付视图不含受控拒绝的边界标识，也不含合成凭据。
    const delivered = JSON.stringify(inspection);
    expect(delivered).not.toContain("受控来源拒绝");
    expect(delivered).not.toContain("请求键");
    expect(delivered).not.toContain('"fanbox-session"');
    expect(delivered).not.toContain(credential.cookies[0]!.value);

    // CLI 观察本次受控响应托管到当前产品根的主图：位置、摘要、媒体与来源证据。
    const revision = accepted.artifactRevisions.find(
      (item: any) => item.artifactId === accepted.primaryCoverArtifactId,
    );
    expect(revision.producer.capabilityId).toBe(
      "fanbox.source-artifact-acquirer",
    );
    const cover = new Uint8Array(
      await readFile(
        path.join(fixtureDirectory, "responses", "fanbox-cover.png"),
      ),
    );
    const coverDigest = createHash("sha256").update(cover).digest("hex");
    expect(revision.blobDigest).toBe(coverDigest);
    const blob = accepted.blobs.find(
      (item: any) => item.digest === coverDigest,
    );
    expect(blob.mediaType).toBe("image/png");
    expect(blob.byteLength).toBe(cover.byteLength);
    const managed = accepted.locations.find(
      (item: any) =>
        item.kind === "managed" &&
        item.artifactId === accepted.primaryCoverArtifactId,
    );
    expect(managed.address).toBe(
      path.join(managedDirectory, coverDigest.slice(0, 2), coverDigest),
    );
    const managedBytes = new Uint8Array(await readFile(managed.address));
    expect(managedBytes).toEqual(cover);
    // 独立解码：托管字节确为一张有效的 8×8 PNG。
    const managedBuffer = Buffer.from(managedBytes);
    expect(managedBuffer.subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect(managedBuffer.readUInt32BE(16)).toBe(8);
    expect(managedBuffer.readUInt32BE(20)).toBe(8);
    // 主图的来源证据指向同一篇帖子的官方来源记录。
    const coverAssociation = accepted.artifactAssociations.find(
      (item: any) =>
        item.role === "asset.primary-cover" &&
        item.artifactId === accepted.primaryCoverArtifactId,
    );
    const recordedIds = new Set(
      inspection.sourceRecords.map((item: any) => item.id),
    );
    expect(
      coverAssociation.sourceRecordIds.every((id: string) =>
        recordedIds.has(id),
      ),
    ).toBe(true);

    // 重启后连接由产品私有存储恢复，且仍然不含真实凭据。
    const listed = await runFormalCli(["source-connection-list"], env);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.stringify(jsonValues(listed.stdout).at(-1))).toContain(
      creatorId,
    );
    expect(listed.stdout).not.toContain(credential.cookies[0]!.value);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 600_000);

it("缺少会话条目的清单让正式 CLI 连接导入失败且不落库", async () => {
  const temporary = await disposableRoot("t09-cli-fanbox-refusal");
  const data = path.join(temporary, "data");
  try {
    await prepareCliProductData(data);
    const env = await controlledEnvironment({
      manifest: "manifest-without-session.json",
      data,
    });
    const imported = await runFormalCli(
      ["fanbox-connection-import", creatorId, credentialFile],
      env,
    );
    expect(imported.code).toBe(1);
    const output = `${imported.stdout}${imported.stderr}`;
    expect(output).toContain("FANBOX 来源连接验证失败");
    // 受控拒绝的诊断标识与合成凭据都不进入 CLI 输出。
    expect(output).not.toContain("受控来源拒绝");
    expect(output).not.toContain("请求键");
    expect(output).not.toContain("fanbox-session");
    expect(output).not.toContain("FANBOXSESSID");

    const listed = await runFormalCli(["source-connection-list"], env);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.stringify(jsonValues(listed.stdout).at(-1))).not.toContain(
      creatorId,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 300_000);
