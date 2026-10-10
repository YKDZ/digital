import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { decodeFanboxCollectionFailureCode } from "@digital/fanbox";
import { captureRawFilesystemSnapshot } from "@digital/test-support";

import {
  assertFixedCorpusContentBaselineSubset,
  captureFixedCorpusSnapshots,
  fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle,
  fixedCorpusContentDigestsFromSnapshots,
  fixedCorpusRoots,
  type FixedCorpusContentDigest,
  type FixedCorpusRoot,
} from "../fixed-corpus.ts";
import {
  registeredObservedRootId,
  type CliJourney,
  type CliJourneyCommand,
  type CliJourneyContext,
  type CliJourneyResult,
} from "../journey.ts";

type FanboxBodyBlockOracle = {
  readonly ordinal: number;
  readonly type: "header" | "p" | "image" | "file" | "embed" | "url_embed";
  readonly value: Readonly<Record<string, unknown>>;
};

type FanboxAttachmentOracle = {
  readonly ordinal: number;
  readonly name?: string;
  readonly kind: "file" | "image";
  readonly byteLength?: string;
};

export type FanboxPostOracle = {
  readonly logicalRoot: string;
  readonly directoryDate: string;
  readonly sourceNativeAddress: string;
  readonly title: string;
  readonly publishedDatetime: string;
  readonly postType: "text" | "file" | "image" | "video" | "article";
  readonly creatorId: string;
  readonly entitlement: "available" | "restricted";
  readonly cover: "present" | "absent";
  readonly body:
    | {
        readonly status: "available";
        readonly text: string;
        readonly blocks: readonly FanboxBodyBlockOracle[];
      }
    | {
        readonly status: "restricted";
        readonly blocks: readonly [];
      };
  readonly attachments: readonly FanboxAttachmentOracle[];
};

type MetadataFact = {
  readonly id?: string;
  readonly property: string;
  readonly sourceSlot: string;
  readonly value: string;
  readonly sourceRecordIds: readonly string[];
  readonly qualifiers?: readonly {
    readonly key: string;
    readonly value: string;
  }[];
  readonly observedArtifactPart?: {
    readonly artifactId: string;
    readonly revisionId: string;
    readonly locator: string;
  };
};

type AcceptedProjection = {
  readonly entity: { readonly id: string };
  readonly sourceAssociations: readonly {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  }[];
  readonly recognitionSourceAssociation?: {
    readonly sourceIdentity: string;
    readonly nativeAddress: string;
  };
  readonly artifacts: readonly { readonly id: string }[];
  readonly artifactAssociations: readonly {
    readonly artifactId: string;
    readonly role: string;
    readonly sourceRecordIds?: readonly string[];
  }[];
  readonly locations: readonly {
    readonly artifactId: string;
    readonly kind: string;
  }[];
  readonly blobs: readonly { readonly digest: string }[];
  readonly artifactRevisions: readonly {
    readonly id: string;
    readonly artifactId: string;
    readonly blobDigest: string;
  }[];
  readonly metadata: readonly MetadataFact[];
  readonly sourceArtifactCandidates?: readonly {
    readonly sourceRecordId: string;
    readonly role: string;
    readonly mediaType: string;
    readonly selectionEvidence?: {
      readonly suggestedFilename?: string;
      readonly declaredByteLength?: number;
      readonly sourceOrdinal?: number;
    };
  }[];
  readonly entities?: readonly {
    readonly id?: string;
    readonly sourceKey: string;
    readonly sourceRecordIds: readonly string[];
  }[];
  readonly entityMentions?: readonly {
    readonly sourceRecordIds: readonly string[];
  }[];
  readonly entityResolutionDecisions?: readonly {
    readonly sourceRecordIds: readonly string[];
  }[];
  readonly relationships?: readonly {
    readonly sourceRecordIds: readonly string[];
  }[];
};

export type FanboxJourneyInspection = {
  readonly execution: {
    readonly outcome: string;
    readonly reusedExecutionId?: string;
    readonly dispositions?: readonly {
      readonly key: string;
      readonly reason?: string;
      readonly sourceFailureCodes?: readonly {
        readonly capability: {
          readonly capabilityId: string;
          readonly capabilityVersion: string;
          readonly contractVersion: string;
          readonly identity?: string;
          readonly implementationVersion?: string;
          readonly kind?: string;
          readonly interpretationContractVersions?: readonly string[];
        };
        readonly code: string;
      }[];
    }[];
  };
  readonly sourceRecords: readonly {
    readonly id: string;
    readonly sourceIdentity: string;
    readonly coverage: { readonly id: string };
  }[];
  readonly accepted?: AcceptedProjection;
};

type JourneyState = {
  readonly posts: readonly FanboxPostOracle[];
  readonly roots: readonly FixedCorpusRoot[];
  readonly signatures: ReadonlyMap<string, readonly string[]>;
  readonly deepBefore?: ReadonlyMap<string, FixedCorpusContentDigest>;
  assertionsFailed: boolean;
  attributedInitialOutcome?: {
    readonly resultIndex: number;
    readonly resultCount: number;
    readonly result: CliJourneyResult;
  };
};

type EvidenceIdentity = {
  readonly device: number;
  readonly inode: number;
};

type FanboxLiveFailureCause =
  | { readonly category: "source-connection-unavailable" }
  | { readonly category: "source-connection-verification" }
  | { readonly category: "cloudflare-challenge" }
  | {
      readonly category: "http-status";
      readonly status: number;
      readonly class: "4xx" | "5xx";
    }
  | { readonly category: "transport-failure" }
  | { readonly category: "summary-selection" }
  | { readonly category: "response-contract" }
  | { readonly category: "source-identity-conflict" }
  | { readonly category: "detail-contract" }
  | { readonly category: "artifact-acquisition" }
  | { readonly category: "journey-output-invalid" }
  | { readonly category: "unknown" };

type FanboxLiveFailureEvidence = {
  readonly format: "fanbox-live-failure/1";
  readonly evidenceState: "cause-persisted" | "teardown-finished";
  readonly mode: "source" | "distribution";
  readonly journey: "fanbox-five-live";
  readonly stage:
    | "connection-import"
    | "root-registration"
    | "initial-accept"
    | "reopened-no-change"
    | "metadata-refresh"
    | "assertions"
    | "teardown";
  readonly command?: {
    readonly ordinal: number;
    readonly name: string;
    readonly post?: {
      readonly ordinal: number;
      readonly nativeAddress: string;
    };
    readonly exitCode: number;
  };
  readonly inspection?: {
    readonly outcome: "failed" | "partially-succeeded";
    readonly workflowStage?:
      | "recognition"
      | "source-records-retained"
      | "source-artifacts-acquired"
      | "source-artifacts-stored"
      | "completed"
      | "failed";
  };
  readonly cause: FanboxLiveFailureCause;
  readonly teardown: "pending" | "passed" | "failed";
  readonly stateReleased: "pending" | "yes";
};

type ExpectedFanboxCommand = {
  readonly name: string;
  readonly stage: FanboxLiveFailureEvidence["stage"];
  readonly post?: {
    readonly ordinal: number;
    readonly nativeAddress: string;
  };
};

const fanboxFailureEvidenceEnvironment =
  "DIGITAL_FANBOX_LIVE_FAILURE_EVIDENCE_PATH";
const fanboxFailureEvidenceMaximumBytes = 2_048;
const workflowStages = [
  "recognition",
  "source-records-retained",
  "source-artifacts-acquired",
  "source-artifacts-stored",
  "completed",
  "failed",
] as const;

const stateByContext = new Map<string, JourneyState>();

function stateKey(context: CliJourneyContext): string {
  return `${context.mode}\u0000${context.workDir}`;
}

function currentState(context: CliJourneyContext): JourneyState {
  const state = stateByContext.get(stateKey(context));
  if (state === undefined)
    throw new Error("FANBOX live journey was not set up");
  return state;
}

