import { lstat, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureRawFilesystemSnapshot } from "@digital/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliRuntime } from "../../src/main.ts";
import { prepareCliProductData } from "../prepare-catalogue.ts";

const cleanupPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

async function disposableProductDataDirectory(): Promise<string> {
  return path.join(
    await temporaryDirectory("digital-disposable-cli-"),
    "product-data",
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
});

function runtime(
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: Record<string, string> },
) {
  let stdout = "";
  let stderr = "";
  return {
    runtime: {
      argv: ["node", "cli", ...args],
      streams: {
        stdin: {},
        stdout: { write: (chunk: string) => (stdout += chunk) },
        stderr: { write: (chunk: string) => (stderr += chunk) },
      },
      cwd: options.cwd,
      env: options.env ?? {},
      tty: { stdin: false, stdout: false, stderr: false },
      version: "1.2.3",
    } satisfies CliRuntime,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function registerRoot(input: {
  readonly source: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
}): Promise<string> {
  const command = runtime(["root-create", "测试文件位置", input.source], {
    cwd: input.cwd,
    env: input.env,
  });
  await expect(runCli(command.runtime)).resolves.toBe(0);
  return (JSON.parse(command.stdout()) as { readonly id: string }).id;
}

async function tree(
  root: string,
  options: { readonly ignoreDirectoryModifiedAt?: readonly string[] } = {},
): Promise<readonly string[]> {
  const ignoredDirectoryModifiedAt = new Set(
    options.ignoreDirectoryModifiedAt ?? [],
  );
  return (
    await captureRawFilesystemSnapshot(root, { contentDigests: true })
  ).entries
    .filter(
      (entry) =>
        entry.relativePath !== "." &&
        !entry.relativePath.split("/").includes("runtime-state"),
    )
    .map((entry) => {
      const modifiedAtNanoseconds =
        entry.kind === "directory" &&
        ignoredDirectoryModifiedAt.has(entry.relativePath)
          ? "<ignored>"
          : entry.modifiedAtNanoseconds;
      return `${entry.relativePath}:${entry.kind}:${entry.byteLength}:${modifiedAtNanoseconds}:${entry.symbolicLinkTarget ?? ""}:${entry.contentDigest ?? ""}`;
    });
}

describe("Asset Refresh CLI", () => {
  it("starts, completes, and revokes a Bangumi OAuth connection without printing private grants", async () => {
    const data = await disposableProductDataDirectory();
    await prepareCliProductData(data);
    const accessToken = "cli-bangumi-private-access";
    const refreshToken = "cli-bangumi-private-refresh";
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () =>
        new TextEncoder().encode(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3600,
          }),
        ).buffer,
    }));
    const env = {
      DIGITAL_PRODUCT_DATA: data,
      DIGITAL_BANGUMI_CLIENT_ID: "digital-cli-client",
      DIGITAL_BANGUMI_CLIENT_SECRET: "digital-cli-secret",
      DIGITAL_BANGUMI_REDIRECT_URI:
        "https://digital.example.test/api/source-connections/bangumi/callback",
    };

    const started = runtime(["bangumi-connection-authorize"], {
      cwd: "/workspace",
      env,
    });
    await expect(runCli(started.runtime)).resolves.toBe(0);
    const authorization = JSON.parse(started.stdout()) as {
      readonly authorizationUrl: string;
    };
    const callback = new URL(env.DIGITAL_BANGUMI_REDIRECT_URI);
    callback.searchParams.set("code", "cli-callback-code");
    callback.searchParams.set(
      "state",
      new URL(authorization.authorizationUrl).searchParams.get("state")!,
    );

    const completed = runtime(
      ["bangumi-connection-callback", callback.toString()],
      { cwd: "/workspace", env },
    );
    await expect(runCli(completed.runtime)).resolves.toBe(0);
    expect(JSON.parse(completed.stdout())).toMatchObject({
      id: "bangumi",
      version: 1,
      credentialStatus: "configured",
      availability: "available",
    });
    const revoked = runtime(
      ["bangumi-connection-revoke", "--expected-version", "1"],
      { cwd: "/workspace", env },
    );
    await expect(runCli(revoked.runtime)).resolves.toBe(0);
    expect(JSON.parse(revoked.stdout())).toMatchObject({
      version: 2,
      credentialStatus: "revoked",
      availability: "unavailable",
    });
    expect(
      `${started.stdout()}${completed.stdout()}${revoked.stdout()}`,
    ).not.toContain(accessToken);
    expect(
      `${started.stdout()}${completed.stdout()}${revoked.stdout()}`,
    ).not.toContain(refreshToken);
  });

  it("imports, replaces, and revokes one scoped FANBOX browser connection without reflecting its credentials", async () => {
    const data = await disposableProductDataDirectory();
    await prepareCliProductData(data);
    const credentialDirectory = await temporaryDirectory("digital-fanbox-cli-");
    const firstFile = path.join(credentialDirectory, "first.json");
    const secondFile = path.join(credentialDirectory, "second.json");
    const firstSecret = "cli-fanbox-first-private-session";
    const secondSecret = "cli-fanbox-second-private-session";
    await writeFile(
      firstFile,
      JSON.stringify([{ name: "FANBOXSESSID", value: firstSecret }]),
    );
    await writeFile(
      secondFile,
      JSON.stringify([{ name: "FANBOXSESSID", value: secondSecret }]),
    );
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () =>
        new TextEncoder().encode(JSON.stringify({ body: { userId: "123456" } }))
          .buffer,
    }));

    const imported = runtime(
      ["fanbox-connection-import", "customudon", firstFile],
      { cwd: "/workspace", env: { DIGITAL_PRODUCT_DATA: data } },
    );
    await expect(runCli(imported.runtime)).resolves.toBe(0);
    const first = JSON.parse(imported.stdout()) as { readonly version: number };
    expect(first.version).toBe(1);

    const replaced = runtime(
      [
        "fanbox-connection-replace",
        "customudon",
        secondFile,
        "--expected-version",
        String(first.version),
      ],
      { cwd: "/workspace", env: { DIGITAL_PRODUCT_DATA: data } },
    );
    await expect(runCli(replaced.runtime)).resolves.toBe(0);
    const second = JSON.parse(replaced.stdout()) as {
      readonly version: number;
    };
    expect(second.version).toBe(2);

    const revoked = runtime(
      [
        "fanbox-connection-revoke",
        "customudon",
        "--expected-version",
        String(second.version),
      ],
      { cwd: "/workspace", env: { DIGITAL_PRODUCT_DATA: data } },
    );
    await expect(runCli(revoked.runtime)).resolves.toBe(0);
    expect(JSON.parse(revoked.stdout())).toMatchObject({
      version: 3,
      credentialStatus: "revoked",
      availability: "unavailable",
    });
    expect(
      `${imported.stdout()}${replaced.stdout()}${revoked.stdout()}`,
    ).not.toContain(firstSecret);
    expect(
      `${imported.stdout()}${replaced.stdout()}${revoked.stdout()}`,
    ).not.toContain(secondSecret);
  });

  it("records an unsupported directory read-only and makes the execution inspectable later", async () => {
    const sourceDirectory = await temporaryDirectory("digital-source-");
    const dataDirectory = await disposableProductDataDirectory();
    const sourceFile = path.join(sourceDirectory, "ordinary.txt");
    await writeFile(sourceFile, "unchanged source bytes\n");
    await prepareCliProductData(dataDirectory);
    const before = await tree(sourceDirectory);

    const rootId = await registerRoot({
      source: sourceDirectory,
      cwd: "/workspace",
      env: { DIGITAL_PRODUCT_DATA: dataDirectory },
    });
    const scan = runtime(["scan", rootId, "--json"], {
      cwd: "/workspace",
      env: { DIGITAL_PRODUCT_DATA: dataDirectory },
    });
    await expect(runCli(scan.runtime)).resolves.toBe(0);
    const result = JSON.parse(scan.stdout()) as {
      readonly executionId: string;
      readonly execution: { readonly outcome: string };
    };
    expect(result.execution.outcome).toBe("unresolved");
    expect(scan.stderr()).toContain(`刷新记录：${result.executionId}`);

    const inspected = runtime(["inspect", result.executionId, "--json"], {
      cwd: "/workspace",
      env: { DIGITAL_PRODUCT_DATA: dataDirectory },
    });
    await expect(runCli(inspected.runtime)).resolves.toBe(0);
    expect(JSON.parse(inspected.stdout())).toMatchObject({
      executionId: result.executionId,
      execution: {
        outcome: "unresolved",
        snapshot: { complete: true, files: [{ relativePath: "ordinary.txt" }] },
      },
      unresolvedObservation: {
        observedRoot: sourceDirectory,
        fileCount: 1,
        totalSize: Buffer.byteLength("unchanged source bytes\n"),
        representativePaths: ["ordinary.txt"],
      },
    });
    expect(inspected.stdout()).not.toMatch(
      /stagedReference|managedSourceArtifacts|sourceArtifactAcquisitions/u,
    );

    const humanInspection = runtime(["inspect", result.executionId], {
      cwd: "/workspace",
      env: { DIGITAL_PRODUCT_DATA: dataDirectory },
    });
    await expect(runCli(humanInspection.runtime)).resolves.toBe(0);
    expect(humanInspection.stdout()).toContain(`观察范围：${sourceDirectory}`);
    expect(humanInspection.stdout()).toContain("总大小：23 字节");
    expect(humanInspection.stdout()).toContain("代表文件：ordinary.txt");
    expect(await tree(sourceDirectory)).toEqual(before);
  });

  it("uses an OS data root for scan . and leaves the complete observed tree unchanged", async () => {
    const source = await temporaryDirectory("digital-cwd-");
    const xdgData = await temporaryDirectory("digital-disposable-xdg-");
    const productDataDirectory = path.join(xdgData, "digital");
    await writeFile(path.join(source, "ordinary.txt"), "source");
    await writeFile(path.join(source, "nested.txt"), "nested");
    const before = await tree(source);
    await prepareCliProductData(productDataDirectory);

    const rootId = await registerRoot({
      source,
      cwd: source,
      env: { XDG_DATA_HOME: xdgData },
    });
    const scan = runtime(["scan", rootId, "--json"], {
      cwd: source,
      env: { XDG_DATA_HOME: xdgData },
    });
    await expect(runCli(scan.runtime)).resolves.toBe(0);

    expect(await tree(source)).toEqual(before);
    await expect(lstat(path.join(source, ".digital"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await stat(path.join(xdgData, "digital", "catalogue.sqlite"))).isFile(),
    ).toBe(true);
  });

  it("rejects an explicit product-data descendant before source observation can create it", async () => {
    const source = await temporaryDirectory("digital-disposable-overlap-");
    await writeFile(path.join(source, "ordinary.txt"), "source");
    const inside = path.join(source, "product-data");
    await prepareCliProductData(inside);
    // 打开已存在的产品数据库会短暂创建并移除 SQLite WAL，从而只改变这个已知可写目录的
    // mtime；这里仍完整比较其他目录、所有条目及文件摘要。
    const snapshotOptions = {
      ignoreDirectoryModifiedAt: ["product-data"],
    } as const;
    const before = await tree(source, snapshotOptions);

    const scan = runtime(["root-create", "重叠位置", source], {
      cwd: source,
      env: { DIGITAL_PRODUCT_DATA: inside },
    });
    await expect(runCli(scan.runtime)).resolves.toBe(1);

    expect(scan.stderr()).toContain("不能与产品数据或托管产物目录重叠");
    expect(await tree(source, snapshotOptions)).toEqual(before);
  });

  it("rejects a symlinked product-data alias before any source mutation", async () => {
    const source = await temporaryDirectory("digital-disposable-alias-source-");
    const aliasParent = await temporaryDirectory("digital-alias-parent-");
    await writeFile(path.join(source, "ordinary.txt"), "source");
    const alias = path.join(aliasParent, "observed-alias");
    await symlink(source, alias, "dir");
    const productData = path.join(alias, "product-data");
    await prepareCliProductData(productData);
    const snapshotOptions = {
      ignoreDirectoryModifiedAt: ["product-data"],
    } as const;
    const before = await tree(source, snapshotOptions);

    const scan = runtime(["root-create", "链接重叠位置", source], {
      cwd: source,
      env: { DIGITAL_PRODUCT_DATA: productData },
    });
    await expect(runCli(scan.runtime)).resolves.toBe(1);

    expect(scan.stderr()).toContain("不能与产品数据或托管产物目录重叠");
    expect(await tree(source, snapshotOptions)).toEqual(before);
  });

  it("does not treat legacy FANBOX environment variables as startup configuration", async () => {
    const data = await disposableProductDataDirectory();
    await prepareCliProductData(data);
    const connections = runtime(["source-connection-list"], {
      cwd: "/workspace",
      env: {
        DIGITAL_PRODUCT_DATA: data,
        DIGITAL_FANBOX_CREATOR_ID: "customudon",
      },
    });

    await expect(runCli(connections.runtime)).resolves.toBe(0);
    expect(JSON.parse(connections.stdout())).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fanbox/customudon" }),
      ]),
    );
  });

  it("accepts an exact source address for a new directory without requiring a current subject", async () => {
    const source = await temporaryDirectory("digital-directed-source-");
    const data = await disposableProductDataDirectory();
    await writeFile(path.join(source, "movie.mkv"), "source");
    await prepareCliProductData(data);
    const rootId = await registerRoot({
      source,
      cwd: source,
      env: { DIGITAL_PRODUCT_DATA: data },
    });
    const directed = runtime(
      [
        "scrape",
        rootId,
        "https://www.themoviedb.org/movie/9509",
        "--source-identity",
        "tmdb",
        "--json",
      ],
      {
        cwd: source,
        env: { DIGITAL_PRODUCT_DATA: data },
      },
    );

    await expect(runCli(directed.runtime)).resolves.toBe(1);
    expect(JSON.parse(directed.stdout())).toMatchObject({
      execution: {
        outcome: "failed",
        reason: expect.stringContaining("私有访问令牌"),
      },
    });
    expect(directed.stderr()).not.toContain("subject-id");
  });

  it("does not echo malformed FANBOX credential-file contents through CLI import failure", async () => {
    const data = await disposableProductDataDirectory();
    await prepareCliProductData(data);
    const credentialRoot = await temporaryDirectory(
      "digital-secret-credential-",
    );
    const credentialFile = path.join(credentialRoot, "fanbox.json");
    const secret = "cli-private-session-token";
    await writeFile(
      credentialFile,
      `[{"name":"FANBOXSESSID","value":"${secret}"}`,
    );
    const before = await tree(data);
    const imported = runtime(
      ["fanbox-connection-import", "customudon", credentialFile],
      {
        cwd: "/workspace",
        env: {
          DIGITAL_PRODUCT_DATA: data,
        },
      },
    );

    await expect(runCli(imported.runtime)).resolves.toBe(1);
    expect(`${imported.stdout()}\n${imported.stderr()}`).not.toContain(secret);
    expect(await tree(data)).toEqual(before);
  });
});
