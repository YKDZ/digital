import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runProduct } from "@digital/composition";
import { captureRawFilesystemSnapshot } from "@digital/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliRuntime } from "../../src/main.ts";
import { prepareCliProductData } from "../prepare-catalogue.ts";

vi.mock("@digital/fanbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@digital/fanbox")>();
  return {
    ...actual,
    createFanboxProductAssembly: () => ({
      async validatedBrowserCredential(input: {
        readonly browserCredential: unknown;
      }) {
        const credential = input.browserCredential as {
          readonly userAgent: string;
          readonly cookies: readonly unknown[];
        };
        return JSON.stringify({
          format: "fanbox-browser-request-context/2",
          userAgent: credential.userAgent,
          cookies: credential.cookies,
        });
      },
      async verifyStoredCredential() {},
      createCollector: () => ({
        capability: actual.fanboxOfficialCollectionCapability,
        canCollect: () => false,
        coverageScopeIds: () => [],
        collect: async () => ({ records: [], failures: [] }),
      }),
      async close() {},
    }),
  };
});

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
  vi.unstubAllGlobals();
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
  const command = runtime(
    ["library-create", "测试文件位置", "--directory", input.source, "--json"],
    {
      cwd: input.cwd,
      env: input.env,
    },
  );
  await expect(runCli(command.runtime)).resolves.toBe(0);
  return (
    JSON.parse(command.stdout()) as { readonly rootIds: readonly string[] }
  ).rootIds[0]!;
}