function expectedFanboxCommands(
  posts: readonly FanboxPostOracle[],
): readonly ExpectedFanboxCommand[] {
  const phases = [
    ["root-registration", (id: string) => `register FANBOX post root ${id}`],
    ["initial-accept", (id: string) => `live accept FANBOX post ${id}`],
    [
      "reopened-no-change",
      (id: string) => `live no-change FANBOX post ${id} after SQLite reopen`,
    ],
    [
      "metadata-refresh",
      (id: string) => `live metadata refresh FANBOX post ${id}`,
    ],
  ] as const;
  return [
    { name: "import FANBOX creator connection", stage: "connection-import" },
    ...phases.flatMap(([stage, commandName]) =>
      posts.map((post, index) => ({
        name: commandName(post.sourceNativeAddress),
        stage,
        post: {
          ordinal: index + 1,
          nativeAddress: post.sourceNativeAddress,
        },
      })),
    ),
  ];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const allowed = expected.toSorted();
  return (
    actual.length === allowed.length &&
    actual.every((key, index) => key === allowed[index])
  );
}

function liveFailureCause(
  decoded: NonNullable<ReturnType<typeof decodeFanboxCollectionFailureCode>>,
): FanboxLiveFailureCause {
  if (decoded.category === "http-status") return decoded;
  switch (decoded.category) {
    case "connection-unavailable":
      return { category: "source-connection-unavailable" };
    case "cloudflare-challenge":
    case "transport-failure":
    case "summary-selection":
    case "response-contract":
    case "source-identity-conflict":
    case "detail-contract":
    case "unknown":
      return { category: decoded.category };
  }
}

function inspectionDiagnostic(stdout: string): {
  readonly inspection?: FanboxLiveFailureEvidence["inspection"];
  readonly cause: FanboxLiveFailureCause;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return { cause: { category: "journey-output-invalid" } };
  }
  const inspection = record(parsed);
  const execution = record(inspection?.execution);
  if (
    inspection?.format !== "temporary-asset-refresh-inspection/v1" ||
    (execution?.outcome !== "failed" &&
      execution?.outcome !== "partially-succeeded")
  ) {
    return { cause: { category: "journey-output-invalid" } };
  }
  const decodedCauses: FanboxLiveFailureCause[] = [];
  if (Array.isArray(execution.dispositions)) {
    for (const disposition of execution.dispositions) {
      const item = record(disposition);
      if (item === undefined || !Object.hasOwn(item, "sourceFailureCodes"))
        continue;
      if (
        !Array.isArray(item.sourceFailureCodes) ||
        item.sourceFailureCodes.length === 0 ||
        item.sourceFailureCodes.length > 16
      )
        return { cause: { category: "unknown" } };
      for (const candidate of item.sourceFailureCodes) {
        const code = record(candidate);
        const capability = record(code?.capability);
        if (
          code === undefined ||
          !hasExactKeys(code, ["capability", "code"]) ||
          capability === undefined ||
          !hasExactKeys(capability, [
            "capabilityId",
            "capabilityVersion",
            "contractVersion",
            "identity",
            "implementationVersion",
            "kind",
            "interpretationContractVersions",
          ]) ||
          typeof code?.code !== "string" ||
          typeof capability?.capabilityId !== "string" ||
          typeof capability.capabilityVersion !== "string" ||
          typeof capability.contractVersion !== "string" ||
          typeof capability.identity !== "string" ||
          typeof capability.implementationVersion !== "string" ||
          typeof capability.kind !== "string" ||
          !Array.isArray(capability.interpretationContractVersions) ||
          !capability.interpretationContractVersions.every(
            (version) => typeof version === "string",
          )
        )
          return { cause: { category: "unknown" } };
        const decoded = decodeFanboxCollectionFailureCode({
          capability: {
            capabilityId: capability.capabilityId,
            capabilityVersion: capability.capabilityVersion,
            contractVersion: capability.contractVersion,
            identity: capability.identity,
            implementationVersion: capability.implementationVersion,
            kind: capability.kind,
            interpretationContractVersions:
              capability.interpretationContractVersions,
          },
          code: code.code,
        });
        if (decoded === undefined) return { cause: { category: "unknown" } };
        decodedCauses.push(liveFailureCause(decoded));
      }
    }
  }
  const workflowStage = workflowStages.find(
    (stage) => stage === execution.stage,
  );
  return {
    inspection: {
      outcome: execution.outcome,
      ...(workflowStage === undefined ? {} : { workflowStage }),
    },
    cause:
      decodedCauses.length > 0 &&
      decodedCauses.every(
        (cause) => JSON.stringify(cause) === JSON.stringify(decodedCauses[0]),
      )
        ? decodedCauses[0]!
        : { category: "unknown" },
  };
}

function failureEvidence(
  context: CliJourneyContext,
  state: JourneyState,
  results: readonly CliJourneyResult[],
): FanboxLiveFailureEvidence | undefined {
  assert.notEqual(context.mode, "packed");
  const mode = context.mode as "source" | "distribution";
  const invalid = (
    stage: "assertions" | "teardown",
  ): FanboxLiveFailureEvidence => ({
    format: "fanbox-live-failure/1",
    evidenceState: "cause-persisted",
    mode,
    journey: "fanbox-five-live",
    stage,
    cause: { category: "journey-output-invalid" },
    teardown: "pending",
    stateReleased: "pending",
  });
  const expected = expectedFanboxCommands(state.posts);
  const evidenceFor = (
    resultIndex: number,
    result: CliJourneyResult,
  ): FanboxLiveFailureEvidence => {
    const expectedCommand = expected[resultIndex]!;
    const diagnostic =
      resultIndex === 0
        ? { cause: { category: "unknown" } as FanboxLiveFailureCause }
        : expectedCommand.stage === "initial-accept" ||
            expectedCommand.stage === "reopened-no-change" ||
            expectedCommand.stage === "metadata-refresh"
          ? inspectionDiagnostic(result.stdout)
          : { cause: { category: "unknown" } as FanboxLiveFailureCause };
    return {
      format: "fanbox-live-failure/1",
      evidenceState: "cause-persisted",
      mode,
      journey: "fanbox-five-live",
      stage: expectedCommand.stage,
      command: {
        ordinal: resultIndex + 1,
        name: expectedCommand.name,
        ...(expectedCommand.post === undefined
          ? {}
          : { post: expectedCommand.post }),
        exitCode: result.exitCode,
      },
      ...(diagnostic.inspection === undefined
        ? {}
        : { inspection: diagnostic.inspection }),
      cause: diagnostic.cause,
      teardown: "pending",
      stateReleased: "pending",
    };
  };
  const attributed = state.attributedInitialOutcome;
  if (attributed !== undefined) {
    const expectedCommand = expected[attributed.resultIndex];
    const validAttribution =
      expectedCommand?.stage === "initial-accept" &&
      results.length === attributed.resultCount &&
      results.length <= expected.length &&
      results[attributed.resultIndex] === attributed.result &&
      Array.from(
        { length: results.length },
        (_, index) => results[index],
      ).every(
        (result, index) =>
          result !== undefined &&
          result.commandName === expected[index]?.name &&
          result.exitCode === 0,
      );
    return validAttribution
      ? evidenceFor(attributed.resultIndex, attributed.result)
      : invalid("teardown");
  }
  const failedIndex = results.findIndex((result) => result.exitCode !== 0);
  if (failedIndex < 0) {
    const completeSuccess =
      results.length === expected.length &&
      results.every(
        (result, index) =>
          result.commandName === expected[index]!.name && result.exitCode === 0,
      );
    if (completeSuccess)
      return state.assertionsFailed ? invalid("assertions") : undefined;
    return invalid("teardown");
  }
  const validSequence =
    results.length <= expected.length &&
    failedIndex === results.length - 1 &&
    results.every(
      (result, index) =>
        result.commandName === expected[index]?.name &&
        Number.isSafeInteger(result.exitCode) &&
        (index === failedIndex
          ? result.exitCode >= 1 && result.exitCode <= 255
          : result.exitCode === 0),
    );
  if (!validSequence) {
    return invalid("teardown");
  }
  return evidenceFor(failedIndex, results[failedIndex]!);
}

