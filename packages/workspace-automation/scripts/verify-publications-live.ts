import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectEnvironment,
  startEnvironment,
  stopEnvironment,
  type StartOperationResult,
} from "@digital/environment";
import {
  PublicApiClientError,
  type AssetEvidenceItem,
  type PublicApiClient,
  type PublicAssetLibrary,
  type PublicCurrentAsset,
  type PublicExecutionInspection,
  type SourceAssociationDecisionInspection,
} from "@digital/public-api";

import {
  createCorpusClient,
  listAllAssetLibraries,
  listAllAssets,
  waitForAssetLibraryScan,
  waitForProductReady,
  waitForPublicExecution,
} from "./corpus-verification.ts";
import { requireInput } from "./inputs.ts";
import { digestDirectory } from "./material-digest.ts";

type OfficialMetadata = {
  readonly property: string;
  readonly value: string;
};

type OfficialOracle = {
  readonly isbn: string;
  readonly requestAddress: string;
  readonly sourceAddress: string;
  readonly metadata: readonly OfficialMetadata[];
};

type FormatFactOracle = {
  readonly property: string;
  readonly value: string;
  readonly locator: string;
};

type CoverOracle = {
  readonly locator: string;
  readonly mediaType: string;
};

type EpubPublicationOracle = {
  readonly logicalRoot: string;
  readonly revision: {
    readonly digest: string;
    readonly mediaType: string;
    readonly byteLength: number;
  };
  readonly formatFacts: readonly FormatFactOracle[];
  readonly cover: CoverOracle;
  readonly official?: OfficialOracle;
};

type PdfPublicationOracle = {
  readonly logicalRoot: string;
  readonly relativePath: string;
  readonly revision: {
    readonly digest: string;
    readonly mediaType: "application/pdf";
    readonly byteLength: number;
  };
  readonly pageCount: number;
  readonly documentAuthor: string;
  readonly cover: {
    readonly locator: "pdf:page[1]";
    readonly mediaType: "image/png";
  };
};

type PublicationsOracle = {
  readonly reviews: {
    readonly epub: { readonly status: string; readonly reviewedAt: string };
    readonly pdf: { readonly status: string; readonly reviewedAt: string };
  };
  readonly dedicatedIntegrationOwnershipGroups: readonly {
    readonly ownerTicket: string;
    readonly journey: string;
    readonly status: string;
    readonly roots: readonly {
      readonly logicalRoot: string;
    }[];
  }[];
  readonly epubPublications: readonly EpubPublicationOracle[];
  readonly pdfPublications: readonly PdfPublicationOracle[];
};

type MaterialRoot = {
  readonly logicalRoot: string;
  readonly realPath: string;
};

type SourceRecordEvidence = Extract<
  AssetEvidenceItem,
  { kind: "source-record" }
>;
type InterpretedFactEvidence = Extract<
  AssetEvidenceItem,
  { kind: "interpreted-fact" }
>;
type FormatResultEvidence = Extract<
  AssetEvidenceItem,
  { kind: "format-result" }
>;

type CanonicalOfficialProjection = {
  readonly isbn: string;
  readonly sourceAddress: string;
  readonly metadata: readonly OfficialMetadata[];
  readonly digest: string;
};

type SafeFailure = {
  readonly name: string;
  readonly message: string;
  readonly kind?: string;
  readonly status?: number;
};

export type PublicationsLiveInput = {
  readonly workspacePath: string;
  readonly environment: string;
  readonly evidencePath: string;
  readonly materialRoot: string;
  readonly signal?: AbortSignal;
};

export type PublicationsLiveResult = {
  readonly outcome: "passed" | "condition-missing" | "failed" | "cancelled";
  readonly evidencePath?: string;
  readonly conditionMissing?: readonly string[];
  readonly failure?: SafeFailure;
  readonly cleanupErrors?: readonly {
    readonly phase: string;
    readonly failure: SafeFailure;
  }[];
};

class ConditionMissingError extends Error {
  readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super(items.join("；"));
    this.name = "ConditionMissingError";
    this.items = items;
  }
}

const epubOwnerTicket =
  "v1-live-acceptance/issues/03-epub-publication-live-gate.md";
const pdfOwnerTicket = "v1-live-acceptance/issues/04-pdf-series-live-gate.md";
const approvedEpubOracleSliceDigest =
  "4852cefe20b121df4547307a7a28fbc49d3bb8fd95ae860e9e7a611a01ce179e";
const approvedPdfOracleSliceDigest =
  "deced47cbd155603a5917e3404122c21e6f1038680128942f52c66e335ffce95";