/** 通过公开的资产库入口登记单一目录，返回该目录对应的观察根编号。 */
async function seedLibraryRoot(
  workflow: {
    readonly assetLibraries: {
      save(input: {
        readonly displayName: string;
        readonly directories: readonly string[];
        readonly recognitionProfileIds: readonly string[];
        readonly sourceIdentities: readonly string[];
      }): Promise<{ readonly rootIds: readonly string[] }>;
      readonly recognitionProfiles: readonly { readonly id: string }[];
      readonly sources: readonly { readonly id: string }[];
    };
  },
  displayName: string,
  directory: string,
): Promise<string> {
  const libraries = workflow.assetLibraries;
  const saved = await libraries.save({
    displayName,
    directories: [directory],
    recognitionProfileIds: libraries.recognitionProfiles.map(
      (profile) => profile.id,
    ),
    sourceIdentities: libraries.sources.map((source) => source.id),
  });
  return saved.rootIds[0]!;
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
  it("directs new material through a source-owned structured input", async () => {
    const source = await temporaryDirectory("digital-cli-directed-input-");
    const data = await disposableProductDataDirectory();
    await writeFile(path.join(source, "new.pdf"), syntheticPdf());
    await prepareCliProductData(data);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            docs: [
              {
                pnx: {
                  display: { title: ["CLI 定向书名"] },
                  addata: { isbn: ["9789864738281"] },
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const rootId = await registerRoot({
      source,
      cwd: source,
      env: { DIGITAL_PRODUCT_DATA: data },
    });
    const directed = runtime(
      [
        "scrape-source",
        rootId,
        "nbinet",
        JSON.stringify({ isbn: "9789864738281" }),
        "--json",
      ],
      { cwd: source, env: { DIGITAL_PRODUCT_DATA: data } },
    );
    expect(await runCli(directed.runtime), directed.stderr()).toBe(0);
    const directedPage = JSON.parse(directed.stdout()) as {
      execution: { outcome?: string };
      itemResults: {
        outcome?: string;
        accepted?: {
          entity: { id: string };
          facts: {
            id: string;
            descriptions: {
              metadata: {
                property: string;
                result: {
                  status: string;
                  values?: { value: string; sourceIdentity: string }[];
                };
              }[];
            }[];
          };
          sourceAssociations: { sourceIdentity: string }[];
        };
      }[];
    };
    expect(directedPage.execution.outcome).toBe("accepted");
    expect(directedPage.itemResults).toHaveLength(1);
    const directedAccepted = directedPage.itemResults[0]!.accepted;
    expect(directedAccepted?.sourceAssociations).toEqual([
      expect.objectContaining({ sourceIdentity: "nbinet" }),
    ]);
    expect(directedAccepted?.entity.id).toBeTruthy();
    expect(directedAccepted?.facts.id).toBe(directedAccepted?.entity.id);
    expect(
      directedAccepted?.facts.descriptions
        .flatMap((description) => description.metadata)
        .map((entry) => [
          entry.property,
          entry.result.status,
          entry.result.values?.[0]?.value,
          entry.result.values?.[0]?.sourceIdentity,
        ]),
    ).toEqual([
      ["asset.title", "resolved", "CLI 定向书名", "nbinet"],
      ["book.isbn-13", "resolved", "9789864738281", "nbinet"],
    ]);
  });

  it("uses the public product use case for source requirements and explicit enrichment", async () => {
    const source = await temporaryDirectory("digital-cli-source-enrichment-");
    const data = await disposableProductDataDirectory();
    await writeFile(path.join(source, "manual.pdf"), syntheticPdf());
    await prepareCliProductData(data);
    const product = runProduct(
      { productDataDirectory: data, environment: {} },
      { start: (application) => application.workflow },
    );
    const workflow = product.result;
    let assetId: string;
    try {
      const rootId = await seedLibraryRoot(workflow, "明确来源材料", source);
      const scan = await workflow.scanObservedScope({
        registrationId: rootId,
        relativeScope: ".",
        acceptTrusted: false,
      });
      const review = await workflow.prepareLocalContent({
        executionId: scan.execution.id,
        relativePaths: ["manual.pdf"],
        name: "CLI 本地书",
        classification: "book",
      });
      assetId = (
        await workflow.confirmLocalContent({ executionId: review.executionId })
      ).content.entity.id;
    } finally {
      await product.close();
    }
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            docs: [
              {
                pnx: {
                  display: { title: ["CLI 来源书名"] },
                  addata: { isbn: ["9789864738281"] },
                },
              },
              {
                pnx: {
                  display: { title: ["CLI 更换来源书名"] },
                  addata: { isbn: ["9786264151726"] },
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const inputs = runtime(["source-inputs", "--json"], {
      cwd: source,
      env: { DIGITAL_PRODUCT_DATA: data },
    });
    await expect(runCli(inputs.runtime)).resolves.toBe(0);
    expect(
      (
        JSON.parse(inputs.stdout()) as readonly {
          readonly sourceIdentity: string;
        }[]
      ).map(({ sourceIdentity }) => sourceIdentity),
    ).toEqual(["dlsite", "nbinet", "tmdb", "taiwan-kadokawa", "kadokawa-jp"]);
    const invalid = runtime(
      [
        "enrich-source",
        assetId,
        "nbinet",
        JSON.stringify({ isbn: "not-an-isbn" }),
        "--json",
      ],
      { cwd: source, env: { DIGITAL_PRODUCT_DATA: data } },
    );
    expect(await runCli(invalid.runtime)).toBe(1);
    expect(invalid.stderr()).toContain("ISBN-13");
    const enriched = runtime(
      [
        "enrich-source",
        assetId,
        "nbinet",
        JSON.stringify({ isbn: "9789864738281" }),
        "--json",
      ],
      { cwd: source, env: { DIGITAL_PRODUCT_DATA: data } },
    );
    await expect(runCli(enriched.runtime)).resolves.toBe(0);
    const enrichedInspection = JSON.parse(enriched.stdout()) as {
      readonly accepted: {
        readonly sourceAssociations: readonly {
          readonly id: string;
          readonly sourceIdentity: string;
        }[];
      };
    };
    expect(enrichedInspection).toMatchObject({
      execution: { outcome: "accepted", acceptedAssetId: assetId },
      accepted: {
        entity: { id: assetId },
        sourceAssociations: [
          expect.objectContaining({ sourceIdentity: "nbinet" }),
        ],
      },
    });
    const beforeAudit = runtime(
      ["inspect-correction-subject", assetId, "--json"],
      { cwd: source, env: { DIGITAL_PRODUCT_DATA: data } },
    );
    await expect(runCli(beforeAudit.runtime)).resolves.toBe(0);
    const nbinetAssociation = (
      JSON.parse(beforeAudit.stdout()) as {
        readonly current: readonly {
          readonly id: string;
          readonly sourceIdentity: string;
        }[];
      }
    ).current.find(({ sourceIdentity }) => sourceIdentity === "nbinet")!;
    const replace = runtime(
      [
        "source-decision",
        "replace",
        assetId,
        nbinetAssociation.id,
        JSON.stringify({ isbn: "9786264151726" }),
        "--actor",
        "cli-reviewer",
        "--json",
      ],
      { cwd: source, env: { DIGITAL_PRODUCT_DATA: data } },
    );
    expect(await runCli(replace.runtime), replace.stderr()).toBe(0);
    const replacementJson = replace.stdout();
    const replacementInspection = JSON.parse(replacementJson) as {
      readonly candidates: readonly unknown[];
      readonly evidenceComparison: {
        readonly sourceCandidates: readonly unknown[];
      };
    };
    expect(replacementInspection.candidates.length).toBeGreaterThan(0);
    expect(
      replacementInspection.evidenceComparison.sourceCandidates.length,
    ).toBeGreaterThan(0);
    for (const forbidden of [
      source,
      "interpretation",
      "sourceRecordIds",
      "producer",
      "capabilityId",
      "capabilityVersion",
      "contractVersion",
    ])
      expect(replacementJson).not.toContain(forbidden);
    const retract = runtime(
      [
        "source-decision",
        "retract",
        assetId,
        nbinetAssociation.id,
        "错误来源关联",
        "--actor",
        "cli-reviewer",
        "--json",
      ],
      { cwd: source, env: { DIGITAL_PRODUCT_DATA: data } },
    );
    expect(await runCli(retract.runtime), retract.stderr()).toBe(0);
    expect(retract.stdout()).not.toContain(source);
    expect(retract.stdout()).not.toContain("capabilityId");
    const retractionInspection = JSON.parse(retract.stdout()) as {
      readonly executionId: string;
      readonly preview: { readonly id: string; readonly status: string };
    };
    expect(retractionInspection).toMatchObject({
      state: "awaiting-confirmation",
      preview: { status: "awaiting-confirmation" },
    });
    const apply = runtime(
      [
        "apply-preview",
        retractionInspection.preview.id,
        "--actor",
        "cli-reviewer",
        "--json",
      ],
      { cwd: source, env: { DIGITAL_PRODUCT_DATA: data } },
    );
    expect(await runCli(apply.runtime), apply.stderr()).toBe(0);
    expect(JSON.parse(apply.stdout())).toMatchObject({
      preview: { status: "applied" },
    });
    const audit = runtime(["inspect-correction-subject", assetId, "--json"], {
      cwd: source,
      env: { DIGITAL_PRODUCT_DATA: data },
    });
    await expect(runCli(audit.runtime)).resolves.toBe(0);
    expect(JSON.parse(audit.stdout())).toMatchObject({
      current: [],
      historical: expect.arrayContaining([
        expect.objectContaining({
          association: expect.objectContaining({ id: nbinetAssociation.id }),
          status: "retracted",
          authorizedBy: expect.objectContaining({
            kind: "source-association-decision",
          }),
        }),
      ]),
    });
  });

  it("默认普通重扫和重开保留 DLsite 官方封面及 PDF 精确文件图片", async () => {
    const fixture = await temporaryDirectory("digital-cli-file-image-");
    const source = path.join(fixture, "RJ01668691");
    const data = await disposableProductDataDirectory();
    await mkdir(path.join(source, "台本"), { recursive: true });
    await writeFile(path.join(source, "track.wav"), new Uint8Array(44));
    await writeFile(path.join(source, "台本", "script.pdf"), syntheticPdf());
    await prepareCliProductData(data);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (address.includes("/product/info/ajax")) {
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "带台本的音声作品",
              regist_date: "2026-07-17",
              work_image: "//img.dlsite.jp/official.jpg",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (
        address ===
        "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html"
      ) {
        return new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (address === "https://img.dlsite.jp/official.jpg") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const env = { DIGITAL_PRODUCT_DATA: data };
    const rootId = await registerRoot({ source, cwd: source, env });
    const initialScan = runtime(
      [
        "scan",
        rootId,
        "--require-artifact-role",
        "asset.primary-cover",
        "asset.material-image",
        "--json",
      ],
      { cwd: source, env },
    );
    const initialScanExit = await runCli(initialScan.runtime);
    expect(initialScanExit, initialScan.stderr()).toBe(0);
    const initialScanResult = JSON.parse(initialScan.stdout()) as {
      execution: { id: string; outcome?: string };
      itemResults: {
        accepted?: {
          entity: { id: string };
          facts: {
            id: string;
            descriptions: { artifactRoles: { role: string }[] }[];
            locations: { kind: string; content: { status: string } }[];
          };
        };
      }[];
    };
    const initialAccepted = initialScanResult.itemResults[0]!.accepted;
    expect(initialScanResult.execution.outcome).toBe("accepted");
    expect(initialAccepted?.entity.id).toBeTruthy();
    expect(initialAccepted?.facts.id).toBe(initialAccepted?.entity.id);
    expect(
      initialAccepted?.facts.descriptions
        .flatMap((description) =>
          description.artifactRoles.map((entry) => entry.role),
        )
        .includes("asset.primary-cover"),
    ).toBe(true);
    expect(
      initialAccepted?.facts.locations.some(
        (location) =>
          location.kind === "managed" &&
          location.content.status === "confirmed",
      ),
    ).toBe(true);

    // PDF 精确文件图片是原始观察部件，按 ADR 0086 只经显式检查入口核验，
    // 不在普通消费投影里另开第二条旁路。
    const initialAssociations = await inspectedArtifactAssociations(
      initialScanResult.execution.id,
      source,
      env,
    );
    expect(
      initialAssociations.filter(
        (association) => association.role === "asset.material-image",
      ),
    ).toEqual([
      expect.objectContaining({
        observedArtifactPart: expect.objectContaining({
          revisionId: expect.any(String),
          locator: "pdf:page[1]",
        }),
      }),
    ]);
    const initialMaterialRevisionId = initialAssociations.find(
      (association) => association.role === "asset.material-image",
    )?.observedArtifactPart?.revisionId;

    const initialSurface = runtime(
      ["catalogue-surface", "--surface", "current-catalogue"],
      { cwd: source, env },
    );
    const initialSurfaceExit = await runCli(initialSurface.runtime);
    expect(initialSurfaceExit, initialSurface.stderr()).toBe(0);
    const [initial] = (
      JSON.parse(initialSurface.stdout()) as {
        items: {
          id: string;
          descriptions: {
            artifactRoles: { role: string; artifactId: string }[];
          }[];
          locations: unknown[];
        }[];
      }
    ).items;
    expect(initial?.id).toBe(initialAccepted?.entity.id);
    expect(
      initial?.descriptions.flatMap((description) =>
        description.artifactRoles.map((entry) => entry.role),
      ),
    ).toEqual(
      expect.arrayContaining(["asset.primary-cover", "asset.material-image"]),
    );
    // 主封面的“恰一项”在现行有界公开语义里由共同单值裁决表达：每个角色只
    // 投影一条生效条目；未采用与历史关联的原始计数仍按上一条在显式 inspect 入口可查。
    expect(
      initial?.descriptions.flatMap((description) =>
        description.artifactRoles.filter(
          (entry) => entry.role === "asset.primary-cover",
        ),
      ),
    ).toHaveLength(1);
    expect(initial?.locations.length).toBeGreaterThan(0);

    const defaultScan = runtime(["scan", rootId, "--json"], {
      cwd: source,
      env,
    });
    await expect(runCli(defaultScan.runtime)).resolves.toBe(0);
    const defaultScanResult = JSON.parse(defaultScan.stdout()) as {
      execution: { id: string; outcome?: string };
    };
    // 初次扫描已完成材料确认，未变化重扫保留同一结果。
    expect(defaultScanResult.execution.outcome).toBe("no-change");
    const reopenedSurface = runtime(
      ["catalogue-surface", "--surface", "current-catalogue"],
      { cwd: source, env },
    );
    await expect(runCli(reopenedSurface.runtime)).resolves.toBe(0);
    const reopened = (
      JSON.parse(reopenedSurface.stdout()) as {
        items: (typeof initial)[];
      }
    ).items[0];
    expect(reopened?.id).toBe(initial?.id);
    expect(reopened?.descriptions).toEqual(initial?.descriptions);
    expect(reopened?.locations).toEqual(initial?.locations);
    expect(
      reopened?.descriptions.flatMap((description) =>
        description.artifactRoles.filter(
          (entry) => entry.role === "asset.primary-cover",
        ),
      ),
    ).toHaveLength(1);
    // 普通重扫后必须重新经显式入口核验同一精确部件：普通 facts 的身份、角色与
    // 位置一致不能替代它，部件丢失或改页在此处必须可见。
    const reopenedAssociations = await inspectedArtifactAssociations(
      defaultScanResult.execution.id,
      source,
      env,
    );
    expect(
      reopenedAssociations.filter(
        (association) => association.role === "asset.material-image",
      ),
    ).toEqual([
      expect.objectContaining({
        observedArtifactPart: expect.objectContaining({
          revisionId: expect.any(String),
          locator: "pdf:page[1]",
        }),
      }),
    ]);
    expect(
      reopenedAssociations.filter(
        (association) => association.role === "asset.material-image",
      )[0]?.observedArtifactPart?.revisionId,
    ).toBe(initialMaterialRevisionId);

    const repeatedScan = runtime(["scan", rootId, "--json"], {
      cwd: source,
      env,
    });
    await expect(runCli(repeatedScan.runtime)).resolves.toBe(0);
    const repeatedScanResult = JSON.parse(repeatedScan.stdout()) as {
      execution: { id: string; outcome?: string };
    };
    expect(repeatedScanResult.execution.outcome).toBe("no-change");
    const repeatedSurface = runtime(
      ["catalogue-surface", "--surface", "current-catalogue"],
      { cwd: source, env },
    );
    await expect(runCli(repeatedSurface.runtime)).resolves.toBe(0);
    expect(JSON.parse(repeatedSurface.stdout())).toEqual(
      JSON.parse(reopenedSurface.stdout()),
    );
    // no-change 之后的稳定比较仍要覆盖同一材料语义：重读同一显式入口，精确部件
    // 的载体修订与页定位必须与重扫时一致，才构成原断言要求的稳定证明。
    const stableAssociations = await inspectedArtifactAssociations(
      defaultScanResult.execution.id,
      source,
      env,
    );
    expect(stableAssociations).toEqual(reopenedAssociations);
  }, 30_000);

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
      JSON.stringify({
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: firstSecret,
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      }),
    );
    await writeFile(
      secondFile,
      JSON.stringify({
        userAgent: "test-browser/1",
        cookies: [
          {
            name: "FANBOXSESSID",
            value: secondSecret,
            domain: ".fanbox.cc",
            path: "/",
          },
        ],
      }),
    );

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

    const scan = runtime(
      ["library-create", "重叠位置", "--directory", source, "--json"],
      {
        cwd: source,
        env: { DIGITAL_PRODUCT_DATA: inside },
      },
    );
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
    const canonicalProductData = path.join(source, "product-data");
    await prepareCliProductData(canonicalProductData);
    const productData = path.join(alias, "product-data");
    const snapshotOptions = {
      ignoreDirectoryModifiedAt: ["product-data"],
    } as const;
    const before = await tree(source, snapshotOptions);

    const scan = runtime(
      ["library-create", "链接重叠位置", "--directory", source, "--json"],
      {
        cwd: source,
        env: { DIGITAL_PRODUCT_DATA: productData },
      },
    );
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

  it("prepares, inspects, and confirms observed material through the real CLI product", async () => {
    const admitted = await temporaryDirectory("digital-cli-material-target-");
    const material = await temporaryDirectory("digital-cli-material-source-");
    const data = await disposableProductDataDirectory();
    await writeFile(path.join(admitted, "initial.pdf"), syntheticPdf());
    await writeFile(path.join(material, "appendix.txt"), "CLI whole material");
    await prepareCliProductData(data);
    const product = runProduct(
      { productDataDirectory: data, environment: {} },
      { start: (application) => application.workflow },
    );
    let assetId: string;
    let rootId: string;
    try {
      const targetRootId = await seedLibraryRoot(
        product.result,
        "CLI target",
        admitted,
      );
      await product.result.scanObservedScope({
        registrationId: targetRootId,
        relativeScope: ".",
        acceptTrusted: true,
      });
      assetId = (await product.result.listCurrentCataloguePage()).items[0]!.id;
      rootId = await seedLibraryRoot(product.result, "CLI material", material);
    } finally {
      await product.close();
    }
    const env = { DIGITAL_PRODUCT_DATA: data };
    const prepared = runtime(
      [
        "material-association-prepare",
        "--asset",
        assetId,
        "--root",
        rootId,
        "--scope",
        ".",
        "--file",
        "appendix.txt",
        "--initiated-by",
        "cli-prepare",
      ],
      { cwd: material, env },
    );
    expect(await runCli(prepared.runtime), prepared.stderr()).toBe(0);
    const preparedResult = JSON.parse(prepared.stdout()) as {
      readonly executionId: string;
      readonly status: string;
    };
    expect(preparedResult.status).toBe("awaiting-confirmation");
    const inspected = runtime(
      ["material-association-inspect", preparedResult.executionId],
      { cwd: material, env },
    );
    expect(await runCli(inspected.runtime), inspected.stderr()).toBe(0);
    expect(JSON.parse(inspected.stdout())).toMatchObject({
      status: "awaiting-confirmation",
      target: { id: assetId },
      files: [{ relativePath: "appendix.txt" }],
    });
    const confirmed = runtime(
      [
        "material-association-confirm",
        preparedResult.executionId,
        "--confirmed-by",
        "cli-confirm",
      ],
      { cwd: material, env },
    );
    expect(await runCli(confirmed.runtime), confirmed.stderr()).toBe(0);
    expect(JSON.parse(confirmed.stdout())).toMatchObject({
      status: "accepted",
      confirmedBy: "cli-confirm",
      target: { id: assetId },
    });
  });

  it("uses the shared current catalogue query after a successful scan confirms material is gone", async () => {
    const source = await temporaryDirectory(
      "digital-cli-current-catalogue-membership-",
    );
    const data = await disposableProductDataDirectory();
    await writeFile(path.join(source, "local.txt"), "CLI 本地内容");
    await prepareCliProductData(data);
    const product = runProduct(
      { productDataDirectory: data, environment: {} },
      { start: (application) => application.workflow },
    );
    try {
      const rootId = await seedLibraryRoot(
        product.result,
        "CLI 当前目录材料",
        source,
      );
      const initial = await product.result.scanObservedScope({
        registrationId: rootId,
        relativeScope: ".",
        acceptTrusted: false,
      });
      const review = await product.result.prepareLocalContent({
        executionId: initial.execution.id,
        relativePaths: ["local.txt"],
        name: "CLI 本地内容",
        classification: "book",
      });
      await product.result.confirmLocalContent({
        executionId: review.executionId,
      });
      await rm(path.join(source, "local.txt"));
      await product.result.scanObservedScope({
        registrationId: rootId,
        relativeScope: ".",
        acceptTrusted: false,
      });
    } finally {
      await product.close();
    }

    const command = runtime(
      ["catalogue-surface", "--surface", "current-catalogue"],
      {
        cwd: source,
        env: { DIGITAL_PRODUCT_DATA: data },
      },
    );
    await expect(runCli(command.runtime), command.stderr()).resolves.toBe(0);
    expect(JSON.parse(command.stdout())).toMatchObject({ items: [] });
  });

  it("keeps a directory package current from the directory itself until a completed scan confirms it is gone", async () => {
    const media = await temporaryDirectory("digital-cli-directory-package-");
    const data = await disposableProductDataDirectory();
    const packageDirectory = path.join(media, "film");
    await mkdir(path.join(packageDirectory, "BDMV", "PLAYLIST"), {
      recursive: true,
    });
    await mkdir(path.join(packageDirectory, "BDMV", "STREAM"), {
      recursive: true,
    });
    await writeFile(path.join(packageDirectory, "BDMV", "index.bdmv"), "index");
    await writeFile(
      path.join(packageDirectory, "BDMV", "MovieObject.bdmv"),
      "movie-object",
    );
    await writeFile(
      path.join(packageDirectory, "BDMV", "STREAM", "00000.m2ts"),
      "stream",
    );
    // 观察根必须继续可读：删除整个根会被当作位置不可访问，而不是材料消失。
    await writeFile(path.join(media, "note.txt"), "同级材料");
    await prepareCliProductData(data);
    const env = { DIGITAL_PRODUCT_DATA: data };
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            docs: [
              {
                pnx: {
                  display: { title: ["CLI 目录影片"] },
                  addata: { isbn: ["9789864738281"] },
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    const rootId = await registerRoot({ source: media, cwd: media, env });
    const scrape = runtime(
      [
        "scrape-source",
        rootId,
        "nbinet",
        JSON.stringify({ isbn: "9789864738281" }),
        "--scope",
        "film",
        "--json",
      ],
      { cwd: media, env },
    );
    expect(await runCli(scrape.runtime), scrape.stderr()).toBe(0);
    expect(
      (JSON.parse(scrape.stdout()) as { execution: { outcome: string } })
        .execution.outcome,
    ).toBe("accepted");
    const admitted = await currentCatalogueIds(media, env);
    expect(admitted).toHaveLength(1);
    const assetId = admitted[0]!;

    const database = new DatabaseSync(path.join(data, "catalogue.sqlite"), {
      readOnly: true,
    });
    try {
      // 目录材料由目录本身支持，而不是伪造一条文件观察。
      expect(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM current_file_observations")
            .get() as { readonly count: number }
        ).count,
      ).toBe(0);
    } finally {
      database.close();
    }

    await rm(path.join(packageDirectory, "BDMV", "STREAM", "00000.m2ts"));
    await rm(path.join(packageDirectory, "BDMV", "index.bdmv"));
    await rm(path.join(packageDirectory, "BDMV", "MovieObject.bdmv"));
    await expect(scanRoot(media, env, rootId)).resolves.toMatchObject({
      execution: { status: "completed" },
    });
    await expect(currentCatalogueIds(media, env)).resolves.toEqual([assetId]);

    await rm(packageDirectory, { recursive: true, force: true });
    await expect(scanRoot(media, env, rootId)).resolves.toMatchObject({
      execution: { status: "completed" },
    });
    await expect(currentCatalogueIds(media, env)).resolves.toEqual([]);
    // 重复扫描保持退出结果稳定。
    await expect(scanRoot(media, env, rootId)).resolves.toMatchObject({
      execution: { status: "completed" },
    });
    await expect(currentCatalogueIds(media, env)).resolves.toEqual([]);

    const history = new DatabaseSync(path.join(data, "catalogue.sqlite"), {
      readOnly: true,
    });
    try {
      // 退出当前查询不删除历史身份。
      expect(
        history
          .prepare("SELECT id FROM entities WHERE id = ?")
          .get(assetId) as { readonly id: string },
      ).toMatchObject({ id: assetId });
    } finally {
      history.close();
    }
    const historyPage = runtime(
      ["catalogue-surface", "--surface", "workflow-history"],
      { cwd: media, env },
    );
    await expect(
      runCli(historyPage.runtime),
      historyPage.stderr(),
    ).resolves.toBe(0);
    expect(
      (JSON.parse(historyPage.stdout()) as { items: readonly unknown[] }).items
        .length,
    ).toBeGreaterThan(0);
  });

  it("主封面不提供当前成员资格，但另一个仍存在的交付材料提供", async () => {
    const fixture = await temporaryDirectory("digital-cli-mixed-material-");
    const source = path.join(fixture, "RJ01668691");
    const data = await disposableProductDataDirectory();
    await mkdir(path.join(source, "台本"), { recursive: true });
    await writeFile(path.join(source, "track.wav"), new Uint8Array(44));
    await writeFile(path.join(source, "台本", "script.pdf"), syntheticPdf());
    await prepareCliProductData(data);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const address =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (address.includes("/product/info/ajax")) {
        return new Response(
          JSON.stringify({
            RJ01668691: {
              site_id: "maniax",
              work_name: "带台本的音声作品",
              regist_date: "2026-07-17",
              work_image: "//img.dlsite.jp/official.jpg",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (address === "https://img.dlsite.jp/official.jpg") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    const env = { DIGITAL_PRODUCT_DATA: data };
    const rootId = await registerRoot({ source, cwd: source, env });
    const admitted = runtime(
      [
        "scan",
        rootId,
        "--require-artifact-role",
        "asset.primary-cover",
        "--json",
      ],
      { cwd: source, env },
    );
    expect(await runCli(admitted.runtime), admitted.stderr()).toBe(0);
    const ids = await currentCatalogueIds(source, env);
    expect(ids).toHaveLength(1);
    const assetId = ids[0]!;

    // 限定范围的完整扫描不能撤销范围外材料的支持。
    await rm(path.join(source, "台本", "script.pdf"));
    await expect(scanRoot(source, env, rootId, "台本")).resolves.toMatchObject({
      execution: { status: "completed" },
    });
    await expect(currentCatalogueIds(source, env)).resolves.toEqual([assetId]);

    // 全部交付材料消失后，托管主封面不提供普通当前集合的成员资格。
    await rm(path.join(source, "track.wav"));
    await expect(scanRoot(source, env, rootId)).resolves.toMatchObject({
      execution: { status: "completed" },
    });
    await expect(currentCatalogueIds(source, env)).resolves.toEqual([]);

    const history = new DatabaseSync(path.join(data, "catalogue.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        history
          .prepare(
            `SELECT COUNT(*) AS count FROM artifact_associations
             WHERE subject_id = ? AND role = 'asset.primary-cover'`,
          )
          .get(assetId),
      ).toEqual({ count: 1 });
    } finally {
      history.close();
    }
    const historyPage = runtime(
      ["catalogue-surface", "--surface", "workflow-history"],
      { cwd: source, env },
    );
    await expect(
      runCli(historyPage.runtime),
      historyPage.stderr(),
    ).resolves.toBe(0);
    expect(
      (JSON.parse(historyPage.stdout()) as { items: readonly unknown[] }).items
        .length,
    ).toBeGreaterThan(0);
  }, 60_000);
});

async function currentCatalogueIds(
  cwd: string,
  env: Record<string, string>,
): Promise<readonly string[]> {
  const command = runtime(
    ["catalogue-surface", "--surface", "current-catalogue"],
    {
      cwd,
      env,
    },
  );
  const exit = await runCli(command.runtime);
  expect(exit, `${command.stderr()}\n${command.stdout()}`).toBe(0);
  const page = JSON.parse(command.stdout()) as {
    readonly items: readonly { readonly id: string }[];
  };
  return page.items.map((item) => item.id);
}

// ADR 0086 的显式检查入口：原始观察部件只在这里公开，普通消费投影不另开旁路。
async function inspectedArtifactAssociations(
  executionId: string,
  cwd: string,
  env: Record<string, string>,
): Promise<
  readonly {
    readonly role: string;
    readonly observedArtifactPart?: {
      readonly revisionId: string;
      readonly locator: string;
    };
  }[]
> {
  const command = runtime(["inspect", executionId, "--json"], { cwd, env });
  const exit = await runCli(command.runtime);
  expect(exit, `${command.stderr()}\n${command.stdout()}`).toBe(0);
  type Accepted = {
    entity: { id: string };
    artifactAssociations: {
      role: string;
      observedArtifactPart?: { revisionId: string; locator: string };
    }[];
  };
  const inspected = JSON.parse(command.stdout()) as {
    accepted?: Accepted;
    itemResults?: { key: string; accepted?: Accepted }[];
  };
  return inspected.itemResults === undefined
    ? (inspected.accepted?.artifactAssociations ?? [])
    : inspected.itemResults.flatMap(
        (item) => item.accepted?.artifactAssociations ?? [],
      );
}

async function scanRoot(
  cwd: string,
  env: Record<string, string>,
  rootId: string,
  scope?: string,
) {
  const command = runtime(
    [
      "scan",
      rootId,
      ...(scope === undefined ? [] : ["--scope", scope]),
      "--json",
    ],
    { cwd, env },
  );
  await expect(runCli(command.runtime), command.stderr()).resolves.toBe(0);
  return JSON.parse(command.stdout()) as {
    readonly execution: { readonly status: string; readonly outcome: string };
  };
}

function syntheticPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>",
  ];
  let source = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}