function corpusRoot(context: CliJourneyContext): string {
  return path.resolve(
    context.packageRoot,
    "../..",
    ".scratch/acceptance-corpus",
  );
}

async function entrySignature(root: string): Promise<readonly string[]> {
  return (await captureRawFilesystemSnapshot(root)).entries
    .filter((entry) => entry.relativePath !== ".")
    .map(
      (entry) =>
        `${entry.relativePath}:${entry.kind === "directory" ? "d" : entry.kind === "regular-file" ? "f" : entry.kind === "symbolic-link" ? "l" : "o"}:${entry.byteLength}:${entry.modifiedAtNanoseconds}:${entry.changedAtNanoseconds}:${entry.symbolicLinkTarget ?? ""}`,
    );
}

function serializedFailureEvidence(
  evidence: FanboxLiveFailureEvidence,
): string {
  const serialized = `${JSON.stringify(evidence)}\n`;
  assert.ok(
    Buffer.byteLength(serialized) <= fanboxFailureEvidenceMaximumBytes,
    "FANBOX 失败证据超过字节上限",
  );
  assertSafe(
    !/FANBOXSESSID|cf_clearance|authorization|cookie|docs[\\/]fanbox\.json/iu.test(
      serialized,
    ),
    "FANBOX 失败证据包含禁止的私密标记",
  );
  return serialized;
}

async function syncParent(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function assertEvidencePathAvailable(
  context: CliJourneyContext,
  evidencePath: string,
): Promise<void> {
  assert.equal(path.isAbsolute(evidencePath), true);
  const relativeToWorkDir = path.relative(context.workDir, evidencePath);
  assert.equal(
    relativeToWorkDir === ".." ||
      relativeToWorkDir.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToWorkDir),
    true,
    "FANBOX 失败证据必须位于旅程工作目录之外",
  );
  const parent = path.dirname(evidencePath);
  const parentStatus = await lstat(parent);
  assert.equal(parentStatus.isDirectory(), true);
  assert.equal(parentStatus.isSymbolicLink(), false);
  if (process.getuid !== undefined)
    assert.equal(parentStatus.uid, process.getuid());
  assert.equal(parentStatus.mode & 0o777, 0o700);
  try {
    await lstat(evidencePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error("FANBOX 失败证据路径已存在");
}

function evidenceIdentity(device: number, inode: number): EvidenceIdentity {
  assert.equal(Number.isSafeInteger(device) && device >= 0, true);
  assert.equal(Number.isSafeInteger(inode) && inode > 0, true);
  return { device, inode };
}

async function assertEvidenceInode(
  evidencePath: string,
  handle: FileHandle,
  expected?: EvidenceIdentity,
): Promise<EvidenceIdentity> {
  const [pathStatus, handleStatus] = await Promise.all([
    lstat(evidencePath),
    handle.stat(),
  ]);
  for (const status of [pathStatus, handleStatus]) {
    assert.equal(status.isFile(), true);
    assert.equal(status.isSymbolicLink(), false);
    if (process.getuid !== undefined)
      assert.equal(status.uid, process.getuid());
    assert.equal(status.mode & 0o777, 0o600);
  }
  const identity = evidenceIdentity(handleStatus.dev, handleStatus.ino);
  assert.deepEqual(
    evidenceIdentity(pathStatus.dev, pathStatus.ino),
    identity,
    "FANBOX 失败证据路径与已打开文件的身份不一致",
  );
  if (expected !== undefined)
    assert.deepEqual(identity, expected, "FANBOX 失败证据 inode 身份发生漂移");
  return identity;
}

async function readEvidenceHandle(handle: FileHandle): Promise<string> {
  const status = await handle.stat();
  assert.ok(status.size <= fanboxFailureEvidenceMaximumBytes * 2);
  const contents = Buffer.alloc(status.size);
  let offset = 0;
  while (offset < contents.length) {
    const { bytesRead } = await handle.read(
      contents,
      offset,
      contents.length - offset,
      offset,
    );
    assert.notEqual(bytesRead, 0);
    offset += bytesRead;
  }
  return contents.toString("utf8");
}

function assertEvidenceLog(
  contents: string,
  expected: readonly FanboxLiveFailureEvidence[],
): void {
  const serialized = expected.map(serializedFailureEvidence).join("");
  assert.equal(Buffer.byteLength(serialized) <= 4_096, true);
  assert.equal(contents, serialized);
  const parsed = contents
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  assert.deepEqual(parsed, expected);
}

async function persistInitialEvidence(
  evidencePath: string,
  evidence: FanboxLiveFailureEvidence,
): Promise<EvidenceIdentity> {
  const parent = path.dirname(evidencePath);
  const handle = await open(evidencePath, "wx", 0o600);
  let createdIdentity: EvidenceIdentity;
  try {
    await handle.writeFile(serializedFailureEvidence(evidence), "utf8");
    await handle.sync();
    createdIdentity = await assertEvidenceInode(evidencePath, handle);
  } finally {
    await handle.close();
  }
  await syncParent(parent);
  const reopened = await open(evidencePath, constants.O_RDONLY);
  try {
    const identity = await assertEvidenceInode(
      evidencePath,
      reopened,
      createdIdentity,
    );
    assertEvidenceLog(await readEvidenceHandle(reopened), [evidence]);
    return identity;
  } finally {
    await reopened.close();
  }
}

async function appendFinishedEvidence(
  evidencePath: string,
  initial: FanboxLiveFailureEvidence,
  finished: FanboxLiveFailureEvidence,
  identity: EvidenceIdentity,
): Promise<void> {
  const handle = await open(
    evidencePath,
    constants.O_RDWR | constants.O_APPEND,
  );
  try {
    await assertEvidenceInode(evidencePath, handle, identity);
    assertEvidenceLog(await readEvidenceHandle(handle), [initial]);
    await handle.writeFile(serializedFailureEvidence(finished), "utf8");
    await handle.sync();
    await assertEvidenceInode(evidencePath, handle, identity);
    assertEvidenceLog(await readEvidenceHandle(handle), [initial, finished]);
  } finally {
    await handle.close();
  }
}

async function assertFanboxMediaUnchanged(
  context: CliJourneyContext,
  state: JourneyState,
): Promise<void> {
  for (const [index, post] of state.posts.entries()) {
    assertSensitiveEqual(
      await entrySignature(state.roots[index]!.directory),
      state.signatures.get(post.logicalRoot),
      "FANBOX 实时旅程改变了单根条目签名",
    );
  }
  if (state.deepBefore !== undefined) {
    const after = await captureFixedCorpusSnapshots(state.roots, true);
    const deepAfter = fixedCorpusContentDigestsFromSnapshots(
      state.roots,
      after,
    );
    await assertFixedCorpusContentBaselineSubset(context, deepAfter);
    assertSensitiveEqual(
      deepAfter,
      state.deepBefore,
      "FANBOX live journey must not alter approved source bytes",
    );
  }
}

function parseSensitiveJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(message);
  }
}

function assertSensitiveEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  assertSafe(isDeepStrictEqual(actual, expected), message);
}

function assertSafe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function observedRootId(result: CliJourneyResult | undefined): string {
  try {
    return registeredObservedRootId(result);
  } catch {
    throw new Error("FANBOX observed-root result is invalid");
  }
}