const libraryName = "出版物真实来源验收";
const actor = "publication-live-gate";
const workflowTimeoutMs = 10 * 60_000;
const maximumOfficialResponseBytes = 2 * 1024 * 1024;
const pdfSourceInputs = [
  {
    relativePath:
      "01. /终将成为你 佐伯沙弥香的追忆/终将成为你 佐伯沙弥香的追忆 - 入间人间 (2020).pdf",
    isbn: "9789577435064",
    sourceIdentity: "taiwan-kadokawa",
    productAddress: "https://www.kadokawa.com.tw/products/9789577435064",
    expectedTitle: "終將成為妳 關於佐伯沙彌香 (1)",
    expectedCoverage: ["taiwan-kadokawa.product-page"],
  },
  {
    relativePath:
      "02. /终将成为你 佐伯沙弥香的追忆2/终将成为你 佐伯沙弥香的追忆2 - 入间人间 (2020).pdf",
    isbn: "9789577439680",
    sourceIdentity: "taiwan-kadokawa",
    productAddress: "https://www.kadokawa.com.tw/products/9789577439680",
    expectedTitle: "終將成為妳 關於佐伯沙彌香 (2)",
    expectedCoverage: ["taiwan-kadokawa.product-page"],
  },
  {
    relativePath:
      "03. /终将成为你 佐伯沙弥香的追忆3/终将成为你 佐伯沙弥香的追忆3 - 入间人间 (2020).pdf",
    isbn: "9784049131291",
    sourceIdentity: "kadokawa-jp",
    productAddress: "https://www.kadokawa.co.jp/product/321912000002/",
    expectedTitle: "やがて君になる　佐伯沙弥香について(3)",
    expectedCoverage: ["kadokawa-jp.search", "kadokawa-jp.detail"],
  },
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeMessage(rawMessage: string): string {
  return rawMessage
    .replace(
      /(authorization|cookie|token|secret|code)=([^&\s]+)/giu,
      "$1=[已省略]",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [已省略]");
}

function safeFailure(error: unknown): SafeFailure {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PublicApiClientError)
    return {
      name,
      message: safeMessage(message),
      kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  return { name, message: safeMessage(message) };
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function resolveEvidencePath(workspacePath: string, argument: string): string {
  if (argument.trim().length === 0 || path.isAbsolute(argument))
    throw new ConditionMissingError(["证据文件必须使用工作区内的相对路径"]);
  const resolved = path.resolve(workspacePath, argument);
  if (!isWithin(workspacePath, resolved))
    throw new ConditionMissingError(["证据文件必须位于工作区内"]);
  return resolved;
}

async function assertEvidenceDestination(
  workspacePath: string,
  evidencePath: string,
  roots: readonly MaterialRoot[],
): Promise<void> {
  for (const root of roots)
    if (isWithin(root.realPath, evidencePath))
      throw new ConditionMissingError(["证据文件不能写入素材根目录"]);
  let parent = path.dirname(evidencePath);
  while (true) {
    try {
      const canonical = await realpath(parent);
      if (!isWithin(workspacePath, canonical))
        throw new ConditionMissingError(["证据目录不能越出工作区"]);
      break;
    } catch (error) {
      if (error instanceof ConditionMissingError) throw error;
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      const previous = parent;
      parent = path.dirname(parent);
      if (parent === previous)
        throw new ConditionMissingError(["证据目录无法定位"]);
    }
  }
  await mkdir(path.dirname(evidencePath), { recursive: true });
  const canonicalParent = await realpath(path.dirname(evidencePath));
  if (!isWithin(workspacePath, canonicalParent))
    throw new ConditionMissingError(["证据目录不能越出工作区"]);
  try {
    if ((await lstat(evidencePath)).isSymbolicLink())
      throw new ConditionMissingError(["证据文件不能是符号链接"]);
  } catch (error) {
    if (error instanceof ConditionMissingError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}

function epubOracleSlice(rawOracle: unknown): unknown {
  const oracle = record(rawOracle);
  const reviews = record(oracle?.reviews);
  const groups = Array.isArray(oracle?.dedicatedIntegrationOwnershipGroups)
    ? oracle.dedicatedIntegrationOwnershipGroups
    : [];
  return {
    reviews: { epub: reviews?.epub },
    dedicatedIntegrationOwnershipGroups: groups.filter(
      (group) => record(group)?.ownerTicket === epubOwnerTicket,
    ),
    epubPublications: oracle?.epubPublications,
  };
}

function pdfOracleSlice(rawOracle: unknown): unknown {
  const oracle = record(rawOracle);
  const reviews = record(oracle?.reviews);
  const groups = Array.isArray(oracle?.dedicatedIntegrationOwnershipGroups)
    ? oracle.dedicatedIntegrationOwnershipGroups
    : [];
  return {
    reviews: { pdf: reviews?.pdf },
    dedicatedIntegrationOwnershipGroups: groups.filter(
      (group) => record(group)?.ownerTicket === pdfOwnerTicket,
    ),
    pdfPublications: oracle?.pdfPublications,
  };
}

function assertApprovedOracle(rawOracle: unknown): PublicationsOracle {
  const epubDigest = createHash("sha256")
    .update(JSON.stringify(epubOracleSlice(rawOracle)))
    .digest("hex");
  const pdfDigest = createHash("sha256")
    .update(JSON.stringify(pdfOracleSlice(rawOracle)))
    .digest("hex");
  assert.equal(epubDigest, approvedEpubOracleSliceDigest);
  assert.equal(pdfDigest, approvedPdfOracleSliceDigest);
  return rawOracle as PublicationsOracle;
}

async function loadOracle(): Promise<PublicationsOracle> {
  let oraclePath: string;
  try {
    oraclePath = fileURLToPath(
      import.meta.resolve("@digital/preview-corpus/live/reviewed-oracle.json"),
    );
  } catch {
    throw new ConditionMissingError(["公开的出版物复核预期不可用"]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(oraclePath, "utf8")) as unknown;
  } catch {
    throw new ConditionMissingError(["公开的出版物复核预期不可读取"]);
  }
  const oracle = assertApprovedOracle(raw);
  assert.equal(oracle.reviews.epub.status, "reviewed-current-official-source");
  assert.equal(oracle.reviews.epub.reviewedAt, "2026-08-30");
  assert.equal(oracle.reviews.pdf.status, "reviewed-local-format");
  assert.equal(oracle.reviews.pdf.reviewedAt, "2026-08-31");
  assert.equal(oracle.epubPublications.length, 6);
  assert.equal(oracle.pdfPublications.length, 3);
  assert.equal(
    oracle.epubPublications.filter(
      (publication) => publication.official !== undefined,
    ).length,
    2,
  );
  const epubOwner = oracle.dedicatedIntegrationOwnershipGroups.filter(
    ({ ownerTicket }) => ownerTicket === epubOwnerTicket,
  );
  const pdfOwner = oracle.dedicatedIntegrationOwnershipGroups.filter(
    ({ ownerTicket }) => ownerTicket === pdfOwnerTicket,
  );
  assert.equal(epubOwner.length, 1);
  assert.equal(epubOwner[0]!.journey, "epub-publication-live");
  assert.equal(epubOwner[0]!.status, "implemented");
  assert.equal(pdfOwner.length, 1);
  assert.equal(pdfOwner[0]!.journey, "pdf-publication-live");
  assert.equal(pdfOwner[0]!.status, "implemented");
  return oracle;
}

async function resolveRoots(
  materialRoot: string,
  oracle: PublicationsOracle,
): Promise<MaterialRoot[]> {
  if (!path.isAbsolute(materialRoot))
    throw new ConditionMissingError(["完整资料根必须是绝对路径"]);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(materialRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error();
  } catch {
    throw new ConditionMissingError(["完整资料根必须存在且是可读目录"]);
  }
  const logicalRoots = [
    oracle.pdfPublications[0]!.logicalRoot,
    ...oracle.epubPublications.map(({ logicalRoot }) => logicalRoot),
  ];
  assert.equal(new Set(logicalRoots).size, 7);
  const roots: MaterialRoot[] = [];
  const missing: string[] = [];
  for (const logicalRoot of logicalRoots) {
    const segments = logicalRoot.split("/");
    assert.ok(
      segments.every(
        (segment) => segment !== "" && segment !== "." && segment !== "..",
      ),
      `复核逻辑根不安全：${logicalRoot}`,
    );
    const directory = path.join(canonicalRoot, ...segments);
    try {
      const resolved = await realpath(directory);
      if (!(await stat(resolved)).isDirectory()) {
        missing.push(logicalRoot);
        continue;
      }
      if (!isWithin(canonicalRoot, resolved))
        throw new Error(`复核素材根越出完整资料根：${logicalRoot}`);
      roots.push({ logicalRoot, realPath: resolved });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        missing.push(logicalRoot);
        continue;
      }
      throw error;
    }
  }
  if (missing.length > 0)
    throw new ConditionMissingError([
      `完整资料根缺少复核出版物目录：${missing.join("、")}`,
    ]);
  for (let left = 0; left < roots.length; left++)
    for (let right = left + 1; right < roots.length; right++)
      assert.ok(
        !isWithin(roots[left]!.realPath, roots[right]!.realPath) &&
          !isWithin(roots[right]!.realPath, roots[left]!.realPath),
        "出版物素材根不能重叠",
      );
  return roots;
}

function validIsbn13(value: string): boolean {
  if (!/^(?:97[89])\d{10}$/u.test(value)) return false;
  const sum = Array.from(value)
    .slice(0, 12)
    .reduce(
      (total, digit, index) =>
        total + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    );
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

function strictIsbn13(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match =
    /^(?:ISBN(?:-13)?(?:\s*:\s*|\s+))?(97[89](?:[ -]?\d){10})$/iu.exec(value);
  const normalized = match?.[1]?.replaceAll(/[ -]/gu, "");
  return normalized !== undefined && validIsbn13(normalized)
    ? normalized
    : undefined;
}

function strings(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) =>
    typeof item === "string" && item.trim().length > 0 ? [item.trim()] : [],
  );
}

function comparableMetadata(item: OfficialMetadata): string {
  return `${item.property}\u0000${item.value}`;
}

function canonicalNbinetRequest(isbn: string): string {
  const query = new URLSearchParams({
    inst: "886NCL_NBINET",
    vid: "886NCL_NBINET:NBINET",
    lang: "zh-tw",
    q: `isbn,exact,${isbn}`,
    scope: "MyInstitution",
    tab: "NBINET",
    skipDelivery: "Y",
  });
  return `https://nbinet.primo.exlibrisgroup.com/primaws/rest/pub/pnxs?${query}`;
}

function canonicalNbinetSourceAddress(isbn: string): string {
  const query = new URLSearchParams({
    inst: "886NCL_NBINET",
    vid: "886NCL_NBINET:NBINET",
    lang: "zh-tw",
    q: `isbn,exact,${isbn}`,
    scope: "MyInstitution",
    tab: "NBINET",
    skipDelivery: "Y",
  });
  return `https://nbinet.primo.exlibrisgroup.com/discovery/search?${query}`;
}

function canonicalOfficialResponse(
  bytes: Uint8Array,
  isbn: string,
  sourceAddress: string,
): CanonicalOfficialProjection {
  assert.ok(
    bytes.byteLength > 0 && bytes.byteLength <= maximumOfficialResponseBytes,
    "NBINet exact response is outside the bounded body size",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("NBINet exact response is not valid JSON");
  }
  const documentsValue = record(parsed)?.docs;
  const documents = Array.isArray(documentsValue) ? documentsValue : [];
  assert.equal(
    documents.length,
    1,
    "NBINet exact response must have one document",
  );
  const pnx = record(record(documents[0])?.pnx);
  const identifiers = record(pnx?.addata)?.isbn;
  assert.equal(
    (Array.isArray(identifiers) ? identifiers : [])
      .map(strictIsbn13)
      .filter((value) => value === isbn).length,
    1,
    "NBINet exact result must contain the strict target ISBN once",
  );
  assert.equal(sourceAddress, canonicalNbinetSourceAddress(isbn));
  const display = record(pnx?.display);
  const metadata = [
    { property: "book.isbn-13", value: isbn },
    ...strings(display?.title).map((value) => ({
      property: "asset.title",
      value,
    })),
    ...strings(display?.creator).map((value) => ({
      property: "book.contributor",
      value,
    })),
    ...strings(display?.publisher).map((value) => ({
      property: "book.publisher",
      value,
    })),
    ...strings(display?.creationdate).map((value) => ({
      property: "book.publication-date",
      value,
    })),
    ...strings(display?.language).map((value) => ({
      property: "asset.declared-language",
      value,
    })),
  ].toSorted((left, right) =>
    comparableMetadata(left).localeCompare(comparableMetadata(right)),
  );
  const canonical = { isbn, sourceAddress, metadata };
  return {
    ...canonical,
    digest: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex"),
  };
}

async function exactOfficialProjection(
  official: OfficialOracle,
  signal: AbortSignal,
): Promise<CanonicalOfficialProjection> {
  assert.equal(official.requestAddress, canonicalNbinetRequest(official.isbn));
  assert.equal(
    official.sourceAddress,
    canonicalNbinetSourceAddress(official.isbn),
  );
  const response = await fetch(official.requestAddress, {
    method: "GET",
    redirect: "error",
    signal,
  });
  assert.equal(
    response.ok,
    true,
    `NBINet request returned HTTP ${String(response.status)}`,
  );
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    assert.equal(
      Number.isSafeInteger(declared) &&
        declared > 0 &&
        declared <= maximumOfficialResponseBytes,
      true,
      "NBINet exact response declared an invalid size",
    );
  }
  assert.ok(response.body, "NBINet exact response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumOfficialResponseBytes) {
        await reader.cancel();
        throw new Error("NBINet exact response exceeded the body limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return canonicalOfficialResponse(
    bytes,
    official.isbn,
    official.sourceAddress,
  );
}

async function allEvidence(
  client: PublicApiClient,
  assetId: string,
  kind: "source-records" | "interpreted-facts" | "format-results",
): Promise<AssetEvidenceItem[]> {
  const items: AssetEvidenceItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAssetEvidence(assetId, {
      kind,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

async function sourceRecordsForAsset(
  client: PublicApiClient,
  assetId: string,
): Promise<SourceRecordEvidence[]> {
  return (await allEvidence(client, assetId, "source-records")).filter(
    (item): item is SourceRecordEvidence => item.kind === "source-record",
  );
}

async function interpretedFactsForAsset(
  client: PublicApiClient,
  assetId: string,
): Promise<InterpretedFactEvidence[]> {
  return (await allEvidence(client, assetId, "interpreted-facts")).filter(
    (item): item is InterpretedFactEvidence => item.kind === "interpreted-fact",
  );
}

async function formatResultsForAsset(
  client: PublicApiClient,
  assetId: string,
): Promise<FormatResultEvidence[]> {
  return (await allEvidence(client, assetId, "format-results")).filter(
    (item): item is FormatResultEvidence => item.kind === "format-result",
  );
}

async function readSourceRecordText(
  client: PublicApiClient,
  assetId: string,
  recordId: string,
  signal: AbortSignal,
): Promise<{ readonly content: string; readonly digest: string }> {
  let offset = 0;
  let content = "";
  let digest = "";
  let complete = false;
  while (!complete) {
    signal.throwIfAborted();
    const chunk = await client.readAssetSourceRecord(assetId, recordId, {
      offset,
      limit: 4096,
    });
    assert.equal(chunk.assetId, assetId);
    assert.equal(chunk.record.id, recordId);
    assert.equal(chunk.record.sourceIdentity, "nbinet");
    if (digest.length === 0) digest = chunk.record.digest;
    else assert.equal(chunk.record.digest, digest);
    assert.equal(chunk.offset, offset);
    assert.ok(chunk.nextOffset > offset || chunk.complete);
    content += chunk.content;
    offset = chunk.nextOffset;
    complete = chunk.complete;
  }
  assert.match(digest, /^[0-9a-f]{64}$/u);
  return { content, digest };
}

async function waitForSourceDecision(
  client: PublicApiClient,
  executionId: string,
  signal: AbortSignal,
): Promise<SourceAssociationDecisionInspection> {
  const deadline = Date.now() + workflowTimeoutMs;
  let inspection = await client.inspectSourceAssociationDecision(executionId);
  while (inspection.status === "running" && Date.now() < deadline) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
    inspection = await client.inspectSourceAssociationDecision(executionId);
  }
  assert.equal(inspection.status, "completed", "来源关联决定未完成");
  return inspection;
}

async function listLibraries(client: PublicApiClient) {
  return await listAllAssetLibraries(client);
}

async function findOrCreateLibrary(input: {
  readonly client: PublicApiClient;
  readonly roots: readonly MaterialRoot[];
}): Promise<{
  readonly library: PublicAssetLibrary;
  readonly created: boolean;
}> {
  const expectedRoots = input.roots.map(({ realPath }) => realPath).toSorted();
  const profiles = ["books"];
  const sources = ["kadokawa-jp", "nbinet", "taiwan-kadokawa"];
  const existing = await listLibraries(input.client);
  const sameName = existing.find(
    ({ displayName }) => displayName === libraryName,
  );
  if (sameName !== undefined) {
    const actualRoots = sameName.directories
      .filter(({ status }) => status === "active")
      .map(({ path: directoryPath }) => path.resolve(directoryPath))
      .toSorted();
    if (
      JSON.stringify(actualRoots) !== JSON.stringify(expectedRoots) ||
      JSON.stringify(sameName.recognitionProfileIds.toSorted()) !==
        JSON.stringify(profiles) ||
      JSON.stringify(sameName.sourceIdentities.toSorted()) !==
        JSON.stringify(sources)
    )
      throw new ConditionMissingError([
        "同名资产库配置不属于出版物实况验收；不会改写既有配置",
      ]);
    return { library: sameName, created: false };
  }
  for (const library of existing)
    for (const directory of library.directories) {
      if (directory.status !== "active") continue;
      let registeredPath: string;
      try {
        registeredPath = await realpath(directory.path);
      } catch {
        registeredPath = path.resolve(directory.path);
      }
      if (
        input.roots.some(
          ({ realPath: root }) =>
            isWithin(registeredPath, root) || isWithin(root, registeredPath),
        )
      )
        throw new ConditionMissingError([
          `出版物素材已登记在其他资产库「${library.displayName}」中；不会替换既有配置`,
        ]);
    }
  const options = await input.client.listAssetLibraryOptions();
  assert.ok(options.recognitionProfiles.some(({ id }) => id === "books"));
  for (const source of sources)
    assert.ok(options.sources.some(({ id }) => id === source));
  const library = await input.client.saveAssetLibrary({
    displayName: libraryName,
    directories: input.roots.map(({ realPath }) => realPath),
    recognitionProfileIds: profiles,
    sourceIdentities: sources,
  });
  assert.deepEqual(library.recognitionProfileIds.toSorted(), profiles);
  assert.deepEqual(library.sourceIdentities.toSorted(), sources);
  return { library, created: true };
}

function fileForRelativePath(
  files: readonly {
    readonly relativePath: string;
    readonly assetIds: readonly string[];
    readonly problem?: string | undefined;
  }[],
  relativePath: string,
): string {
  const matches = files.filter(
    ({ relativePath: candidate }) => candidate === relativePath,
  );
  assert.equal(matches.length, 1, `登记目录中没有唯一文件：${relativePath}`);
  assert.equal(
    matches[0]!.problem,
    undefined,
    `扫描文件未处理：${relativePath}`,
  );
  assert.equal(
    matches[0]!.assetIds.length,
    1,
    `文件没有唯一资产：${relativePath}`,
  );
  return matches[0]!.assetIds[0]!;
}

async function assetById(
  client: PublicApiClient,
  libraryId: string,
  assetId: string,
): Promise<PublicCurrentAsset> {
  const assets = await listAllAssets(client, libraryId);
  const matches = assets.filter(({ id }) => id === assetId);
  assert.equal(matches.length, 1, `公共资产列表没有唯一资产 ${assetId}`);
  return matches[0]!;
}

function sortedFactKeys(
  facts: readonly {
    readonly property: string;
    readonly value: string;
    readonly locator?: string;
  }[],
): string[] {
  return facts
    .map(
      ({ property, value, locator }) =>
        `${property}\u0000${value}\u0000${locator ?? ""}`,
    )
    .toSorted();
}

function assertLocalFacts(
  facts: readonly InterpretedFactEvidence[],
  expected: readonly FormatFactOracle[],
  label: string,
): void {
  const local = facts.filter(
    ({ sourceRecordIds }) => sourceRecordIds.length === 0,
  );
  assert.deepEqual(
    sortedFactKeys(
      local.map(({ property, value, observedArtifactPart }) => ({
        property,
        value,
        ...(observedArtifactPart === undefined
          ? {}
          : { locator: observedArtifactPart.locator }),
      })),
    ),
    sortedFactKeys(expected),
    `${label} 本地格式事实必须完整且精确绑定修订版`,
  );
}

function parentPartForFact(
  facts: readonly InterpretedFactEvidence[],
  expected: {
    readonly property: string;
    readonly value: string;
    readonly locator: string;
  },
): { readonly artifactId: string; readonly revisionId: string } {
  const matches = facts.filter(
    (fact) =>
      fact.property === expected.property &&
      fact.value === expected.value &&
      fact.sourceRecordIds.length === 0 &&
      fact.observedArtifactPart?.locator === expected.locator,
  );
  assert.equal(matches.length, 1, `缺少精确本地事实 ${expected.property}`);
  assert.ok(matches[0]!.observedArtifactPart);
  return {
    artifactId: matches[0]!.observedArtifactPart!.artifactId,
    revisionId: matches[0]!.observedArtifactPart!.revisionId,
  };
}

function currentRoles(asset: PublicCurrentAsset, roleName: string) {
  return asset.descriptions
    .flatMap(({ artifactRoles }) => artifactRoles)
    .filter(({ role }) => role === roleName);
}

async function inspectCoverBytes(input: {
  readonly client: PublicApiClient;
  readonly assetLibraryId: string;
  readonly revisionId: string;
  readonly expectedMediaType: string;
  readonly expectedByteLength: number;
  readonly signal: AbortSignal;
  readonly label: string;
}): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const response = await input.client.readArtifactRevision(input.revisionId, {
    assetLibraryId: input.assetLibraryId,
    signal: input.signal,
  });
  assert.equal(
    response.status,
    200,
    `${input.label} 封面修订版必须可通过公开媒体读取`,
  );
  assert.equal(
    response.headers.get("content-type")?.split(";", 1)[0]?.trim(),
    input.expectedMediaType,
    `${input.label} 封面媒体类型必须与复核预期一致`,
  );
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null)
    assert.equal(Number(declaredLength), input.expectedByteLength);
  assert.ok(response.body, `${input.label} 封面修订版没有响应正文`);
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let byteLength = 0;
  try {
    while (true) {
      input.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      assert.ok(
        byteLength <= 16 * 1024 * 1024,
        `${input.label} 封面超出大小上限`,
      );
      digest.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  assert.equal(byteLength, input.expectedByteLength);
  assert.ok(byteLength > 0);
  return { byteLength, sha256: digest.digest("hex") };
}

async function assertCoverBinding(input: {
  readonly client: PublicApiClient;
  readonly assetLibraryId: string;
  readonly asset: PublicCurrentAsset;
  readonly parent: { readonly artifactId: string; readonly revisionId: string };
  readonly cover: CoverOracle;
  readonly label: string;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  const roles = currentRoles(input.asset, "asset.primary-cover");
  assert.equal(roles.length, 1, `${input.label} 必须有唯一当前主封面`);
  const role = roles[0]!;
  assert.notEqual(
    role.artifactId,
    input.parent.artifactId,
    `${input.label} 封面产物必须与父容器产物区分`,
  );
  const parts = role.observedArtifactParts ?? [];
  assert.ok(parts.length > 0, `${input.label} 当前主封面必须公开材料依据`);
  assert.equal(
    new Set(parts.map(({ associationId }) => associationId)).size,
    parts.length,
    `${input.label} 封面材料依据不能重复关联`,
  );
  for (const part of parts)
    assert.ok(
      role.associationIds.includes(part.associationId),
      `${input.label} 材料依据必须来自该生效角色的贡献关联`,
    );
  const matching = parts.filter(
    ({ locator }) => locator === input.cover.locator,
  );
  assert.equal(
    matching.length,
    parts.length,
    `${input.label} 缺少精确封面 locator`,
  );
  assert.ok(
    matching.every(
      ({ artifactId, revisionId }) =>
        artifactId === input.parent.artifactId &&
        revisionId === input.parent.revisionId,
    ),
    `${input.label} 封面必须依据本次实测的父容器修订版`,
  );
  const parentLocations = input.asset.locations.filter(
    ({ artifactId, content }) =>
      artifactId === input.parent.artifactId &&
      content.status === "confirmed" &&
      content.target.kind === "artifact-revision" &&
      content.target.artifactId === input.parent.artifactId &&
      content.target.revisionId === input.parent.revisionId,
  );
  assert.equal(
    parentLocations.length,
    1,
    `${input.label} 父容器材料必须精确确认`,
  );
  const roleLocation =
    role.locationId === undefined
      ? undefined
      : input.asset.locations.find(({ id }) => id === role.locationId);
  assert.ok(roleLocation, `${input.label} 当前封面必须有可访问位置`);
  assert.equal(roleLocation.artifactId, role.artifactId);
  assert.equal(roleLocation.content.status, "confirmed");
  if (roleLocation.content.status !== "confirmed")
    throw new Error(`${input.label} 当前主封面位置必须确认到修订版`);
  assert.equal(roleLocation.content.target.kind, "artifact-revision");
  assert.equal(roleLocation.content.target.artifactId, role.artifactId);
  const media = await inspectCoverBytes({
    client: input.client,
    assetLibraryId: input.assetLibraryId,
    revisionId: roleLocation.content.target.revisionId,
    expectedMediaType: input.cover.mediaType,
    expectedByteLength: roleLocation.byteLength ?? 0,
    signal: input.signal,
    label: input.label,
  });
  const projectedParts = parts.map((part) => ({
    associationId: part.associationId,
    artifactId: part.artifactId,
    revisionId: part.revisionId,
    locator: part.locator,
  }));
  return {
    roleArtifactId: role.artifactId,
    associationIds: [...role.associationIds].toSorted(),
    location: {
      kind: roleLocation.kind,
      byteLength: media.byteLength,
      content: roleLocation.content,
      sha256: media.sha256,
    },
    observedArtifactParts: projectedParts.toSorted((left, right) =>
      `${left.locator}:${left.associationId}`.localeCompare(
        `${right.locator}:${right.associationId}`,
      ),
    ),
  };
}

function assertFormatResult(input: {
  readonly results: readonly FormatResultEvidence[];
  readonly revision: {
    readonly digest: string;
    readonly mediaType: string;
    readonly byteLength: number;
  };
  readonly cover: CoverOracle;
  readonly label: string;
}): void {
  const parentResults = input.results.filter(
    ({ detail }) =>
      detail.kind === "result" &&
      detail.digest === input.revision.digest &&
      detail.mediaType === input.revision.mediaType &&
      detail.byteLength === input.revision.byteLength,
  );
  assert.equal(
    parentResults.length,
    1,
    `${input.label} 原始格式摘要与复核值一致`,
  );
  const parts = input.results.filter(
    ({ detail }) =>
      detail.kind === "part" &&
      detail.role === "asset.primary-cover" &&
      detail.locator === input.cover.locator &&
      detail.mediaType === input.cover.mediaType,
  );
  assert.equal(parts.length, 1, `${input.label} 封面格式结果必须精确匹配`);
}

function resolvedMetadata(asset: PublicCurrentAsset, property: string) {
  return asset.descriptions.flatMap(({ metadata }) =>
    metadata
      .filter(
        (item) =>
          item.property === property && item.result.status === "resolved",
      )
      .flatMap((item) =>
        item.result.status === "resolved"
          ? item.result.values.map((value) => ({ property, ...value }))
          : [],
      ),
  );
}

function assertSourceMetadata(input: {
  readonly asset: PublicCurrentAsset;
  readonly facts: readonly InterpretedFactEvidence[];
  readonly sourceIdentity: string;
  readonly sourceRecordId: string;
  readonly expected: readonly OfficialMetadata[];
  readonly label: string;
}): void {
  const sourced = input.facts
    .filter(({ sourceRecordIds }) =>
      sourceRecordIds.includes(input.sourceRecordId),
    )
    .filter(({ sourceIdentity }) => sourceIdentity === input.sourceIdentity)
    .map(({ property, value, sourceRecordIds }) => ({
      property,
      value,
      sourceRecordIds,
    }));
  const expected = input.expected.map(({ property, value }) => ({
    property,
    value,
    sourceRecordIds: [input.sourceRecordId],
  }));
  const comparable = (
    items: readonly {
      readonly property: string;
      readonly value: string;
      readonly sourceRecordIds: readonly string[];
    }[],
  ) => items.map((item) => JSON.stringify(item)).toSorted();
  assert.deepEqual(
    comparable(sourced),
    comparable(expected),
    `${input.label} 来源事实必须与来源记录完整对应`,
  );
  for (const { property, value } of input.expected) {
    const current = resolvedMetadata(input.asset, property).filter(
      (item) =>
        item.value === value && item.sourceIdentity === input.sourceIdentity,
    );
    assert.equal(
      current.length,
      1,
      `${input.label} 当前 ${property} 值应精确来自指定来源`,
    );
    assert.ok(current[0]!.sourceRecordIds.includes(input.sourceRecordId));
  }
}

async function readDirectNbinetRecord(
  asset: PublicCurrentAsset,
  official: OfficialOracle,
  direct: CanonicalOfficialProjection,
  client: PublicApiClient,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const records = await sourceRecordsForAsset(client, asset.id);
  assert.equal(
    records.length,
    1,
    `NBINet ${official.isbn} 必须只有一条当前来源记录`,
  );
  const record = records[0]!;
  assert.equal(record.status, "available");
  assert.equal(record.sourceIdentity, "nbinet");
  assert.equal(record.nativeAddress, official.sourceAddress);
  assert.deepEqual(record.coverage, {
    id: "nbinet.exact-isbn",
    completeness: "complete",
    authority: "official",
  });
  assert.match(record.digest ?? "", /^[0-9a-f]{64}$/u);
  const content = await readSourceRecordText(
    client,
    asset.id,
    record.id,
    signal,
  );
  const retained = canonicalOfficialResponse(
    Buffer.from(content.content, "utf8"),
    official.isbn,
    official.sourceAddress,
  );
  assert.equal(
    retained.digest,
    direct.digest,
    "公开来源记录必须保留正式请求的完整当前投影",
  );
  assert.deepEqual(
    direct.metadata.map(comparableMetadata),
    official.metadata.map(comparableMetadata).toSorted(),
    `NBINet ${official.isbn} 当前官方书目与复核预期不一致`,
  );
  return {
    id: record.id,
    sourceIdentity: record.sourceIdentity,
    nativeAddress: record.nativeAddress,
    coverage: record.coverage,
    digest: record.digest,
    contentSha256: createHash("sha256").update(content.content).digest("hex"),
    canonicalSha256: retained.digest,
  };
}

async function readRootIntake(input: {
  readonly client: PublicApiClient;
  readonly library: PublicAssetLibrary;
  readonly parentExecutionId: string;
  readonly root: MaterialRoot;
}) {
  const matches = input.library.directories.filter(
    ({ path: directoryPath, status }) =>
      status === "active" &&
      path.resolve(directoryPath) === input.root.realPath,
  );
  assert.equal(
    matches.length,
    1,
    `公共资产库未登记唯一素材根：${input.root.logicalRoot}`,
  );
  const intake = await input.client.inspectLocalIntake({
    assetLibraryId: input.library.id,
    directoryId: matches[0]!.id,
    parentExecutionId: input.parentExecutionId,
  });
  assert.equal(intake.assetLibraryId, input.library.id);
  assert.equal(intake.directoryId, matches[0]!.id);
  assert.equal(intake.execution?.status, "completed");
  assert.ok(intake.execution?.id);
  assert.ok(intake.files.every(({ problem }) => problem === undefined));
  return intake;
}

async function ensurePdfAssociation(input: {
  readonly client: PublicApiClient;
  readonly asset: PublicCurrentAsset;
  readonly expected: (typeof pdfSourceInputs)[number];
  readonly signal: AbortSignal;
}): Promise<{
  readonly decisionCreated: boolean;
  readonly historyLength: number;
}> {
  const before = await input.client.inspectSourceAssociationHistory(
    input.asset.id,
  );
  const existing = before.current.filter(
    ({ sourceIdentity, nativeAddress }) =>
      sourceIdentity === input.expected.sourceIdentity &&
      nativeAddress === input.expected.productAddress,
  );
  if (before.current.length > 0) {
    assert.equal(
      existing.length,
      1,
      "PDF 资产已关联其他来源；验收不会替换既有来源",
    );
    return { decisionCreated: false, historyLength: before.historical.length };
  }
  assert.equal(before.historical.length, 0, "PDF 初始来源历史必须为空");
  const started = await input.client.startSourceAssociationDecision({
    intent: "establish",
    assetId: input.asset.id,
    sourceIdentity: input.expected.sourceIdentity,
    sourceInput: { isbn: input.expected.isbn },
    initiatedBy: actor,
  });
  let decision = await waitForSourceDecision(
    input.client,
    started.executionId,
    input.signal,
  );
  const exactCandidates = decision.candidates.filter(
    ({ outcome, sourceIdentity, nativeAddress }) =>
      outcome === "accepted" &&
      sourceIdentity === input.expected.sourceIdentity &&
      nativeAddress === input.expected.productAddress,
  );
  assert.equal(
    exactCandidates.length,
    1,
    `来源候选必须唯一命中 ${input.expected.productAddress}`,
  );
  if (decision.state === "awaiting-selection") {
    assert.ok(decision.availableActions.includes("select"));
    decision = await input.client.selectSourceAssociationCandidate(
      decision.executionId,
      exactCandidates[0]!.reference,
    );
    decision = await waitForSourceDecision(
      input.client,
      decision.executionId,
      input.signal,
    );
  }
  assert.equal(decision.status, "completed");
  assert.equal(decision.state, "awaiting-confirmation");
  assert.ok(decision.preview);
  assert.equal(decision.preview.status, "awaiting-confirmation");
  const preview = await input.client.inspectChangeImpactPreview(
    decision.preview.previewId,
  );
  assert.equal(preview.assetId, input.asset.id);
  assert.equal(preview.status, "awaiting-confirmation");
  assert.deepEqual(preview.current.sourceAssociations, []);
  assert.deepEqual(preview.projected.sourceAssociations, [
    {
      sourceIdentity: input.expected.sourceIdentity,
      nativeAddress: input.expected.productAddress,
    },
  ]);
  const confirmed = await input.client.confirmChangeImpactPreview(
    preview.previewId,
    actor,
  );
  assert.equal(confirmed.status, "applied");
  assert.deepEqual(confirmed.projected.sourceAssociations, [
    {
      sourceIdentity: input.expected.sourceIdentity,
      nativeAddress: input.expected.productAddress,
    },
  ]);
  const after = await input.client.inspectSourceAssociationHistory(
    input.asset.id,
  );
  assert.equal(after.recognitionState, "recognized");
  assert.deepEqual(
    after.current.map(({ sourceIdentity, nativeAddress }) => ({
      sourceIdentity,
      nativeAddress,
    })),
    [
      {
        sourceIdentity: input.expected.sourceIdentity,
        nativeAddress: input.expected.productAddress,
      },
    ],
  );
  assert.deepEqual(after.historical, []);
  return { decisionCreated: true, historyLength: after.historical.length };
}

async function refreshPdf(input: {
  readonly client: PublicApiClient;
  readonly libraryId: string;
  readonly assetId: string;
  readonly expected: (typeof pdfSourceInputs)[number];
  readonly expectedFacts: readonly FormatFactOracle[];
  readonly expectedCover: CoverOracle;
  readonly parent: { readonly artifactId: string; readonly revisionId: string };
  readonly originalLocalProjection: unknown;
  readonly signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  input.signal.throwIfAborted();
  const started = await input.client.startMetadataRefresh({
    subjectId: input.assetId,
  });
  const execution: PublicExecutionInspection = await waitForPublicExecution(
    input.client,
    started.id,
    workflowTimeoutMs,
  );
  assert.equal(execution.kind, "execution");
  if (execution.kind !== "execution")
    throw new Error("PDF 来源刷新必须返回正式执行");
  assert.equal(execution.outcome, "accepted");
  assert.equal(execution.sourceRefreshRuns.length, 1);
  const run = execution.sourceRefreshRuns[0]!;
  assert.equal(run.outcome, "succeeded");
  assert.equal(run.requestedSelection.subjectId, input.assetId);
  assert.equal(
    run.requestedSelection.sourceIdentity,
    input.expected.sourceIdentity,
  );
  assert.equal(
    run.requestedSelection.nativeAddress,
    input.expected.productAddress,
  );
  assert.equal(run.scopes.length, 1);
  const scope = run.scopes[0]!;
  assert.equal(scope.coverage.sourceIdentity, input.expected.sourceIdentity);
  assert.equal(scope.coverage.nativeAddress, input.expected.productAddress);
  assert.equal(
    scope.coverage.coverageId,
    input.expected.sourceIdentity === "kadokawa-jp"
      ? "kadokawa-jp.detail"
      : "taiwan-kadokawa.product-page",
  );
  assert.equal(scope.outcome, "applied");
  assert.ok(scope.candidateSourceRecordId);
  const refreshed = await assetById(
    input.client,
    input.libraryId,
    input.assetId,
  );
  assert.deepEqual(
    refreshed.sourceAssociations.map(({ sourceIdentity, nativeAddress }) => ({
      sourceIdentity,
      nativeAddress,
    })),
    [
      {
        sourceIdentity: input.expected.sourceIdentity,
        nativeAddress: input.expected.productAddress,
      },
    ],
  );
  assert.deepEqual(refreshed.relatedEntities, []);
  assert.deepEqual(refreshed.relationships, []);
  const records = await sourceRecordsForAsset(input.client, input.assetId);
  const freshRecords = records.filter(
    ({ id }) => id === scope.candidateSourceRecordId,
  );
  assert.equal(freshRecords.length, 1);
  assert.equal(freshRecords[0]!.status, "available");
  assert.equal(freshRecords[0]!.sourceIdentity, input.expected.sourceIdentity);
  assert.equal(freshRecords[0]!.nativeAddress, input.expected.productAddress);
  assert.equal(
    freshRecords[0]!.coverage?.id,
    input.expected.sourceIdentity === "kadokawa-jp"
      ? "kadokawa-jp.detail"
      : "taiwan-kadokawa.product-page",
  );
  const facts = await interpretedFactsForAsset(input.client, input.assetId);
  for (const [property, value] of [
    ["book.isbn-13", input.expected.isbn],
    ["asset.title", input.expected.expectedTitle],
  ] as const) {
    const matches = facts.filter(
      (fact) =>
        fact.property === property &&
        fact.value === value &&
        fact.sourceIdentity === input.expected.sourceIdentity &&
        fact.sourceRecordIds.includes(scope.candidateSourceRecordId!),
    );
    assert.equal(matches.length, 1, `PDF ${property} 必须引用本轮来源记录`);
    const current = resolvedMetadata(refreshed, property).filter(
      (item) =>
        item.value === value &&
        item.sourceIdentity === input.expected.sourceIdentity &&
        item.sourceRecordIds.includes(scope.candidateSourceRecordId!),
    );
    assert.equal(
      current.length,
      1,
      `当前 PDF ${property} 必须来自本轮来源记录`,
    );
  }
  const nextLocalProjection = await localProjection({
    client: input.client,
    assetLibraryId: input.libraryId,
    asset: refreshed,
    parent: input.parent,
    expectedFacts: input.expectedFacts,
    cover: input.expectedCover,
    label: input.expected.relativePath,
    signal: input.signal,
  });
  assert.deepEqual(
    nextLocalProjection.cover,
    input.originalLocalProjection,
    "真实来源刷新不得更换或重绑 PDF 本地封面",
  );
  return {
    executionId: execution.id,
    outcome: execution.outcome,
    sourceRefreshRunId: run.id,
    coverageId: scope.coverage.coverageId,
    sourceRecordId: scope.candidateSourceRecordId,
    sourceRecordDigest: freshRecords[0]!.digest,
    localCoverPreserved: true,
  };
}

async function localProjection(input: {
  readonly client: PublicApiClient;
  readonly assetLibraryId: string;
  readonly asset: PublicCurrentAsset;
  readonly parent: { readonly artifactId: string; readonly revisionId: string };
  readonly expectedFacts: readonly FormatFactOracle[];
  readonly cover: CoverOracle;
  readonly label: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly facts: unknown;
  readonly cover: unknown;
  readonly relationships: unknown;
}> {
  const facts = await interpretedFactsForAsset(input.client, input.asset.id);
  const localFacts = facts.filter(
    ({ sourceRecordIds }) => sourceRecordIds.length === 0,
  );
  assertLocalFacts(localFacts, input.expectedFacts, input.label);
  const cover = await assertCoverBinding({
    client: input.client,
    assetLibraryId: input.assetLibraryId,
    asset: input.asset,
    parent: input.parent,
    cover: input.cover,
    label: input.label,
    signal: input.signal,
  });
  return {
    facts: localFacts
      .map(({ property, value, observedArtifactPart }) => ({
        property,
        value,
        observedArtifactPart,
      }))
      .toSorted((left, right) =>
        `${left.property}:${left.value}:${left.observedArtifactPart?.locator ?? ""}`.localeCompare(
          `${right.property}:${right.value}:${right.observedArtifactPart?.locator ?? ""}`,
        ),
      ),
    cover,
    relationships: {
      relatedEntities: input.asset.relatedEntities,
      relationships: input.asset.relationships,
    },
  };
}

function publicationFacts(
  publication: PdfPublicationOracle,
): readonly FormatFactOracle[] {
  return [
    {
      property: "pdf.page-count",
      value: String(publication.pageCount),
      locator: "pdf:catalog/pages",
    },
    {
      property: "pdf.document-author",
      value: publication.documentAuthor,
      locator: "pdf:info/Author",
    },
  ];
}

function currentRoleAddress(
  asset: PublicCurrentAsset,
  roleName: string,
): string | undefined {
  return currentRoles(asset, roleName)[0]?.address;
}

async function inspectPdf(input: {
  readonly client: PublicApiClient;
  readonly libraryId: string;
  readonly publication: PdfPublicationOracle;
  readonly expected: (typeof pdfSourceInputs)[number];
  readonly assetId: string;
  readonly signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const asset = await assetById(input.client, input.libraryId, input.assetId);
  assert.equal(asset.id, input.assetId);
  assert.deepEqual(asset.sourceAssociations, []);
  assert.equal(asset.recognitionSourceAssociation, undefined);
  const history = await input.client.inspectSourceAssociationHistory(asset.id);
  assert.equal(history.recognitionState, "unresolved");
  assert.deepEqual(history.current, []);
  assert.deepEqual(await sourceRecordsForAsset(input.client, asset.id), []);
  const facts = await interpretedFactsForAsset(input.client, asset.id);
  const expectedFacts = publicationFacts(input.publication);
  assertLocalFacts(facts, expectedFacts, input.publication.relativePath);
  assert.equal(
    resolvedMetadata(asset, "asset.title").length,
    0,
    "PDF 文件名不能制造作品标题",
  );
  assert.equal(
    resolvedMetadata(asset, "book.contributor").length,
    0,
    "PDF 文件名不能制造作者事实",
  );
  const localFact = parentPartForFact(facts, expectedFacts[0]!);
  const formatResults = await formatResultsForAsset(input.client, asset.id);
  assertFormatResult({
    results: formatResults,
    revision: input.publication.revision,
    cover: input.publication.cover,
    label: input.publication.relativePath,
  });
  const projection = await localProjection({
    client: input.client,
    assetLibraryId: input.libraryId,
    asset,
    parent: localFact,
    expectedFacts,
    cover: input.publication.cover,
    label: input.publication.relativePath,
    signal: input.signal,
  });
  assert.deepEqual(asset.relatedEntities, []);
  assert.deepEqual(asset.relationships, []);
  const roleAddress = currentRoleAddress(asset, "asset.primary-cover");
  assert.ok(
    roleAddress === undefined || roleAddress.startsWith("/api/v1/media/"),
  );
  return {
    assetId: asset.id,
    relativePath: input.publication.relativePath,
    sourceState: history.recognitionState,
    revision: input.publication.revision,
    localFacts: projection.facts,
    cover: projection.cover,
  };
}

async function inspectEpub(input: {
  readonly client: PublicApiClient;
  readonly libraryId: string;
  readonly publication: EpubPublicationOracle;
  readonly assetId: string;
  readonly directOfficial?: CanonicalOfficialProjection;
  readonly signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const asset = await assetById(input.client, input.libraryId, input.assetId);
  assert.equal(asset.id, input.assetId);
  const facts = await interpretedFactsForAsset(input.client, asset.id);
  assertLocalFacts(
    facts,
    input.publication.formatFacts,
    input.publication.logicalRoot,
  );
  const parentFact = input.publication.formatFacts.find(
    ({ property }) => property === "asset.title",
  );
  assert.ok(parentFact);
  const parent = parentPartForFact(facts, parentFact);
  assertFormatResult({
    results: await formatResultsForAsset(input.client, asset.id),
    revision: input.publication.revision,
    cover: input.publication.cover,
    label: input.publication.logicalRoot,
  });
  const cover = await assertCoverBinding({
    client: input.client,
    assetLibraryId: input.libraryId,
    asset,
    parent,
    cover: input.publication.cover,
    label: input.publication.logicalRoot,
    signal: input.signal,
  });
  assert.deepEqual(asset.relatedEntities, []);
  assert.deepEqual(asset.relationships, []);
  const history = await input.client.inspectSourceAssociationHistory(asset.id);
  const records = await sourceRecordsForAsset(input.client, asset.id);
  if (input.publication.official === undefined) {
    assert.equal(history.recognitionState, "unresolved");
    assert.deepEqual(history.current, []);
    assert.deepEqual(asset.sourceAssociations, []);
    assert.deepEqual(records, []);
    assert.equal(
      facts.filter(({ sourceRecordIds }) => sourceRecordIds.length > 0).length,
      0,
    );
  } else {
    const official = input.publication.official;
    assert.ok(input.directOfficial);
    assert.equal(input.directOfficial.isbn, official.isbn);
    assert.equal(input.directOfficial.sourceAddress, official.sourceAddress);
    const directMetadata = input.directOfficial.metadata
      .map(comparableMetadata)
      .toSorted();
    assert.deepEqual(
      directMetadata,
      official.metadata.map(comparableMetadata).toSorted(),
    );
    assert.equal(history.recognitionState, "recognized");
    assert.deepEqual(
      history.current.map(({ sourceIdentity, nativeAddress }) => ({
        sourceIdentity,
        nativeAddress,
      })),
      [{ sourceIdentity: "nbinet", nativeAddress: official.sourceAddress }],
    );
    assert.equal(history.current.length, 1);
    const currentAssociation = history.current[0]!;
    assert.ok(currentAssociation.id);
    assert.equal(currentAssociation.subjectId, asset.id);
    assert.deepEqual(
      asset.sourceAssociations.map(({ sourceIdentity, nativeAddress }) => ({
        sourceIdentity,
        nativeAddress,
      })),
      [{ sourceIdentity: "nbinet", nativeAddress: official.sourceAddress }],
    );
    const sourceEvidence = await readDirectNbinetRecord(
      asset,
      official,
      input.directOfficial,
      input.client,
      input.signal,
    );
    assertSourceMetadata({
      asset,
      facts,
      sourceIdentity: "nbinet",
      sourceRecordId: String(sourceEvidence["id"]),
      expected: official.metadata,
      label: `EPUB ${official.isbn}`,
    });
    return {
      assetId: asset.id,
      logicalRoot: input.publication.logicalRoot,
      revision: input.publication.revision,
      localFacts: facts
        .filter(({ sourceRecordIds }) => sourceRecordIds.length === 0)
        .map(({ property, value, observedArtifactPart }) => ({
          property,
          value,
          locator: observedArtifactPart?.locator,
        })),
      cover,
      official: sourceEvidence,
    };
  }
  return {
    assetId: asset.id,
    logicalRoot: input.publication.logicalRoot,
    revision: input.publication.revision,
    localFacts: facts.map(({ property, value, observedArtifactPart }) => ({
      property,
      value,
      locator: observedArtifactPart?.locator,
    })),
    cover,
    official: null,
  };
}

async function inspectOwnedRun(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly runId: string;
}): Promise<Awaited<ReturnType<typeof inspectEnvironment>>> {
  const current = await inspectEnvironment({
    workspacePath: input.workspacePath,
    environment: input.environment,
  });
  assert.equal(current.status, "ok");
  assert.equal(
    current.run.runId,
    input.runId,
    "当前运行世代改变；拒绝停止非本次服务",
  );
  return current;
}

async function stopOwnedRun(input: {
  readonly workspacePath: string;
  readonly environment: string;
  readonly runId: string;
  readonly expectedEnvironmentId: string;
  readonly expectedDataGeneration: string;
}): Promise<void> {
  const before = await inspectOwnedRun(input);
  const stopped = await stopEnvironment({
    workspacePath: input.workspacePath,
    environment: input.environment,
  });
  assert.ok(
    stopped.status === "stopped" || stopped.status === "already-stopped",
  );
  const after = await inspectEnvironment({
    workspacePath: input.workspacePath,
    environment: input.environment,
  });
  assert.equal(after.status, "ok");
  assert.equal(after.state, "prepared");
  assert.equal(after.environment.environmentId, input.expectedEnvironmentId);
  assert.equal(after.environment.dataGeneration, input.expectedDataGeneration);
  assert.ok(
    after.run.processLiveness === "exited" ||
      after.run.processLiveness === "absent",
  );
  assert.ok(after.run.state === "stopped" || after.run.state === "absent");
  assert.equal(
    before.environment.environmentId,
    after.environment.environmentId,
  );
}

function ownedRunFromStart(input: {
  readonly started: StartOperationResult;
  readonly previousRunId: string | null;
  readonly environmentId: string;
  readonly dataGeneration: string;
}): { readonly runId: string } | undefined {
  const { started } = input;
  const mayOwnRun =
    started.status === "ready" ||
    (started.status === "failed" && started.cleanup.state === "unknown");
  if (
    !mayOwnRun ||
    started.run.runId === null ||
    started.run.runId === input.previousRunId ||
    started.environment.environmentId !== input.environmentId ||
    started.environment.dataGeneration !== input.dataGeneration
  )
    return undefined;
  return { runId: started.run.runId };
}

async function runPublicationsWithEvidence(
  input: PublicationsLiveInput,
): Promise<PublicationsLiveResult> {
  if (!path.isAbsolute(input.workspacePath))
    throw new ConditionMissingError([
      "工作区必须通过 DIGITAL_AUTOMATION_WORKSPACE 提供绝对路径",
    ]);
  let workspacePath: string;
  try {
    workspacePath = await realpath(input.workspacePath);
    if (!(await stat(workspacePath)).isDirectory()) throw new Error();
  } catch {
    throw new ConditionMissingError([
      "DIGITAL_AUTOMATION_WORKSPACE 必须是现存目录",
    ]);
  }
  const evidencePath = resolveEvidencePath(workspacePath, input.evidencePath);
  await assertEvidenceDestination(workspacePath, evidencePath, []);
  const evidence: Record<string, unknown> = {
    formatVersion: 1,
    task: "publications-live",
    startedAt: new Date().toISOString(),
    environment: input.environment,
    materialRoot: "已提供完整资料根",
    privateCredentialsRead: false,
    executedSteps: [] as string[],
    outcome: "running",
    cleanupErrors: [] as { phase: string; failure: SafeFailure }[],
  };
  const save = async (): Promise<void> => {
    await writeFile(
      evidencePath,
      `${JSON.stringify(evidence, undefined, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  };
  const completeStep = (step: string): void => {
    const steps = evidence["executedSteps"] as string[];
    if (!steps.includes(step)) steps.push(step);
  };
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const onSigint = (): void => controller.abort(new Error("收到 SIGINT"));
  const onSigterm = (): void => controller.abort(new Error("收到 SIGTERM"));
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let roots: MaterialRoot[] = [];
  let beforeDigests: readonly string[] | undefined;
  let ownedRunId: string | undefined;
  let environmentId: string | undefined;
  let dataGeneration: string | undefined;
  let conditionMissing: readonly string[] | undefined;
  let failure: SafeFailure | undefined;
  let outcome: PublicationsLiveResult["outcome"] = "failed";
  try {
    await save();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.environment))
      throw new ConditionMissingError(["环境名格式无效"]);
    let oracle: PublicationsOracle;
    try {
      oracle = await loadOracle();
    } catch (error) {
      if (error instanceof ConditionMissingError) throw error;
      throw new Error("公开出版物复核预期与已审核版本不符", { cause: error });
    }
    roots = await resolveRoots(input.materialRoot, oracle);
    await assertEvidenceDestination(workspacePath, evidencePath, roots);
    evidence["oracle"] = {
      epub: {
        status: oracle.reviews.epub.status,
        reviewedAt: oracle.reviews.epub.reviewedAt,
      },
      pdf: {
        status: oracle.reviews.pdf.status,
        reviewedAt: oracle.reviews.pdf.reviewedAt,
      },
      epubPublicationCount: oracle.epubPublications.length,
      pdfPublicationCount: oracle.pdfPublications.length,
      officialNbinetIsbns: oracle.epubPublications.flatMap(({ official }) =>
        official === undefined ? [] : [official.isbn],
      ),
    };
    beforeDigests = await Promise.all(
      roots.map(({ realPath }) => digestDirectory(realPath)),
    );
    evidence["materialsBefore"] = roots.map((root, index) => ({
      logicalRoot: root.logicalRoot,
      digest: beforeDigests![index],
    }));
    completeStep("公开复核预期和七个独立素材根已核验");
    await save();

    const prior = await inspectEnvironment({
      workspacePath,
      environment: input.environment,
    });
    evidence["priorEnvironment"] = {
      status: prior.status,
      state: prior.state,
      sourceMode: prior.environment.sourceMode,
      runState: prior.run.state,
      processLiveness: prior.run.processLiveness,
      serviceReadiness: prior.serviceReadiness,
    };
    if (prior.status !== "ok" || prior.state !== "prepared")
      throw new ConditionMissingError([
        "指定 real 环境必须先由正式命令准备完成",
      ]);
    if (prior.environment.sourceMode !== "real")
      throw new ConditionMissingError(["指定环境必须明确配置为 real 来源模式"]);
    if (
      prior.environment.environmentId === null ||
      prior.environment.dataGeneration === null
    )
      throw new ConditionMissingError(["指定环境缺少可核对的数据世代"]);
    if (
      (prior.run.processLiveness !== "exited" &&
        prior.run.processLiveness !== "absent") ||
      (prior.run.state !== "stopped" && prior.run.state !== "absent") ||
      prior.serviceReadiness === "ready"
    )
      throw new ConditionMissingError([
        "出版物 real 环境必须在验收开始前停止；脚本不会接管其他运行中的服务",
      ]);
    environmentId = prior.environment.environmentId;
    dataGeneration = prior.environment.dataGeneration;
    controller.signal.throwIfAborted();
    const started = await startEnvironment({
      workspacePath,
      environment: input.environment,
      runtime: "production",
      signal: controller.signal,
    });
    const owned = ownedRunFromStart({
      started,
      previousRunId: prior.run.runId,
      environmentId,
      dataGeneration,
    });
    evidence["start"] = {
      status: started.status,
      environment: {
        environmentId: started.environment.environmentId,
        dataGeneration: started.environment.dataGeneration,
      },
      run: {
        runId: started.run.runId,
        state: started.run.state,
        processLiveness: started.run.processLiveness,
        serviceReady: started.run.serviceReady,
        address: started.run.address,
        port: started.run.port,
      },
      failure:
        started.failure === undefined
          ? undefined
          : {
              stage: started.failure.stage,
              message: safeMessage(started.failure.message),
              exitCode: started.failure.exitCode,
            },
      cleanup: {
        state: started.cleanup.state,
        errors: started.cleanup.errors.map((item) => safeMessage(item)),
      },
    };
    if (started.status === "already-ready")
      throw new ConditionMissingError([
        "环境已被其他进程启动；脚本没有接管该服务",
      ]);
    if (owned !== undefined) ownedRunId = owned.runId;
    if (started.status !== "ready")
      throw new Error(
        started.failure === undefined
          ? `环境启动未成功：${started.status}`
          : `环境启动失败（阶段 ${started.failure.stage}）：${started.failure.message}`,
      );
    assert.equal(started.environment.environmentId, environmentId);
    assert.equal(started.environment.dataGeneration, dataGeneration);
    assert.ok(started.run.runId);
    assert.ok(started.run.address);
    ownedRunId = started.run.runId;
    await save();
    await waitForProductReady(started.run.address, controller.signal);
    const client = createCorpusClient(started.run.address, controller.signal);
    completeStep("正式产品服务已启动并通过公开就绪接口");
    const libraryResult = await findOrCreateLibrary({ client, roots });
    const library = libraryResult.library;
    evidence["assetLibrary"] = {
      id: library.id,
      displayName: library.displayName,
      created: libraryResult.created,
      directories: library.directories.map(({ id, path: directoryPath }) => ({
        id,
        path: path.basename(directoryPath),
      })),
      recognitionProfileIds: library.recognitionProfileIds,
      sourceIdentities: library.sourceIdentities,
    };
    const scanStart = await client.startAssetLibraryScan(library.id);
    evidence["scanExecutionId"] = scanStart.parentExecutionId;
    const scan = await waitForAssetLibraryScan(
      client,
      scanStart.parentExecutionId,
      workflowTimeoutMs,
    );
    assert.equal(scan.status, "completed");
    assert.ok(
      scan.outcome === "accepted" || scan.outcome === "no-change",
      `出版物扫描未完整成功：${String(scan.outcome)}`,
    );
    completeStep("九本出版物已由正式扫描处理");
    const intakeByRoot = new Map<
      string,
      Awaited<ReturnType<typeof readRootIntake>>
    >();
    for (const root of roots) {
      const intake = await readRootIntake({
        client,
        library,
        parentExecutionId: scan.parentExecutionId,
        root,
      });
      intakeByRoot.set(root.logicalRoot, intake);
    }
    const assetIdByPdfPath = new Map<string, string>();
    const pdfRoot = roots.find(
      ({ logicalRoot }) =>
        logicalRoot === oracle.pdfPublications[0]!.logicalRoot,
    );
    assert.ok(pdfRoot);
    const pdfIntake = intakeByRoot.get(pdfRoot.logicalRoot);
    assert.ok(pdfIntake);
    for (const publication of oracle.pdfPublications)
      assetIdByPdfPath.set(
        publication.relativePath,
        fileForRelativePath(pdfIntake.files, publication.relativePath),
      );
    const assetIdByEpubRoot = new Map<string, string>();
    for (const publication of oracle.epubPublications) {
      const intake = intakeByRoot.get(publication.logicalRoot);
      assert.ok(intake);
      assert.equal(
        intake.files.length,
        1,
        `${publication.logicalRoot} 必须只含一个实测 EPUB`,
      );
      assert.match(intake.files[0]!.relativePath, /\.epub$/iu);
      assert.equal(intake.files[0]!.assetIds.length, 1);
      assetIdByEpubRoot.set(
        publication.logicalRoot,
        intake.files[0]!.assetIds[0]!,
      );
    }
    const allIds = [
      ...assetIdByPdfPath.values(),
      ...assetIdByEpubRoot.values(),
    ];
    assert.equal(new Set(allIds).size, 9, "九个出版物必须保持九个独立资产身份");
    evidence["scan"] = {
      status: scan.status,
      outcome: scan.outcome,
      directoryCount: scan.directories.length,
      assetCount: allIds.length,
      pdf: [...assetIdByPdfPath].map(([relativePath, assetId]) => ({
        relativePath,
        assetId,
      })),
      epub: [...assetIdByEpubRoot].map(([logicalRoot, assetId]) => ({
        logicalRoot,
        assetId,
      })),
    };
    await save();

    const directNbinet = new Map<string, CanonicalOfficialProjection>();
    for (const publication of oracle.epubPublications) {
      if (publication.official === undefined) continue;
      controller.signal.throwIfAborted();
      const direct = await exactOfficialProjection(
        publication.official,
        controller.signal,
      );
      const retained = direct.metadata.map(comparableMetadata).toSorted();
      assert.deepEqual(
        retained,
        publication.official.metadata.map(comparableMetadata).toSorted(),
        `NBINet ${publication.official.isbn} 当前正式记录与复核预期不符`,
      );
      directNbinet.set(publication.official.isbn, direct);
    }
    evidence["directOfficialResponses"] = [...directNbinet].map(
      ([isbn, item]) => ({
        isbn,
        canonicalSha256: item.digest,
        metadataCount: item.metadata.length,
      }),
    );
    completeStep("两条 NBINet 指定 ISBN 已对官方当前响应作未缓存核对");
    await save();

    const epubResults: Record<string, unknown>[] = [];
    for (const publication of oracle.epubPublications) {
      const assetId = assetIdByEpubRoot.get(publication.logicalRoot);
      assert.ok(assetId);
      const official = publication.official;
      const directOfficial =
        official === undefined ? undefined : directNbinet.get(official.isbn);
      epubResults.push(
        await inspectEpub({
          client,
          libraryId: library.id,
          publication,
          assetId,
          ...(directOfficial === undefined ? {} : { directOfficial }),
          signal: controller.signal,
        }),
      );
    }
    evidence["epub"] = epubResults;
    completeStep("六本 EPUB 的完整 OPF 事实、封面父修订版及来源记录已核验");

    const pdfResults: Record<string, unknown>[] = [];
    for (const publication of oracle.pdfPublications) {
      const expected = pdfSourceInputs.find(
        ({ relativePath }) => relativePath === publication.relativePath,
      );
      assert.ok(expected, `PDF 来源预期缺失：${publication.relativePath}`);
      const assetId = assetIdByPdfPath.get(publication.relativePath);
      assert.ok(assetId);
      const initial = await inspectPdf({
        client,
        libraryId: library.id,
        publication,
        expected,
        assetId,
        signal: controller.signal,
      });
      const initialAsset = await assetById(client, library.id, assetId);
      const initialFacts = await interpretedFactsForAsset(client, assetId);
      const expectedFacts = publicationFacts(publication);
      const parent = parentPartForFact(initialFacts, expectedFacts[0]!);
      const local = await localProjection({
        client,
        assetLibraryId: library.id,
        asset: initialAsset,
        parent,
        expectedFacts,
        cover: publication.cover,
        label: publication.relativePath,
        signal: controller.signal,
      });
      const association = await ensurePdfAssociation({
        client,
        asset: initialAsset,
        expected,
        signal: controller.signal,
      });
      const associationHistory =
        await client.inspectSourceAssociationHistory(assetId);
      const retainedRecords = (
        await sourceRecordsForAsset(client, assetId)
      ).filter(
        ({ sourceIdentity }) => sourceIdentity === expected.sourceIdentity,
      );
      const coverage = retainedRecords
        .map(({ coverage: sourceCoverage }) => sourceCoverage?.id ?? "")
        .toSorted();
      assert.deepEqual(coverage, [...expected.expectedCoverage].toSorted());
      assert.ok(retainedRecords.every(({ status }) => status === "available"));
      const retainedAddresses = retainedRecords
        .map(({ nativeAddress }) => {
          if (typeof nativeAddress !== "string")
            throw new Error("PDF 来源记录缺少公开地址");
          return nativeAddress;
        })
        .toSorted((left, right) => left.localeCompare(right));
      assert.deepEqual(
        retainedAddresses,
        expected.sourceIdentity === "kadokawa-jp"
          ? [
              `kadokawa-jp:isbn-search:${expected.isbn}`,
              expected.productAddress,
            ].toSorted((left, right) => left.localeCompare(right))
          : [expected.productAddress],
        `${expected.isbn} 保留的来源记录必须绑定精确检索与详情地址`,
      );
      assert.deepEqual(
        associationHistory.current.map(({ sourceIdentity, nativeAddress }) => ({
          sourceIdentity,
          nativeAddress,
        })),
        [
          {
            sourceIdentity: expected.sourceIdentity,
            nativeAddress: expected.productAddress,
          },
        ],
      );
      const refreshes: Record<string, unknown>[] = [];
      const recordIds: string[] = [];
      for (let refreshIndex = 0; refreshIndex < 2; refreshIndex++) {
        const refreshed = await refreshPdf({
          client,
          libraryId: library.id,
          assetId,
          expected,
          expectedFacts,
          expectedCover: publication.cover,
          parent,
          originalLocalProjection: local.cover,
          signal: controller.signal,
        });
        const candidateId = refreshed["sourceRecordId"];
        assert.equal(typeof candidateId, "string");
        recordIds.push(candidateId as string);
        refreshes.push(refreshed);
      }
      assert.notEqual(
        recordIds[0],
        recordIds[1],
        "重复刷新必须产生两个独立来源记录",
      );
      const finalHistory =
        await client.inspectSourceAssociationHistory(assetId);
      assert.deepEqual(
        finalHistory.current.map(({ sourceIdentity, nativeAddress }) => ({
          sourceIdentity,
          nativeAddress,
        })),
        [
          {
            sourceIdentity: expected.sourceIdentity,
            nativeAddress: expected.productAddress,
          },
        ],
      );
      assert.deepEqual(finalHistory.historical, []);
      pdfResults.push({
        ...initial,
        sourceAssociation: {
          createdNow: association.decisionCreated,
          current: associationHistory.current.map(
            ({ sourceIdentity, nativeAddress }) => ({
              sourceIdentity,
              nativeAddress,
            }),
          ),
          retainedCoverage: coverage,
          historicalCount: associationHistory.historical.length,
        },
        refreshes,
        distinctSourceRecordIds: recordIds,
      });
    }
    evidence["pdf"] = pdfResults;
    completeStep("三本 PDF 已精确关联官方候选并独立刷新两次");
    controller.signal.throwIfAborted();
    outcome = "passed";
    evidence["outcome"] = outcome;
    evidence["finishedAt"] = new Date().toISOString();
    await save();
  } catch (error) {
    if (error instanceof ConditionMissingError) {
      conditionMissing = error.items;
      evidence["conditionMissing"] = {
        items: error.items,
        notExecuted: [
          "正式服务扫描",
          "出版物来源关联与刷新",
          "完整素材前后摘要比较",
        ].filter(
          (step) => !(evidence["executedSteps"] as string[]).includes(step),
        ),
      };
      outcome = "condition-missing";
    } else {
      failure = safeFailure(error);
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      evidence["failure"] = failure;
    }
    evidence["outcome"] = outcome;
    evidence["finishedAt"] = new Date().toISOString();
    try {
      await save();
    } catch (saveError) {
      (
        evidence["cleanupErrors"] as { phase: string; failure: SafeFailure }[]
      ).push({
        phase: "保存业务结果",
        failure: safeFailure(saveError),
      });
    }
  } finally {
    const cleanupErrors = evidence["cleanupErrors"] as {
      phase: string;
      failure: SafeFailure;
    }[];
    try {
      await save();
    } catch (error) {
      cleanupErrors.push({
        phase: "停止前保存证据",
        failure: safeFailure(error),
      });
    }
    if (
      ownedRunId !== undefined &&
      environmentId !== undefined &&
      dataGeneration !== undefined
    ) {
      try {
        await stopOwnedRun({
          workspacePath,
          environment: input.environment,
          runId: ownedRunId,
          expectedEnvironmentId: environmentId,
          expectedDataGeneration: dataGeneration,
        });
        evidence["finalStop"] = { outcome: "stopped", runId: ownedRunId };
      } catch (error) {
        cleanupErrors.push({
          phase: "停止本次服务",
          failure: safeFailure(error),
        });
      }
    }
    if (beforeDigests !== undefined && roots.length > 0) {
      try {
        const afterDigests = await Promise.all(
          roots.map(({ realPath }) => digestDirectory(realPath)),
        );
        evidence["materialsAfter"] = roots.map((root, index) => ({
          logicalRoot: root.logicalRoot,
          digest: afterDigests[index],
        }));
        assert.deepEqual(
          afterDigests,
          beforeDigests,
          "验收前后出版物完整素材字节必须一致",
        );
        controller.signal.throwIfAborted();
      } catch (error) {
        failure ??= safeFailure(error);
        evidence["materialFailure"] = safeFailure(error);
      }
    }
    if (cleanupErrors.length > 0)
      outcome = controller.signal.aborted ? "cancelled" : "failed";
    else if (failure !== undefined)
      outcome = controller.signal.aborted ? "cancelled" : "failed";
    else if (conditionMissing !== undefined) outcome = "condition-missing";
    evidence["outcome"] = outcome;
    if (failure !== undefined) evidence["failure"] = failure;
    evidence["finishedAt"] = new Date().toISOString();
    try {
      await save();
    } catch (error) {
      cleanupErrors.push({
        phase: "最终保存证据",
        failure: safeFailure(error),
      });
      outcome = "failed";
    }
    if (controller.signal.aborted && outcome === "passed") {
      outcome = "cancelled";
      failure ??= safeFailure(
        controller.signal.reason ?? new Error("验收已取消"),
      );
      evidence["outcome"] = outcome;
      evidence["failure"] = failure;
      evidence["finishedAt"] = new Date().toISOString();
      try {
        await save();
      } catch (error) {
        cleanupErrors.push({
          phase: "保存取消结果",
          failure: safeFailure(error),
        });
        outcome = "failed";
      }
    }
    input.signal?.removeEventListener("abort", abortFromCaller);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  const cleanupErrors = evidence["cleanupErrors"] as {
    phase: string;
    failure: SafeFailure;
  }[];
  return {
    outcome,
    evidencePath,
    ...(conditionMissing === undefined ? {} : { conditionMissing }),
    ...(failure === undefined ? {} : { failure }),
    ...(cleanupErrors.length === 0 ? {} : { cleanupErrors }),
  };
}

export async function runPublicationsLive(
  input: PublicationsLiveInput,
): Promise<PublicationsLiveResult> {
  try {
    return await runPublicationsWithEvidence(input);
  } catch (error) {
    return {
      outcome:
        error instanceof ConditionMissingError ? "condition-missing" : "failed",
      ...(error instanceof ConditionMissingError
        ? { conditionMissing: error.items }
        : { failure: safeFailure(error) }),
    };
  }
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    process.stderr.write(
      "condition-missing：用法：pnpm verify:publications-live <专用已准备环境名> <工作区内证据文件> <完整资料根绝对路径>\n",
    );
    process.exitCode = 2;
    return;
  }
  const [environment, evidencePath, materialRoot] = args as [
    string,
    string,
    string,
  ];
  let workspacePath: string;
  try {
    workspacePath = requireInput("DIGITAL_AUTOMATION_WORKSPACE");
  } catch {
    process.stderr.write(
      "condition-missing：必须通过 DIGITAL_AUTOMATION_WORKSPACE 提供现存工作区绝对路径\n",
    );
    process.exitCode = 2;
    return;
  }
  const result = await runPublicationsLive({
    workspacePath,
    environment,
    evidencePath,
    materialRoot,
  });
  if (result.outcome === "passed") {
    process.stdout.write("出版物真实来源验收通过\n");
    return;
  }
  if (result.outcome === "condition-missing") {
    process.stderr.write(
      `condition-missing：${result.conditionMissing?.join("；") ?? "验收条件不足"}\n`,
    );
    process.exitCode = 2;
    return;
  }
  process.stderr.write(
    `出版物真实来源验收${result.outcome === "cancelled" ? "已取消" : "失败"}：${result.failure?.message ?? "请检查安全验收记录"}\n`,
  );
  process.exitCode = result.outcome === "cancelled" ? 130 : 1;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(entryPath)}`).href
)
  await runCli();