function inspection(
  result: CliJourneyResult | undefined,
): FanboxJourneyInspection {
  return parseSensitiveJson(
    result?.stdout ?? "{}",
    "FANBOX inspection output is invalid",
  ) as FanboxJourneyInspection;
}

function qualifier(fact: MetadataFact, key: string): string | undefined {
  return fact.qualifiers?.find((item) => item.key === key)?.value;
}

function exactMetadataValue(
  accepted: AcceptedProjection,
  property: string,
): string | undefined {
  const values = accepted.metadata.filter((item) => item.property === property);
  assertSafe(
    values.length <= 1,
    `${property} must have at most one current value`,
  );
  return values[0]?.value;
}

function assertBodyProjection(
  accepted: AcceptedProjection,
  post: FanboxPostOracle,
): void {
  if (post.body.status === "available")
    assertSensitiveEqual(
      exactMetadataValue(accepted, "asset.body"),
      post.body.text,
      "FANBOX asset.body value drifted",
    );
  else
    assertSensitiveEqual(
      exactMetadataValue(accepted, "asset.body"),
      undefined,
      "FANBOX restricted asset.body must be absent",
    );
  const actual = accepted.metadata
    .filter((item) => item.property === "fanbox.post.body-block")
    .map((item) => ({
      ordinal: Number(qualifier(item, "fanbox.post.block-ordinal")),
      type: qualifier(item, "fanbox.post.block-type"),
      value: parseSensitiveJson(
        item.value,
        "FANBOX body block value is invalid",
      ),
      sourceRecordIds: item.sourceRecordIds,
    }))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  assertSensitiveEqual(
    actual.map(({ sourceRecordIds: _sourceRecordIds, ...item }) => item),
    post.body.blocks,
    "FANBOX complete body block projection drifted",
  );
  assertSafe(
    actual.every((item) => item.sourceRecordIds.length > 0),
    "FANBOX body blocks require current Source Record provenance",
  );
}

function assertAttachmentProjection(
  accepted: AcceptedProjection,
  post: FanboxPostOracle,
): void {
  const actual = (accepted.sourceArtifactCandidates ?? [])
    .filter((candidate) => candidate.role.startsWith("fanbox.attachment."))
    .toSorted(
      (left, right) =>
        (left.selectionEvidence?.sourceOrdinal ?? Number.MAX_SAFE_INTEGER) -
        (right.selectionEvidence?.sourceOrdinal ?? Number.MAX_SAFE_INTEGER),
    )
    .map((candidate) => ({
      ordinal: candidate.selectionEvidence?.sourceOrdinal,
      kind: candidate.role.slice("fanbox.attachment.".length),
      ...(candidate.selectionEvidence?.suggestedFilename === undefined
        ? {}
        : { name: candidate.selectionEvidence.suggestedFilename }),
      ...(candidate.selectionEvidence?.declaredByteLength === undefined
        ? {}
        : {
            byteLength: String(candidate.selectionEvidence.declaredByteLength),
          }),
    }));
  assertSensitiveEqual(
    actual,
    post.attachments,
    "FANBOX attachment listing drifted",
  );
}

function stableAcceptedProjection(accepted: AcceptedProjection): unknown {
  return {
    entityId: accepted.entity.id,
    sourceAssociations: accepted.sourceAssociations,
    recognitionSourceAssociation: accepted.recognitionSourceAssociation,
    artifacts: accepted.artifacts.map((item) => item.id).toSorted(),
    locations: accepted.locations
      .map((item) => ({ artifactId: item.artifactId, kind: item.kind }))
      .toSorted((left, right) =>
        left.artifactId.localeCompare(right.artifactId),
      ),
    artifactAssociations: accepted.artifactAssociations
      .map((item) => ({ artifactId: item.artifactId, role: item.role }))
      .toSorted((left, right) =>
        `${left.artifactId}:${left.role}`.localeCompare(
          `${right.artifactId}:${right.role}`,
        ),
      ),
    metadata: accepted.metadata
      .map((item) => ({
        property: item.property,
        sourceSlot: item.sourceSlot,
        value: item.value,
        qualifiers: item.qualifiers,
      }))
      .toSorted((left, right) =>
        `${left.property}:${left.sourceSlot ?? ""}`.localeCompare(
          `${right.property}:${right.sourceSlot ?? ""}`,
        ),
      ),
    sourceArtifactCandidates: accepted.sourceArtifactCandidates?.map(
      ({ role, mediaType, selectionEvidence }) => ({
        role,
        mediaType,
        selectionEvidence,
      }),
    ),
    entities: (accepted.entities ?? [])
      .map((item) => ({ id: item.id, sourceKey: item.sourceKey }))
      .toSorted((left, right) => (left.id ?? "").localeCompare(right.id ?? "")),
  };
}

type FanboxSourcedFact = {
  readonly kind:
    | "metadata"
    | "entity"
    | "entity-mention"
    | "entity-resolution-decision"
    | "relationship"
    | "source-artifact-candidate"
    | "artifact-association";
  readonly value: unknown;
  readonly sourceRecordIds: readonly string[];
};

function denseItems<T>(values: readonly T[], label: string): readonly T[] {
  assertSafe(Array.isArray(values), `FANBOX ${label} must be an array`);
  const dense = Array.from(
    { length: values.length },
    (_, index) => values[index],
  );
  assertSafe(
    dense.every((value) => value !== undefined),
    `FANBOX ${label} must not be sparse`,
  );
  return dense as readonly T[];
}

function sourceGeneration(
  value: FanboxJourneyInspection,
  stage: "initial" | "refresh",
): ReadonlySet<string> {
  const records = denseItems(value.sourceRecords, `${stage} Source Records`);
  assertSafe(
    records.length === 2,
    `FANBOX ${stage} Source Records must contain summary and detail`,
  );
  const expectedCoverage = [
    "fanbox.creator-post-summaries",
    "fanbox.post-detail",
  ] as const;
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    assertSafe(
      typeof record.id === "string" && record.id.trim().length > 0,
      `FANBOX ${stage} Source Record id is invalid`,
    );
    assertSafe(
      record.sourceIdentity === "fanbox",
      `FANBOX ${stage} Source Record identity is invalid`,
    );
    assertSafe(
      record.coverage.id === expectedCoverage[index],
      `FANBOX ${stage} Source Record coverage is invalid`,
    );
    ids.add(record.id);
  }
  assertSafe(
    ids.size === records.length,
    `FANBOX ${stage} Source Record ids must be unique`,
  );
  return ids;
}

function sourcedFacts(
  accepted: AcceptedProjection,
): readonly FanboxSourcedFact[] {
  const facts: FanboxSourcedFact[] = [];
  for (const fact of denseItems(accepted.metadata, "metadata"))
    if (fact.observedArtifactPart === undefined)
      facts.push({
        kind: "metadata",
        value: fact,
        sourceRecordIds: fact.sourceRecordIds,
      });
  for (const [kind, values] of [
    ["entity", accepted.entities ?? []],
    ["entity-mention", accepted.entityMentions ?? []],
    ["entity-resolution-decision", accepted.entityResolutionDecisions ?? []],
    ["relationship", accepted.relationships ?? []],
  ] as const)
    for (const fact of denseItems(values, kind))
      facts.push({ kind, value: fact, sourceRecordIds: fact.sourceRecordIds });
  for (const candidate of denseItems(
    accepted.sourceArtifactCandidates ?? [],
    "source artifact candidates",
  ))
    facts.push({
      kind: "source-artifact-candidate",
      value: candidate,
      sourceRecordIds: [candidate.sourceRecordId],
    });
  for (const association of denseItems(
    accepted.artifactAssociations,
    "artifact associations",
  ))
    if (association.sourceRecordIds !== undefined)
      facts.push({
        kind: "artifact-association",
        value: association,
        sourceRecordIds: association.sourceRecordIds,
      });
  return facts;
}

function assertFactIds(
  fact: FanboxSourcedFact,
  allowed: ReadonlySet<string>,
  stage: "initial" | "refresh",
): void {
  const ids = denseItems(
    fact.sourceRecordIds,
    `${stage} ${fact.kind} Source Record ids`,
  );
  assertSafe(
    ids.length > 0 &&
      ids.every(
        (id) =>
          typeof id === "string" && id.trim().length > 0 && allowed.has(id),
      ),
    `FANBOX ${stage} ${fact.kind} provenance is invalid`,
  );
}

function assertFanboxPostProjection(
  value: FanboxJourneyInspection,
  post: FanboxPostOracle,
): {
  readonly accepted: AcceptedProjection;
  readonly facts: readonly FanboxSourcedFact[];
} {
  assertSafe(
    value.execution.outcome === "accepted",
    "FANBOX inspection outcome must be accepted",
  );
  const accepted = value.accepted;
  assertSafe(accepted !== undefined, "FANBOX accepted projection is missing");
  denseItems(accepted.sourceAssociations, "source associations");
  denseItems(accepted.artifacts, "artifacts");
  const locations = denseItems(accepted.locations, "locations");
  const revisions = denseItems(accepted.artifactRevisions, "revisions");
  const blobs = denseItems(accepted.blobs, "blobs");
  const metadata = denseItems(accepted.metadata, "metadata");
  const artifactAssociations = denseItems(
    accepted.artifactAssociations,
    "artifact associations",
  );
  const expectedSourceAssociation = {
    sourceIdentity: "fanbox",
    nativeAddress: `https://www.fanbox.cc/@${post.creatorId}/posts/${post.sourceNativeAddress}`,
  };
  assertSensitiveEqual(
    accepted.sourceAssociations,
    [expectedSourceAssociation],
    "FANBOX source association drifted",
  );
  assertSafe(
    accepted.recognitionSourceAssociation !== undefined,
    "FANBOX accepted projection is missing its recognition source",
  );
  assertSensitiveEqual(
    accepted.recognitionSourceAssociation,
    expectedSourceAssociation,
    "FANBOX recognition source association drifted",
  );
  for (const [property, expected] of [
    ["asset.title", post.title],
    ["asset.publication-datetime", post.publishedDatetime],
    ["fanbox.post.form", post.postType],
    ["fanbox.post.entitlement", post.entitlement],
  ] as const)
    assertSensitiveEqual(
      exactMetadataValue(accepted, property),
      expected,
      `FANBOX ${property} value drifted`,
    );
  assertBodyProjection(accepted, post);
  assertAttachmentProjection(accepted, post);
  assertSafe(
    accepted.entities?.some((entity) => entity.sourceKey === post.creatorId) ===
      true,
    "FANBOX creator entity is missing",
  );
  const observedArtifactIds = new Set(
    locations
      .filter((location) => location.kind === "observed")
      .map((location) => location.artifactId),
  );
  const artifactRevisions = new Map(
    revisions.map((revision) => [revision.id, revision]),
  );
  const blobDigests = new Set(blobs.map((blob) => blob.digest));
  const genericFanboxSourceOwnedProperties = new Set([
    "asset.title",
    "asset.publication-datetime",
    "asset.body",
  ]);
  for (const fact of metadata) {
    const observedPart = fact.observedArtifactPart;
    const isFanboxSourceOwned =
      fact.sourceSlot.startsWith("fanbox.post.") ||
      fact.property.startsWith("fanbox.post.") ||
      genericFanboxSourceOwnedProperties.has(fact.property);
    if (isFanboxSourceOwned)
      assertSafe(
        observedPart === undefined,
        "FANBOX source-owned metadata cannot use local provenance",
      );
    if (observedPart === undefined) continue;
    const revision = artifactRevisions.get(observedPart.revisionId);
    const localSourceIds = denseItems(
      fact.sourceRecordIds,
      "local metadata Source Record ids",
    );
    assertSafe(
      localSourceIds.length === 0 &&
        observedPart.locator.trim().length > 0 &&
        observedArtifactIds.has(observedPart.artifactId) &&
        revision?.artifactId === observedPart.artifactId &&
        blobDigests.has(revision.blobDigest),
      "FANBOX local metadata requires a complete observed artifact revision",
    );
  }
  assertSafe(
    artifactAssociations
      .filter((association) => observedArtifactIds.has(association.artifactId))
      .every((association) => association.role === "asset.material-delivered"),
    "FANBOX observed artifact association is invalid",
  );
  const managedArtifactIds = new Set(
    locations
      .filter((location) => location.kind === "managed")
      .map((location) => location.artifactId),
  );
  const sourceArtifacts = artifactAssociations.filter(
    (association) => (association.sourceRecordIds?.length ?? 0) > 0,
  );
  assertSafe(
    sourceArtifacts.every(
      (association) =>
        association.role === "asset.primary-cover" &&
        managedArtifactIds.has(association.artifactId),
    ),
    "FANBOX journey managed an unrequested source attachment",
  );
  assertSafe(
    sourceArtifacts.filter(
      (association) => association.role === "asset.primary-cover",
    ).length === (post.cover === "present" ? 1 : 0),
    "FANBOX primary cover count is invalid",
  );
  return { accepted, facts: sourcedFacts(accepted) };
}

function initialPostLifecycle(
  value: FanboxJourneyInspection,
  post: FanboxPostOracle,
): {
  readonly sourceRecordIds: ReadonlySet<string>;
  readonly accepted: AcceptedProjection;
  readonly facts: readonly FanboxSourcedFact[];
} {
  const sourceRecordIds = sourceGeneration(value, "initial");
  const projection = assertFanboxPostProjection(value, post);
  for (const fact of projection.facts)
    assertFactIds(fact, sourceRecordIds, "initial");
  return { sourceRecordIds, ...projection };
}

export function assertFanboxAcceptedPost(
  value: FanboxJourneyInspection,
  post: FanboxPostOracle,
): void {
  initialPostLifecycle(value, post);
}

export function assertFanboxRefreshedPost(
  initial: FanboxJourneyInspection,
  refreshed: FanboxJourneyInspection,
  post: FanboxPostOracle,
): void {
  const initialLifecycle = initialPostLifecycle(initial, post);
  const refreshedSourceRecordIds = sourceGeneration(refreshed, "refresh");
  for (const id of refreshedSourceRecordIds)
    assertSafe(
      !initialLifecycle.sourceRecordIds.has(id),
      "FANBOX refresh Source Record ids must not reuse initial ids",
    );
  const refreshedProjection = assertFanboxPostProjection(refreshed, post);
  const unmatchedInitialFacts = [...initialLifecycle.facts];
  for (const fact of refreshedProjection.facts) {
    const ids = denseItems(
      fact.sourceRecordIds,
      `refresh ${fact.kind} Source Record ids`,
    );
    const usesRefresh =
      ids.length > 0 && ids.every((id) => refreshedSourceRecordIds.has(id));
    const initialMatch =
      ids.length > 0 &&
      ids.every((id) => initialLifecycle.sourceRecordIds.has(id))
        ? unmatchedInitialFacts.findIndex(
            (initialFact) =>
              initialFact.kind === fact.kind &&
              isDeepStrictEqual(initialFact.value, fact.value),
          )
        : -1;
    const preservesInitial = initialMatch >= 0;
    if (preservesInitial) unmatchedInitialFacts.splice(initialMatch, 1);
    assertSafe(
      usesRefresh || preservesInitial,
      `FANBOX refresh ${fact.kind} provenance is invalid`,
    );
  }
  assertSensitiveEqual(
    stableAcceptedProjection(refreshedProjection.accepted),
    stableAcceptedProjection(initialLifecycle.accepted),
    "FANBOX refresh changed stable identity or reviewed business facts",
  );
}

export function assertFanboxReopenedPost(
  initial: FanboxJourneyInspection,
  reopened: FanboxJourneyInspection,
  post: FanboxPostOracle,
): void {
  assertSafe(
    reopened.execution.outcome === "no-change",
    "FANBOX reopen outcome must be no-change",
  );
  assertSensitiveEqual(
    reopened.sourceRecords,
    [],
    "FANBOX reopen must not publish Source Records",
  );
  const prior = initial.accepted;
  const current = reopened.accepted;
  assertSafe(prior !== undefined, "initial FANBOX projection is missing");
  assertSafe(current !== undefined, "reopened FANBOX projection is missing");
  assertSensitiveEqual(
    stableAcceptedProjection(current),
    stableAcceptedProjection(prior),
    "FANBOX identity and business facts changed after SQLite reopen",
  );
  assertBodyProjection(current, post);
  assertAttachmentProjection(current, post);
}

function oracleRecord(value: unknown, label: string): Record<string, unknown> {
  assertSafe(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function oracleArray(value: unknown, label: string): readonly unknown[] {
  assertSafe(Array.isArray(value), `${label} must be an array`);
  return value;
}

function oracleString(value: unknown, label: string): string {
  assertSafe(
    typeof value === "string" && value.trim().length > 0,
    `${label} must be a non-empty string`,
  );
  return value;
}

function oracleParagraphText(value: unknown, label: string): string {
  assertSafe(typeof value === "string", `${label} must be a string`);
  const text = value;
  assertSafe(
    text === "" || text.trim().length > 0,
    `${label} must be exactly empty or contain non-whitespace text`,
  );
  return text;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  assertSafe(
    isDeepStrictEqual(Object.keys(value).toSorted(), [...keys].toSorted()),
    `${label} shape drifted`,
  );
}

function assertOracleBodyBlock(value: unknown, ordinal: number): void {
  const block = oracleRecord(value, `FANBOX reviewed body block ${ordinal}`);
  assertExactKeys(
    block,
    ["ordinal", "type", "value"],
    `FANBOX reviewed body block ${ordinal}`,
  );
  assertSafe(
    block.ordinal === ordinal,
    "FANBOX reviewed body ordinals must be contiguous",
  );
  const type = oracleString(
    block.type,
    `FANBOX reviewed body block ${ordinal} type`,
  );
  assertSafe(
    ["header", "p", "image", "file", "embed", "url_embed"].includes(type),
    `FANBOX reviewed body block ${ordinal} type was invalid`,
  );
  const projected = oracleRecord(
    block.value,
    `FANBOX reviewed body block ${ordinal} value`,
  );
  assertSafe(
    projected.type === type,
    `FANBOX reviewed body block ${ordinal} value type drifted`,
  );
  if (type === "header" || type === "p") {
    assertExactKeys(
      projected,
      ["type", "text"],
      `FANBOX reviewed body block ${ordinal} value`,
    );
    const label = `FANBOX reviewed body block ${ordinal} text`;
    if (type === "p") oracleParagraphText(projected.text, label);
    else oracleString(projected.text, label);
  } else if (type === "file" || type === "image") {
    const reference = type === "file" ? "fileId" : "imageId";
    assertExactKeys(
      projected,
      ["type", reference],
      `FANBOX reviewed body block ${ordinal} value`,
    );
    oracleString(
      projected[reference],
      `FANBOX reviewed body block ${ordinal} reference`,
    );
  } else if (type === "embed") {
    assertExactKeys(
      projected,
      ["type", "embed"],
      `FANBOX reviewed body block ${ordinal} value`,
    );
    const embed = oracleRecord(
      projected.embed,
      `FANBOX reviewed body block ${ordinal} embed`,
    );
    assertExactKeys(
      embed,
      ["id", "serviceProvider", "contentId"],
      `FANBOX reviewed body block ${ordinal} embed`,
    );
    oracleString(
      embed.id,
      `FANBOX reviewed body block ${ordinal} embed identity`,
    );
    oracleString(
      embed.serviceProvider,
      `FANBOX reviewed body block ${ordinal} embed provider`,
    );
    oracleString(
      embed.contentId,
      `FANBOX reviewed body block ${ordinal} embed content identity`,
    );
  } else {
    assertExactKeys(
      projected,
      ["type", "urlEmbed"],
      `FANBOX reviewed body block ${ordinal} value`,
    );
    const embed = oracleRecord(
      projected.urlEmbed,
      `FANBOX reviewed body block ${ordinal} URL embed`,
    );
    const embedType = oracleString(
      embed.type,
      `FANBOX reviewed body block ${ordinal} URL embed type`,
    );
    if (embedType === "default") {
      assertExactKeys(
        embed,
        ["id", "type", "url"],
        `FANBOX reviewed body block ${ordinal} URL embed`,
      );
      oracleString(
        embed.url,
        `FANBOX reviewed body block ${ordinal} URL embed address`,
      );
    } else if (embedType === "html" || embedType === "html.card") {
      assertExactKeys(
        embed,
        ["id", "type", "html"],
        `FANBOX reviewed body block ${ordinal} URL embed`,
      );
      oracleString(
        embed.html,
        `FANBOX reviewed body block ${ordinal} URL embed HTML`,
      );
    } else {
      assertSafe(
        embedType === "fanbox.post",
        `FANBOX reviewed body block ${ordinal} URL embed type was invalid`,
      );
      assertExactKeys(
        embed,
        ["id", "type", "postInfo"],
        `FANBOX reviewed body block ${ordinal} URL embed`,
      );
      const postInfo = oracleRecord(
        embed.postInfo,
        `FANBOX reviewed body block ${ordinal} URL embed post`,
      );
      assertExactKeys(
        postInfo,
        ["id"],
        `FANBOX reviewed body block ${ordinal} URL embed post`,
      );
      oracleString(
        postInfo.id,
        `FANBOX reviewed body block ${ordinal} URL embed post identity`,
      );
    }
    oracleString(
      embed.id,
      `FANBOX reviewed body block ${ordinal} URL embed identity`,
    );
  }
}

function assertReviewedOracle(value: unknown): readonly FanboxPostOracle[] {
  const posts = oracleArray(value, "reviewed creator-post selection");
  assertSafe(posts.length === 5, "reviewed creator-post selection drifted");
  const identities = new Set<string>();
  const logicalRoots = new Set<string>();
  for (const [postIndex, rawPost] of posts.entries()) {
    const post = oracleRecord(rawPost, `FANBOX reviewed post ${postIndex}`);
    assertExactKeys(
      post,
      [
        "logicalRoot",
        "directoryDate",
        "sourceNativeAddress",
        "title",
        "publishedDatetime",
        "postType",
        "creatorId",
        "entitlement",
        "cover",
        "body",
        "attachments",
      ],
      `FANBOX reviewed post ${postIndex}`,
    );
    const logicalRoot = oracleString(
      post.logicalRoot,
      `FANBOX reviewed post ${postIndex} logical root`,
    );
    assertSafe(
      !logicalRoots.has(logicalRoot),
      "FANBOX reviewed logical roots must be unique",
    );
    logicalRoots.add(logicalRoot);
    const directoryDate = oracleString(
      post.directoryDate,
      `FANBOX reviewed post ${postIndex} directory date`,
    );
    assertSafe(
      /^\d{4}-\d{2}-\d{2}$/u.test(directoryDate),
      `FANBOX reviewed post ${postIndex} directory date is invalid`,
    );
    assertSafe(
      new Date(`${directoryDate}T00:00:00Z`).toISOString().slice(0, 10) ===
        directoryDate,
      `FANBOX reviewed post ${postIndex} directory date is invalid`,
    );
    const sourceNativeAddress = oracleString(
      post.sourceNativeAddress,
      `FANBOX reviewed post ${postIndex} native address`,
    );
    assertSafe(
      /^(?:0|[1-9]\d*)$/u.test(sourceNativeAddress),
      `FANBOX reviewed post ${postIndex} native address is invalid`,
    );
    assertSafe(
      Number.isSafeInteger(Number(sourceNativeAddress)) &&
        Number(sourceNativeAddress) > 0,
      `FANBOX reviewed post ${postIndex} native address must be a positive safe integer`,
    );
    const creatorId = oracleString(
      post.creatorId,
      `FANBOX reviewed post ${postIndex} creator`,
    );
    assertSafe(
      /^[0-9A-Za-z_-]+$/u.test(creatorId),
      `FANBOX reviewed post ${postIndex} creator is invalid`,
    );
    const identity = `${creatorId}\u0000${sourceNativeAddress}`;
    assertSafe(
      !identities.has(identity),
      "FANBOX reviewed post identities must be unique",
    );
    identities.add(identity);
    oracleString(post.title, `FANBOX reviewed post ${postIndex} title`);
    const publishedDatetime = oracleString(
      post.publishedDatetime,
      `FANBOX reviewed post ${postIndex} publication datetime`,
    );
    assertSafe(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        publishedDatetime,
      ),
      `FANBOX reviewed post ${postIndex} publication datetime is invalid`,
    );
    assertSafe(
      !Number.isNaN(Date.parse(publishedDatetime)),
      `FANBOX reviewed post ${postIndex} publication datetime is invalid`,
    );
    assertSafe(
      publishedDatetime.slice(0, 10) === directoryDate,
      `FANBOX reviewed post ${postIndex} publication date drifted`,
    );
    assertSafe(
      ["text", "file", "image", "video", "article"].includes(
        post.postType as string,
      ),
      `FANBOX reviewed post ${postIndex} form is invalid`,
    );
    assertSafe(
      ["available", "restricted"].includes(post.entitlement as string),
      `FANBOX reviewed post ${postIndex} entitlement is invalid`,
    );
    assertSafe(
      ["present", "absent"].includes(post.cover as string),
      `FANBOX reviewed post ${postIndex} cover status is invalid`,
    );
    const body = oracleRecord(
      post.body,
      `FANBOX reviewed post ${postIndex} body`,
    );
    const status = oracleString(
      body.status,
      `FANBOX reviewed post ${postIndex} body status`,
    );
    if (status === "available") {
      assertExactKeys(
        body,
        ["status", "text", "blocks"],
        `FANBOX reviewed post ${postIndex} body`,
      );
      oracleString(body.text, `FANBOX reviewed post ${postIndex} body text`);
    } else {
      assertSafe(
        status === "restricted",
        `FANBOX reviewed post ${postIndex} body status was invalid`,
      );
      assertExactKeys(
        body,
        ["status", "blocks"],
        `FANBOX reviewed post ${postIndex} body`,
      );
    }
    const blocks = oracleArray(
      body.blocks,
      `FANBOX reviewed post ${postIndex} body blocks`,
    );
    if (status === "restricted")
      assertSafe(
        blocks.length === 0,
        `FANBOX reviewed post ${postIndex} restricted body blocks must be empty`,
      );
    for (const [ordinal, block] of blocks.entries())
      assertOracleBodyBlock(block, ordinal);
    const attachments = oracleArray(
      post.attachments,
      `FANBOX reviewed post ${postIndex} attachments`,
    );
    for (const [ordinal, rawAttachment] of attachments.entries()) {
      const attachment = oracleRecord(
        rawAttachment,
        `FANBOX reviewed post ${postIndex} attachment ${ordinal}`,
      );
      assertExactKeys(
        attachment,
        [
          "ordinal",
          "kind",
          ...(Object.hasOwn(attachment, "name") ? ["name"] : []),
          ...(Object.hasOwn(attachment, "byteLength") ? ["byteLength"] : []),
        ],
        `FANBOX reviewed post ${postIndex} attachment ${ordinal}`,
      );
      assertSafe(
        attachment.ordinal === ordinal,
        "FANBOX reviewed attachment ordinals must be contiguous",
      );
      if (Object.hasOwn(attachment, "name"))
        oracleString(
          attachment.name,
          `FANBOX reviewed post ${postIndex} attachment ${ordinal} name`,
        );
      assertSafe(
        attachment.kind === "file" || attachment.kind === "image",
        `FANBOX reviewed post ${postIndex} attachment ${ordinal} kind is invalid`,
      );
      if (Object.hasOwn(attachment, "byteLength")) {
        const byteLength = oracleString(
          attachment.byteLength,
          `FANBOX reviewed post ${postIndex} attachment ${ordinal} byte length`,
        );
        assertSafe(
          /^(?:0|[1-9]\d*)$/u.test(byteLength),
          `FANBOX reviewed post ${postIndex} attachment ${ordinal} byte length is invalid`,
        );
        assertSafe(
          Number.isSafeInteger(Number(byteLength)),
          `FANBOX reviewed post ${postIndex} attachment ${ordinal} byte length is invalid`,
        );
      }
    }
    if (post.entitlement === "restricted") {
      assertSafe(
        status === "restricted",
        `FANBOX reviewed post ${postIndex} body status is invalid`,
      );
      assertSafe(
        attachments.length === 0,
        `FANBOX reviewed post ${postIndex} restricted attachments must be empty`,
      );
    } else
      assertSafe(
        status === "available",
        `FANBOX reviewed post ${postIndex} body status is invalid`,
      );
  }
  return posts as readonly FanboxPostOracle[];
}

function assertExactLogicalRoots(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assertSafe(
    new Set(actual).size === actual.length,
    `${label} contains duplicate roots`,
  );
  assertSensitiveEqual(
    [...actual].toSorted(),
    [...expected].toSorted(),
    `${label} root set drifted`,
  );
}

export function fanboxJourneyCommands(
  context: CliJourneyContext,
  posts: readonly FanboxPostOracle[],
  roots: readonly Pick<FixedCorpusRoot, "directory">[],
): readonly CliJourneyCommand[] {
  const data = context.productDataDirectory;
  const productEnv = { DIGITAL_PRODUCT_DATA: data };
  const expected = expectedFanboxCommands(posts);
  const acceptedAssetIdForRefresh = (
    results: readonly CliJourneyResult[],
    postIndex: number,
  ): string => {
    const resultIndex = 1 + posts.length + postIndex;
    const result = results[resultIndex];
    try {
      const initial = inspection(result);
      const assetId = initial.accepted?.entity.id;
      if (
        initial.execution.outcome === "accepted" &&
        typeof assetId === "string" &&
        assetId.trim().length > 0
      )
        return assetId;
    } catch {}
    if (
      result !== undefined &&
      result.commandName === expected[resultIndex]?.name &&
      result.exitCode === 0
    ) {
      currentState(context).attributedInitialOutcome ??= {
        resultIndex,
        resultCount: results.length,
        result,
      };
    }
    throw new Error(
      `FANBOX metadata refresh requires accepted initial result for post ${postIndex + 1}`,
    );
  };
  const scan = (index: number, name: string): CliJourneyCommand => ({
    name,
    args: (results) => [
      "scan",
      observedRootId(results[index + 1]),
      "--scope",
      ".",
      "--json",
    ],
    env: productEnv,
    haltOnFailure: true,
  });
  return [
    {
      name: expected[0]!.name,
      args: [
        "fanbox-connection-import",
        "customudon",
        path.resolve(context.packageRoot, "../..", "docs/fanbox.json"),
      ],
      env: productEnv,
      haltOnFailure: true,
    },
    ...roots.map((root, index) => ({
      name: expected[index + 1]!.name,
      args: [
        "library-create",
        `FANBOX ${posts[index]!.sourceNativeAddress}`,
        "--directory",
        root.directory,
        "--json",
      ],
      env: productEnv,
      haltOnFailure: true,
    })),
    ...posts.map((_post, index) =>
      scan(index, expected[index + 1 + posts.length]!.name),
    ),
    ...posts.map((_post, index) =>
      scan(index, expected[index + 1 + posts.length * 2]!.name),
    ),
    ...posts.map((post, index) => ({
      name: expected[index + 1 + posts.length * 3]!.name,
      args: (results: readonly CliJourneyResult[]) => [
        "refresh-metadata",
        acceptedAssetIdForRefresh(results, index),
        "--json",
      ],
      env: productEnv,
      haltOnFailure: true,
    })),
  ];
}

const journey: CliJourney = {
  name: "fanbox-five-live",
  source: { mode: "real" },
  modes: ["source", "distribution"],
  async setup(context) {
    const corpus = corpusRoot(context);
    const rawOracle = parseSensitiveJson(
      await readFile(
        path.join(corpus, "references/reviewed-oracle.json"),
        "utf8",
      ),
      "FANBOX reviewed oracle JSON is invalid",
    );
    const oracle = oracleRecord(rawOracle, "FANBOX oracle");
    const reviews = oracleRecord(oracle.reviews, "FANBOX oracle reviews");
    const fanboxReview = oracleRecord(reviews.fanbox, "FANBOX oracle review");
    assertSafe(
      fanboxReview.status === "reviewed-current-official-source",
      "FANBOX oracle requires current official source review",
    );
    const posts = assertReviewedOracle(oracle.creatorPosts);
    const allRoots = await fixedCorpusRoots(context);
    let ownershipGroups: ReturnType<
      typeof fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle
    >;
    try {
      ownershipGroups =
        fixedCorpusDedicatedIntegrationOwnershipGroupsFromOracle(
          rawOracle,
          allRoots,
        );
    } catch {
      throw new Error("FANBOX fixed-corpus ownership routing is invalid");
    }
    const owner = ownershipGroups.find(
      (group) =>
        group.ownerTicket ===
        "v1-live-acceptance/issues/02-fanbox-five-live-gate.md",
    );
    assertSafe(
      owner !== undefined,
      "FANBOX fixed-corpus ownership group is missing",
    );
    assertExactLogicalRoots(
      posts.map((post) => post.logicalRoot),
      owner.roots.map((root) => root.logicalRoot),
      "FANBOX reviewed oracle",
    );
    const roots = posts.map((post) => ({
      logicalRoot: post.logicalRoot,
      directory: path.join(corpus, "assets", ...post.logicalRoot.split("/")),
    }));
    const signatures = new Map<string, readonly string[]>();
    for (const root of roots) {
      assertSafe(
        (await lstat(root.directory)).isDirectory(),
        "FANBOX fixed-corpus root must be a directory",
      );
      signatures.set(root.logicalRoot, await entrySignature(root.directory));
    }
    const deepIntegrity = process.env.DIGITAL_DEEP_CORPUS_INTEGRITY === "1";
    const before = await captureFixedCorpusSnapshots(roots, deepIntegrity);
    assertExactLogicalRoots(
      [...before.keys()],
      roots.map((root) => root.logicalRoot),
      "FANBOX captured snapshot map",
    );
    const deepBefore = deepIntegrity
      ? fixedCorpusContentDigestsFromSnapshots(roots, before)
      : undefined;
    if (deepBefore !== undefined) {
      assertExactLogicalRoots(
        [...deepBefore.keys()],
        roots.map((root) => root.logicalRoot),
        "FANBOX deep content digest map",
      );
      await assertFixedCorpusContentBaselineSubset(context, deepBefore);
    }
    stateByContext.set(stateKey(context), {
      posts,
      roots,
      signatures,
      assertionsFailed: false,
      ...(deepBefore === undefined ? {} : { deepBefore }),
    });
  },
  commands(context) {
    const state = currentState(context);
    return fanboxJourneyCommands(context, state.posts, state.roots);
  },
  async assertions({ context, results: allResults }) {
    const state = currentState(context);
    try {
      const importedConnection = allResults[0];
      if (importedConnection === undefined)
        throw new Error("FANBOX live journey did not run connection import");
      assertSafe(
        importedConnection.exitCode === 0,
        "FANBOX connection import command failed",
      );
      for (const registeredRoot of allResults.slice(
        1,
        state.roots.length + 1,
      )) {
        assertSafe(
          registeredRoot.exitCode === 0,
          "FANBOX observed-root registration command failed",
        );
        observedRootId(registeredRoot);
      }
      const results = allResults.slice(state.roots.length + 1);
      assertSafe(
        results.length === state.posts.length * 3,
        "FANBOX journey command result count is invalid",
      );
      for (const result of allResults) {
        assertSafe(result.exitCode === 0, "FANBOX journey command failed");
        assertSafe(
          !/FANBOXSESSID|cf_clearance|docs[\\/]fanbox\.json|cookie/iu.test(
            `${result.stdout}\n${result.stderr}`,
          ),
          "private FANBOX configuration leaked through journey output",
        );
      }
      const initial = results.slice(0, state.posts.length).map(inspection);
      const reopened = results
        .slice(state.posts.length, state.posts.length * 2)
        .map(inspection);
      const refreshed = results.slice(state.posts.length * 2).map(inspection);
      for (const [index, post] of state.posts.entries()) {
        assertFanboxAcceptedPost(initial[index]!, post);
        assertFanboxReopenedPost(initial[index]!, reopened[index]!, post);
        assertFanboxRefreshedPost(initial[index]!, refreshed[index]!, post);
        const observedCount = initial[index]!.accepted?.locations.filter(
          (location) => location.kind === "observed",
        ).length;
        assertSafe(
          observedCount ===
            state.signatures
              .get(post.logicalRoot)
              ?.filter((entry) => entry.includes(":f:")).length,
          `FANBOX post ${index + 1} observed artifact count is invalid`,
        );
      }
    } catch (error) {
      state.assertionsFailed = true;
      throw error;
    }
  },
  async teardown({ context, results }) {
    const key = stateKey(context);
    const state = stateByContext.get(key);
    if (state === undefined) return;
    const teardownErrors: unknown[] = [];
    let initialEvidence: FanboxLiveFailureEvidence | undefined;
    let persistedEvidence: FanboxLiveFailureEvidence | undefined;
    let evidenceIdentity: EvidenceIdentity | undefined;
    const evidencePath = process.env[fanboxFailureEvidenceEnvironment];
    try {
      try {
        initialEvidence = failureEvidence(context, state, results);
      } catch (error) {
        teardownErrors.push(error);
      }
      if (initialEvidence !== undefined) {
        if (evidencePath === undefined) {
          teardownErrors.push(new Error("必须提供 FANBOX 失败证据路径"));
        } else {
          try {
            await assertEvidencePathAvailable(context, evidencePath);
            evidenceIdentity = await persistInitialEvidence(
              evidencePath,
              initialEvidence,
            );
            persistedEvidence = initialEvidence;
          } catch (error) {
            teardownErrors.push(error);
          }
        }
      }
      try {
        await assertFanboxMediaUnchanged(context, state);
      } catch (error) {
        teardownErrors.push(error);
      }
    } finally {
      stateByContext.delete(key);
      if (
        persistedEvidence !== undefined &&
        evidenceIdentity !== undefined &&
        evidencePath !== undefined
      ) {
        const finished: FanboxLiveFailureEvidence = {
          ...persistedEvidence,
          evidenceState: "teardown-finished",
          teardown: teardownErrors.length === 0 ? "passed" : "failed",
          stateReleased: "yes",
        };
        try {
          await appendFinishedEvidence(
            evidencePath,
            persistedEvidence,
            finished,
            evidenceIdentity,
          );
        } catch (error) {
          teardownErrors.push(error);
        }
      }
    }
    if (teardownErrors.length === 1) throw teardownErrors[0];
    if (teardownErrors.length > 1) throw new AggregateError(teardownErrors);
  },
};

export default journey;
