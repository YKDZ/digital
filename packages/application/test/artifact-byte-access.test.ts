import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
  ApplicationArtifactByteAccess,
  ArtifactByteAccessError,
  ExecutionHost,
  type ArtifactByteCleanupReporter,
  type ArtifactByteSource,
  type ArtifactContentProofMetadata,
  type ArtifactLocationByteSources,
  type ArtifactRevisionAccessFacts,
  type PlaybackFormatInspector,
} from "../src/index.ts";

const digest = createHash("sha256").update("good").digest("hex");
const proof: ArtifactContentProofMetadata = {
  blobDigest: digest,
  scheme: "artifact-frame-manifest/1",
  byteLength: 4,
  frameSize: 1_048_576,
  frameCount: 1,
  manifestDigest: "a".repeat(64),
};

function source(bytes: string): ArtifactByteSource {
  const value = new TextEncoder().encode(bytes);
  return {
    byteLength: value.byteLength,
    async readChunk(offset, maximumBytes) {
      const chunk = value.slice(offset, offset + maximumBytes);
      return { bytes: chunk, done: offset + chunk.byteLength >= value.length };
    },
    async close() {},
  };
}

function describeAccess(input: {
  readonly host: ExecutionHost;
  readonly locations: ArtifactRevisionAccessFacts["locations"];
  readonly sources: ArtifactLocationByteSources;
  readonly cleanupReporter?: ArtifactByteCleanupReporter;
  readonly readProof?: () =>
    | ArtifactContentProofMetadata
    | undefined
    | Promise<ArtifactContentProofMetadata | undefined>;
}) {
  return new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-describe",
            artifactId: "artifact-describe",
            blobDigest: digest,
          },
          blob: { digest, byteLength: 4, mediaType: "text/plain" },
          locations: input.locations,
        };
      },
      async readArtifactContentProof() {
        return input.readProof === undefined ? proof : await input.readProof();
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        return "stale" as const;
      },
    },
    sources: input.sources,
    proofStore: {
      async inspect() {},
      async build() {
        throw new Error("not reached");
      },
      async open() {
        throw new Error("not reached");
      },
    },
    executionHost: input.host,
    ...(input.cleanupReporter === undefined
      ? {}
      : { cleanupReporter: input.cleanupReporter }),
  });
}

function mp3Bytes(): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  return bytes;
}

function inspectedDescribeAccess(input: {
  readonly host: ExecutionHost;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly inspector: PlaybackFormatInspector;
  readonly observed?: boolean;
  readonly onOpen?: (
    count: number,
    operation: Parameters<ArtifactLocationByteSources["open"]>[0],
  ) => "changed" | void;
  readonly onClose?: () => void;
  readonly onBindingRelease?: () => void;
}) {
  const blobDigest = createHash("sha256").update(input.bytes).digest("hex");
  let opens = 0;
  return new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-inspected-describe",
            artifactId: "artifact-inspected-describe",
            blobDigest,
          },
          blob: {
            digest: blobDigest,
            byteLength: input.bytes.byteLength,
            mediaType: input.mediaType,
          },
          locations: [
            input.observed
              ? {
                  kind: "observed" as const,
                  locationId: "observed-inspected-describe",
                  address: "private-inspected-describe",
                  confirmedObservation: {
                    snapshotId: "snapshot-inspected-describe",
                    observedAt: "2026-08-30T00:00:00.000Z",
                    size: input.bytes.byteLength,
                    modifiedAt: "2026-08-30T00:00:00.000Z",
                  },
                  confirmationBaseline: "baseline-inspected-describe",
                }
              : {
                  kind: "managed" as const,
                  locationId: "managed-inspected-describe",
                  address: "private-inspected-describe",
                },
          ],
        };
      },
      async readArtifactContentProof() {
        return {
          blobDigest,
          scheme: "artifact-frame-manifest/1" as const,
          byteLength: input.bytes.byteLength,
          frameSize: 1_048_576 as const,
          frameCount: Math.ceil(input.bytes.byteLength / 1_048_576),
          manifestDigest: "b".repeat(64),
        };
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        return "stale" as const;
      },
    },
    sources: {
      async open(operation) {
        opens += 1;
        const changed = input.onOpen?.(opens, operation) === "changed";
        const value = changed ? input.bytes.slice(0, -1) : input.bytes;
        const opened = {
          source: {
            byteLength: value.byteLength,
            async readChunk(offset: number, maximumBytes: number) {
              const bytes = value.slice(offset, offset + maximumBytes);
              return {
                bytes,
                done: offset + bytes.byteLength >= value.byteLength,
              };
            },
            async close() {
              input.onClose?.();
            },
          },
          suggestedFilename: "track.bin",
        };
        if (!input.observed) return opened;
        const binding = operation.operation.bindObservedRoot({
          registrationId: "root-inspected-describe",
          registrationVersion: 1,
        });
        return {
          ...opened,
          observedBinding: {
            release() {
              binding.release();
              input.onBindingRelease?.();
            },
          },
          observedAuthority: {
            registrationId: "root-inspected-describe",
            registrationVersion: 1,
          },
        };
      },
    },
    proofStore: {
      async inspect() {},
      async build() {
        throw new Error("not reached");
      },
      async open() {
        return {
          async expectedFrameDigest(ordinal) {
            const startOffset = ordinal * 1_048_576;
            const frame = input.bytes.slice(
              startOffset,
              startOffset + 1_048_576,
            );
            const coordinate = Buffer.alloc(20);
            coordinate.writeBigUInt64BE(BigInt(ordinal), 0);
            coordinate.writeBigUInt64BE(BigInt(startOffset), 8);
            coordinate.writeUInt32BE(frame.byteLength, 16);
            return createHash("sha256")
              .update(Buffer.from("digital-artifact-frame-v1\0", "utf8"))
              .update(coordinate)
              .update(frame)
              .digest();
          },
          async close() {},
        };
      },
    },
    executionHost: input.host,
    playbackInspector: input.inspector,
  });
}

const inspectedMp3Format = {
  mediaType: "audio/mpeg",
  container: "mp3",
  codecs: ["mp3"],
} as const;

const inspectedFormatCapability = {
  capability: {
    capabilityId: "test.inspected-format",
    capabilityVersion: "1",
    contractVersion: "playback-format-inspector/1",
  },
};

it("derives a generic Blob media type from bounded bytes and reauthorizes the exact descriptor", async () => {
  const host = new ExecutionHost();
  const bytes = mp3Bytes();
  let opens = 0;
  let closes = 0;
  const access = inspectedDescribeAccess({
    host,
    bytes,
    mediaType: "application/octet-stream",
    inspector: {
      ...inspectedFormatCapability,
      async inspect(input) {
        expect(
          await input.bytes.read({ startInclusive: 0, endInclusive: 3 }),
        ).toEqual(bytes.slice(0, 4));
        return inspectedMp3Format;
      },
    },
    onOpen() {
      opens += 1;
    },
    onClose() {
      closes += 1;
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-inspected-describe" }),
  ).resolves.toEqual({
    revisionId: "revision-inspected-describe",
    blobDigest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    mediaType: "audio/mpeg",
    suggestedFilename: "track.bin",
  });
  expect(opens).toBe(3);
  expect(closes).toBe(3);
  await expect(host.close()).resolves.toBeUndefined();
});

it.each([
  {
    label: "unknown generic bytes",
    persisted: "application/octet-stream",
    inspected: undefined,
    expected: "application/octet-stream",
    inspectionCalls: 1,
    opens: 2,
  },
  {
    label: "trusted non-generic media type conflicting with inspection",
    persisted: "audio/flac",
    inspected: inspectedMp3Format,
    expected: "audio/flac",
    inspectionCalls: 0,
    opens: 1,
  },
] as const)("preserves $label", async (example) => {
  const host = new ExecutionHost();
  let inspectionCalls = 0;
  let opens = 0;
  const access = inspectedDescribeAccess({
    host,
    bytes: mp3Bytes(),
    mediaType: example.persisted,
    inspector: {
      ...inspectedFormatCapability,
      async inspect() {
        inspectionCalls += 1;
        return example.inspected;
      },
    },
    onOpen() {
      opens += 1;
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-inspected-describe" }),
  ).resolves.toMatchObject({ mediaType: example.expected });
  expect(inspectionCalls).toBe(example.inspectionCalls);
  expect(opens).toBe(example.opens);
  await expect(host.close()).resolves.toBeUndefined();
});

it.each([
  "inspection-failure",
  "content-change",
  "root-revoke",
  "shutdown",
] as const)(
  "does not publish an inspected descriptor after %s and closes every short resource",
  async (failure) => {
    const host = new ExecutionHost();
    let closes = 0;
    let bindingsReleased = 0;
    let shutdown: Promise<void> | undefined;
    const access = inspectedDescribeAccess({
      host,
      bytes: mp3Bytes(),
      mediaType: "application/octet-stream",
      observed: failure === "root-revoke",
      inspector: {
        ...inspectedFormatCapability,
        async inspect(input) {
          await input.bytes.read({ startInclusive: 0, endInclusive: 3 });
          if (failure === "inspection-failure")
            throw new Error("inspector failed");
          return inspectedMp3Format;
        },
      },
      onOpen(count) {
        if (failure === "content-change" && count === 3) return "changed";
      },
      onClose() {
        closes += 1;
        if (closes !== 3) return;
        if (failure === "root-revoke")
          host.invalidateObservedRoot({
            registrationId: "root-inspected-describe",
          });
        if (failure === "shutdown") shutdown = host.close();
      },
      onBindingRelease() {
        bindingsReleased += 1;
      },
    });

    await expect(
      access.describe({ artifactRevisionId: "revision-inspected-describe" }),
    ).rejects.toMatchObject<ArtifactByteAccessError>({
      code:
        failure === "root-revoke"
          ? "artifact-location-revoked"
          : failure === "shutdown"
            ? "application-shutting-down"
            : failure === "content-change"
              ? "artifact-bytes-unavailable"
              : "artifact-integrity-failed",
    });
    expect(closes).toBe(failure === "inspection-failure" ? 2 : 3);
    if (failure === "root-revoke") expect(bindingsReleased).toBe(3);
    await expect(shutdown ?? host.close()).resolves.toBeUndefined();
  },
);

it("keeps inspected descriptors inside the shared 256KiB logical probe budget", async () => {
  const host = new ExecutionHost();
  let closes = 0;
  const access = inspectedDescribeAccess({
    host,
    bytes: new Uint8Array(262_144),
    mediaType: "application/octet-stream",
    inspector: {
      ...inspectedFormatCapability,
      async inspect(input) {
        for (let read = 0; read < 5; read += 1)
          await input.bytes.read({
            startInclusive: 0,
            endInclusive: 65_535,
          });
        return inspectedMp3Format;
      },
    },
    onClose() {
      closes += 1;
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-inspected-describe" }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-integrity-failed",
  });
  expect(closes).toBe(2);
  await expect(host.close()).resolves.toBeUndefined();
});

function confirmationAccess(input: {
  readonly host: ExecutionHost;
  readonly closeSource: () => void | Promise<void>;
  readonly onBindingRelease?: () => void;
  readonly onCommitted?: () => void;
  readonly cleanupReporter?: ArtifactByteCleanupReporter;
}) {
  return new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return undefined;
      },
      async readArtifactContentProof() {
        return undefined;
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return "selection-confirm";
      },
      async readObservedFileConfirmationFacts() {
        return {
          selectionId: "selection-confirm",
          artifactId: "artifact-confirm",
          location: {
            locationId: "location-confirm",
            address: "private-confirm",
          },
          observation: {
            snapshotId: "snapshot-confirm",
            observedAt: "2026-08-29T00:00:00.000Z",
            size: 4,
            modifiedAt: "2026-08-29T00:00:00.000Z",
          },
          conditionalBaseline: "baseline-confirm",
        };
      },
      async submitConfirmedObservedRevision() {
        input.onCommitted?.();
        return "committed" as const;
      },
    },
    sources: {
      async open(openInput) {
        const binding = openInput.operation.bindObservedRoot({
          registrationId: "root-confirm",
          registrationVersion: 1,
        });
        return {
          source: {
            ...source("good"),
            close: input.closeSource,
          },
          suggestedFilename: "file.txt",
          observedBinding: {
            release() {
              binding.release();
              input.onBindingRelease?.();
            },
          },
          observedAuthority: {
            registrationId: "root-confirm",
            registrationVersion: 1,
          },
        };
      },
    },
    proofStore: {
      async inspect() {},
      async build() {
        return proof;
      },
      async open() {
        throw new Error("not reached");
      },
    },
    executionHost: input.host,
    ...(input.cleanupReporter === undefined
      ? {}
      : { cleanupReporter: input.cleanupReporter }),
  });
}

it("does not publish a managed descriptor after source close starts Host shutdown", async () => {
  const host = new ExecutionHost();
  let shutdown: Promise<void> | undefined;
  const access = describeAccess({
    host,
    locations: [
      {
        kind: "managed",
        locationId: "managed-describe-shutdown",
        address: "private-managed-describe-shutdown",
      },
    ],
    sources: {
      async open() {
        return {
          source: {
            ...source("good"),
            async close() {
              shutdown = host.close();
            },
          },
          suggestedFilename: "file.txt",
        };
      },
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-describe" }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "application-shutting-down",
  });
  await expect(shutdown).resolves.toBeUndefined();
});

it("keeps observed-root cancellation primary when candidate close and cleanup reporting fail", async () => {
  const host = new ExecutionHost();
  let sourceCloseAttempts = 0;
  let cleanupPrimary: unknown;
  const access = describeAccess({
    host,
    locations: [
      {
        kind: "observed",
        locationId: "observed-describe-close",
        address: "private-observed-describe-close",
        confirmedObservation: {
          snapshotId: "snapshot-describe-close",
          observedAt: "2026-08-29T00:00:00.000Z",
          size: 4,
          modifiedAt: "2026-08-29T00:00:00.000Z",
        },
        confirmationBaseline: "baseline-describe-close",
      },
    ],
    sources: {
      async open(input) {
        const observedBinding = input.operation.bindObservedRoot({
          registrationId: "root-describe-close",
          registrationVersion: 1,
        });
        queueMicrotask(() =>
          queueMicrotask(() =>
            host.invalidateObservedRoot({
              registrationId: "root-describe-close",
            }),
          ),
        );
        return {
          source: {
            ...source("good"),
            async close() {
              sourceCloseAttempts += 1;
              throw new Error("source close failed");
            },
          },
          suggestedFilename: "file.txt",
          observedBinding,
          observedAuthority: {
            registrationId: "root-describe-close",
            registrationVersion: 1,
          },
        };
      },
    },
    cleanupReporter: {
      async reportCleanupFailure(input) {
        cleanupPrimary = input.primaryError;
        throw new Error("cleanup reporter failed");
      },
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-describe" }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-location-revoked",
  });
  expect(sourceCloseAttempts).toBe(1);
  expect(cleanupPrimary).toMatchObject<ArtifactByteAccessError>({
    code: "artifact-location-revoked",
  });
  await expect(host.close()).resolves.toBeUndefined();
});

it("preserves observed-root cancellation before a candidate can be returned", async () => {
  const host = new ExecutionHost();
  let sourceClosed = 0;
  const access = describeAccess({
    host,
    locations: [
      {
        kind: "observed",
        locationId: "observed-describe-open",
        address: "private-observed-describe-open",
        confirmedObservation: {
          snapshotId: "snapshot-describe-open",
          observedAt: "2026-08-29T00:00:00.000Z",
          size: 4,
          modifiedAt: "2026-08-29T00:00:00.000Z",
        },
        confirmationBaseline: "baseline-describe-open",
      },
    ],
    sources: {
      async open(input) {
        const observedBinding = input.operation.bindObservedRoot({
          registrationId: "root-describe-open",
          registrationVersion: 1,
        });
        queueMicrotask(() =>
          host.invalidateObservedRoot({
            registrationId: "root-describe-open",
          }),
        );
        return {
          source: {
            ...source("good"),
            async close() {
              sourceClosed += 1;
            },
          },
          suggestedFilename: "file.txt",
          observedBinding,
          observedAuthority: {
            registrationId: "root-describe-open",
            registrationVersion: 1,
          },
        };
      },
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-describe" }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-location-revoked",
  });
  expect(sourceClosed).toBe(1);
  await expect(host.close()).resolves.toBeUndefined();
});

it("keeps an observed binding active through the final describe cancellation check", async () => {
  const host = new ExecutionHost();
  let bindingReleased = false;
  const access = describeAccess({
    host,
    locations: [
      {
        kind: "observed",
        locationId: "observed-describe-publication",
        address: "private-observed-describe-publication",
        confirmedObservation: {
          snapshotId: "snapshot-describe-publication",
          observedAt: "2026-08-29T00:00:00.000Z",
          size: 4,
          modifiedAt: "2026-08-29T00:00:00.000Z",
        },
        confirmationBaseline: "baseline-describe-publication",
      },
    ],
    sources: {
      async open(input) {
        const binding = input.operation.bindObservedRoot({
          registrationId: "root-describe-publication",
          registrationVersion: 1,
        });
        return {
          source: {
            ...source("good"),
            async close() {
              queueMicrotask(() =>
                queueMicrotask(() =>
                  queueMicrotask(() =>
                    host.invalidateObservedRoot({
                      registrationId: "root-describe-publication",
                    }),
                  ),
                ),
              );
            },
          },
          suggestedFilename: "file.txt",
          observedBinding: {
            release() {
              binding.release();
              bindingReleased = true;
            },
          },
          observedAuthority: {
            registrationId: "root-describe-publication",
            registrationVersion: 1,
          },
        };
      },
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-describe" }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-location-revoked",
  });
  expect(bindingReleased).toBe(true);
  await expect(host.close()).resolves.toBeUndefined();
});

it("preserves managed shutdown when an adapter closes its source and returns no candidate", async () => {
  const host = new ExecutionHost();
  let opens = 0;
  let shutdown: Promise<void> | undefined;
  const access = describeAccess({
    host,
    locations: [
      {
        kind: "managed",
        locationId: "managed-describe-shutdown-a",
        address: "private-managed-describe-shutdown-a",
      },
      {
        kind: "managed",
        locationId: "managed-describe-shutdown-b",
        address: "private-managed-describe-shutdown-b",
      },
    ],
    sources: {
      async open() {
        opens += 1;
        shutdown = host.close();
        await source("good").close();
        return undefined;
      },
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-describe" }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "application-shutting-down",
  });
  expect(opens).toBe(1);
  await expect(shutdown).resolves.toBeUndefined();
});

it("preserves shutdown when proof rebuild has no candidate to try", async () => {
  const host = new ExecutionHost();
  let shutdown: Promise<void> | undefined;
  const access = describeAccess({
    host,
    locations: [],
    sources: {
      async open() {
        throw new Error("not reached");
      },
    },
    readProof() {
      shutdown = host.close();
      return undefined;
    },
  });

  await expect(
    access.describe({ artifactRevisionId: "revision-describe" }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "application-shutting-down",
  });
  await expect(shutdown).resolves.toBeUndefined();
});

it("keeps confirmation binding active through its final result-publication check", async () => {
  const host = new ExecutionHost();
  let committed = false;
  let bindingReleased = false;
  const access = confirmationAccess({
    host,
    closeSource() {
      queueMicrotask(() =>
        queueMicrotask(() =>
          queueMicrotask(() =>
            host.invalidateObservedRoot({ registrationId: "root-confirm" }),
          ),
        ),
      );
    },
    onCommitted() {
      committed = true;
    },
    onBindingRelease() {
      bindingReleased = true;
    },
  });

  await expect(
    access.confirmObservedFileSelection("selection-confirm"),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-location-revoked",
  });
  expect(committed).toBe(true);
  expect(bindingReleased).toBe(true);
  await expect(host.close()).resolves.toBeUndefined();
});

it("keeps confirmation shutdown primary when source cleanup and reporting fail", async () => {
  const host = new ExecutionHost();
  let shutdown: Promise<void> | undefined;
  let cleanupPrimary: unknown;
  let bindingReleased = false;
  const access = confirmationAccess({
    host,
    closeSource() {
      shutdown = host.close();
      throw new Error("source close failed");
    },
    onBindingRelease() {
      bindingReleased = true;
    },
    cleanupReporter: {
      async reportCleanupFailure(input) {
        cleanupPrimary = input.primaryError;
        throw new Error("cleanup reporter failed");
      },
    },
  });

  await expect(
    access.confirmObservedFileSelection("selection-confirm"),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "application-shutting-down",
  });
  expect(cleanupPrimary).toMatchObject<ArtifactByteAccessError>({
    code: "application-shutting-down",
  });
  expect(bindingReleased).toBe(false);
  await expect(shutdown).resolves.toBeUndefined();
});

it("publishes a committed confirmation after closing and releasing its observed source", async () => {
  const host = new ExecutionHost();
  let sourceClosed = false;
  let bindingReleased = false;
  const access = confirmationAccess({
    host,
    closeSource() {
      sourceClosed = true;
    },
    onBindingRelease() {
      bindingReleased = true;
    },
  });

  const result = await access.confirmObservedFileSelection("selection-confirm");

  expect(result).toEqual({
    artifactRevisionId: `artifact-revision_${createHash("sha256")
      .update(`artifact-confirm\u0000${digest}`)
      .digest("hex")}`,
  });
  expect(sourceClosed).toBe(true);
  expect(bindingReleased).toBe(true);
  await host.close();
});

it("releases one observed-root candidate before proof rebuild and first-frame fallback bind another root", async () => {
  const opened: string[] = [];
  let adopted = false;
  let proofOpens = 0;
  const access = new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-1",
            artifactId: "artifact-1",
            blobDigest: digest,
          },
          blob: { digest, byteLength: 4, mediaType: "text/plain" },
          locations: [
            {
              kind: "observed" as const,
              locationId: "root-a",
              address: "private-observed-a",
              confirmedObservation: {
                snapshotId: "snapshot-a",
                observedAt: "2026-08-29T00:00:00.000Z",
                size: 4,
                modifiedAt: "2026-08-29T00:00:00.000Z",
              },
              confirmationBaseline: "confirmation-a",
            },
            {
              kind: "observed" as const,
              locationId: "root-b",
              address: "private-observed-b",
              confirmedObservation: {
                snapshotId: "snapshot-b",
                observedAt: "2026-08-29T00:00:00.000Z",
                size: 4,
                modifiedAt: "2026-08-29T00:00:00.000Z",
              },
              confirmationBaseline: "confirmation-b",
            },
          ],
        };
      },
      async readArtifactContentProof() {
        return adopted ? proof : undefined;
      },
      async adoptArtifactContentProof() {
        adopted = true;
        return "committed" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        return "stale" as const;
      },
    },
    sources: {
      async open(input) {
        opened.push(input.candidate.locationId);
        const observedBinding = input.operation.bindObservedRoot({
          registrationId: input.candidate.locationId,
          registrationVersion: 1,
        });
        return {
          source:
            input.candidate.locationId === "root-a"
              ? source("evil")
              : source("good"),
          suggestedFilename: "file.txt",
          observedBinding,
          observedAuthority: {
            registrationId: input.candidate.locationId,
            registrationVersion: 1,
          },
        };
      },
    },
    proofStore: {
      async inspect() {},
      async build(media) {
        const read = await media.readChunk(0, 16);
        const actual = createHash("sha256").update(read.bytes).digest("hex");
        if (actual !== digest) throw new Error("digest mismatch");
        return proof;
      },
      async open() {
        proofOpens += 1;
        return {
          async expectedFrameDigest() {
            const coordinate = Buffer.alloc(20);
            coordinate.writeBigUInt64BE(0n, 0);
            coordinate.writeBigUInt64BE(0n, 8);
            coordinate.writeUInt32BE(4, 16);
            return createHash("sha256")
              .update(Buffer.from("digital-artifact-frame-v1\0"))
              .update(coordinate)
              .update("good")
              .digest();
          },
          async close() {},
        };
      },
    },
    executionHost: new ExecutionHost(),
  });

  const descriptor = await access.describe({
    artifactRevisionId: "revision-1",
  });
  const lease = await access.open({
    selection: { artifactRevisionId: "revision-1" },
    expectedBlobDigest: digest,
    interval: { startInclusive: 0, endInclusive: 3 },
  });
  const read = await lease.read({
    maximumBytes: 4,
    cancellation: { cancelled: false, onCancel: () => () => undefined },
  });

  expect(descriptor.byteLength).toBe(4);
  expect(new TextDecoder().decode(read.bytes)).toBe("good");
  expect(proofOpens).toBe(1);
  expect(opened).toEqual(["root-a", "root-b", "root-a", "root-a", "root-b"]);
});

it("cancels confirmation proof I/O and drains its one operation reservation before shutdown completes", async () => {
  const host = new ExecutionHost();
  let sourceClosed = false;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const access = new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return undefined;
      },
      async readArtifactContentProof() {
        return undefined;
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return "selection";
      },
      async readObservedFileConfirmationFacts() {
        return {
          selectionId: "selection",
          artifactId: "artifact-1",
          location: { locationId: "location-1", address: "private" },
          observation: {
            snapshotId: "snapshot-1",
            observedAt: "2026-08-29T00:00:00.000Z",
            size: 4,
            modifiedAt: "2026-08-29T00:00:00.000Z",
          },
          conditionalBaseline: "baseline-1",
        };
      },
      async submitConfirmedObservedRevision() {
        return "committed" as const;
      },
    },
    sources: {
      async open(input) {
        input.operation.bindObservedRoot({
          registrationId: "root-1",
          registrationVersion: 1,
        });
        return {
          source: {
            ...source("good"),
            async close() {
              sourceClosed = true;
            },
          },
          suggestedFilename: "file.txt",
          observedAuthority: {
            registrationId: "root-1",
            registrationVersion: 1,
          },
        };
      },
    },
    proofStore: {
      async inspect() {},
      async open() {
        throw new Error("not reached");
      },
      async build(_source, cancellation) {
        announceStarted();
        await new Promise<never>((_resolve, reject) => {
          cancellation.onCancel(() => reject(new Error("cancelled")));
        });
      },
    },
    executionHost: host,
  });

  const confirmation = access.confirmObservedFileSelection("selection");
  await started;
  await host.close();

  await expect(confirmation).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "application-shutting-down",
  });
  expect(sourceClosed).toBe(true);
});

it("keeps first-frame integrity as primary while reporting every source and manifest cleanup failure", async () => {
  const host = new ExecutionHost();
  const cleanup: string[] = [];
  const access = new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-cleanup",
            artifactId: "artifact-cleanup",
            blobDigest: digest,
          },
          blob: { digest, byteLength: 4, mediaType: "text/plain" },
          locations: [
            {
              kind: "managed" as const,
              locationId: "managed-cleanup",
              address: "private-managed",
            },
          ],
        };
      },
      async readArtifactContentProof() {
        return proof;
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        return "stale" as const;
      },
    },
    sources: {
      async open() {
        return {
          source: {
            ...source("evil"),
            async close() {
              throw new Error("source cleanup failed");
            },
          },
          suggestedFilename: "file.txt",
        };
      },
    },
    proofStore: {
      async inspect() {},
      async build() {
        throw new Error("not reached");
      },
      async open() {
        return {
          async expectedFrameDigest() {
            const coordinate = Buffer.alloc(20);
            coordinate.writeBigUInt64BE(0n, 0);
            coordinate.writeBigUInt64BE(0n, 8);
            coordinate.writeUInt32BE(4, 16);
            return createHash("sha256")
              .update(Buffer.from("digital-artifact-frame-v1\0"))
              .update(coordinate)
              .update("good")
              .digest();
          },
          async close() {
            throw new Error("manifest cleanup failed");
          },
        };
      },
    },
    executionHost: host,
    cleanupReporter: {
      reportCleanupFailure(input) {
        cleanup.push(input.cleanup);
      },
    },
  });

  await expect(
    access.open({
      selection: { artifactRevisionId: "revision-cleanup" },
      expectedBlobDigest: digest,
      interval: { startInclusive: 0, endInclusive: 3 },
    }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-integrity-failed",
  });
  expect(cleanup).toEqual(["media-source", "proof-manifest"]);
  await host.close();
});

it("fails before returning a lease when its observed root is invalidated after first-frame verification", async () => {
  const host = new ExecutionHost();
  let sourceClosed = 0;
  let manifestClosed = 0;
  const access = new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-window",
            artifactId: "artifact-window",
            blobDigest: digest,
          },
          blob: { digest, byteLength: 4, mediaType: "text/plain" },
          locations: [
            {
              kind: "observed" as const,
              locationId: "location-window",
              address: "private-window",
              confirmedObservation: {
                snapshotId: "snapshot-window",
                observedAt: "2026-08-29T00:00:00.000Z",
                size: 4,
                modifiedAt: "2026-08-29T00:00:00.000Z",
              },
              confirmationBaseline: "baseline-window",
            },
          ],
        };
      },
      async readArtifactContentProof() {
        return proof;
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        return "stale" as const;
      },
    },
    sources: {
      async open(input) {
        return {
          source: {
            ...source("good"),
            async close() {
              sourceClosed += 1;
            },
          },
          suggestedFilename: "file.txt",
          observedBinding: input.operation.bindObservedRoot({
            registrationId: "root-window",
            registrationVersion: 1,
          }),
          observedAuthority: {
            registrationId: "root-window",
            registrationVersion: 1,
          },
        };
      },
    },
    proofStore: {
      async inspect() {},
      async build() {
        throw new Error("not reached");
      },
      async open() {
        return {
          async expectedFrameDigest() {
            queueMicrotask(() =>
              queueMicrotask(() =>
                host.invalidateObservedRoot({
                  registrationId: "root-window",
                }),
              ),
            );
            const coordinate = Buffer.alloc(20);
            coordinate.writeBigUInt64BE(0n, 0);
            coordinate.writeBigUInt64BE(0n, 8);
            coordinate.writeUInt32BE(4, 16);
            return createHash("sha256")
              .update(Buffer.from("digital-artifact-frame-v1\0"))
              .update(coordinate)
              .update("good")
              .digest();
          },
          async close() {
            manifestClosed += 1;
          },
        };
      },
    },
    executionHost: host,
  });

  await expect(
    access.open({
      selection: { artifactRevisionId: "revision-window" },
      expectedBlobDigest: digest,
      interval: { startInclusive: 0, endInclusive: 3 },
    }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-location-revoked",
  });
  expect(sourceClosed).toBe(1);
  expect(manifestClosed).toBe(1);
  await host.close();
});

it("cleans an observed source when its root is invalidated before candidate ownership transfers", async () => {
  const host = new ExecutionHost();
  let sourceCloseAttempts = 0;
  let manifestClosed = 0;
  let cleanupPrimary: unknown;
  const access = new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-open-window",
            artifactId: "artifact-open-window",
            blobDigest: digest,
          },
          blob: { digest, byteLength: 4, mediaType: "text/plain" },
          locations: [
            {
              kind: "observed" as const,
              locationId: "location-open-window",
              address: "private-open-window",
              confirmedObservation: {
                snapshotId: "snapshot-open-window",
                observedAt: "2026-08-29T00:00:00.000Z",
                size: 4,
                modifiedAt: "2026-08-29T00:00:00.000Z",
              },
              confirmationBaseline: "baseline-open-window",
            },
          ],
        };
      },
      async readArtifactContentProof() {
        return proof;
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        return "stale" as const;
      },
    },
    sources: {
      async open(input) {
        const observedBinding = input.operation.bindObservedRoot({
          registrationId: "root-open-window",
          registrationVersion: 1,
        });
        queueMicrotask(() =>
          host.invalidateObservedRoot({
            registrationId: "root-open-window",
          }),
        );
        return {
          source: {
            ...source("good"),
            async close() {
              sourceCloseAttempts += 1;
              throw new Error("source close failed");
            },
          },
          suggestedFilename: "file.txt",
          observedBinding,
          observedAuthority: {
            registrationId: "root-open-window",
            registrationVersion: 1,
          },
        };
      },
    },
    proofStore: {
      async inspect() {},
      async build() {
        throw new Error("not reached");
      },
      async open() {
        return {
          async expectedFrameDigest() {
            throw new Error("not reached");
          },
          async close() {
            manifestClosed += 1;
          },
        };
      },
    },
    executionHost: host,
    cleanupReporter: {
      reportCleanupFailure(input) {
        cleanupPrimary = input.primaryError;
      },
    },
  });

  await expect(
    access.open({
      selection: { artifactRevisionId: "revision-open-window" },
      expectedBlobDigest: digest,
      interval: { startInclusive: 0, endInclusive: 3 },
    }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-location-revoked",
  });
  expect(sourceCloseAttempts).toBe(1);
  expect(cleanupPrimary).toMatchObject<ArtifactByteAccessError>({
    code: "artifact-location-revoked",
  });
  expect(manifestClosed).toBe(1);
  await expect(host.close()).resolves.toBeUndefined();
});

it("reports cancellation cleanup failure without an unhandled rejection or failed host drain", async () => {
  const host = new ExecutionHost();
  const cleanup: string[] = [];
  const access = new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-cancel-cleanup",
            artifactId: "artifact-cancel-cleanup",
            blobDigest: digest,
          },
          blob: { digest, byteLength: 4, mediaType: "text/plain" },
          locations: [
            {
              kind: "observed" as const,
              locationId: "location-cancel-cleanup",
              address: "private-cancel-cleanup",
              confirmedObservation: {
                snapshotId: "snapshot-cancel-cleanup",
                observedAt: "2026-08-29T00:00:00.000Z",
                size: 4,
                modifiedAt: "2026-08-29T00:00:00.000Z",
              },
              confirmationBaseline: "baseline-cancel-cleanup",
            },
          ],
        };
      },
      async readArtifactContentProof() {
        return proof;
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        return "stale" as const;
      },
    },
    sources: {
      async open(input) {
        return {
          source: {
            ...source("good"),
            async close() {
              throw new Error("source close failed");
            },
          },
          suggestedFilename: "file.txt",
          observedBinding: input.operation.bindObservedRoot({
            registrationId: "root-cancel-cleanup",
            registrationVersion: 1,
          }),
          observedAuthority: {
            registrationId: "root-cancel-cleanup",
            registrationVersion: 1,
          },
        };
      },
    },
    proofStore: {
      async inspect() {},
      async build() {
        throw new Error("not reached");
      },
      async open() {
        return {
          async expectedFrameDigest() {
            const coordinate = Buffer.alloc(20);
            coordinate.writeBigUInt64BE(0n, 0);
            coordinate.writeBigUInt64BE(0n, 8);
            coordinate.writeUInt32BE(4, 16);
            return createHash("sha256")
              .update(Buffer.from("digital-artifact-frame-v1\0"))
              .update(coordinate)
              .update("good")
              .digest();
          },
          async close() {},
        };
      },
    },
    executionHost: host,
    cleanupReporter: {
      reportCleanupFailure(input) {
        cleanup.push(input.cleanup);
      },
    },
  });
  await access.open({
    selection: { artifactRevisionId: "revision-cancel-cleanup" },
    expectedBlobDigest: digest,
    interval: { startInclusive: 0, endInclusive: 3 },
  });

  host.invalidateObservedRoot({ registrationId: "root-cancel-cleanup" });

  await expect(host.close()).resolves.toBeUndefined();
  expect(cleanup).toEqual(["media-source"]);
});

it("rejects every interval for an empty Blob before opening its proof or candidates", async () => {
  const host = new ExecutionHost();
  let proofReads = 0;
  const access = new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-empty",
            artifactId: "artifact-empty",
            blobDigest: digest,
          },
          blob: { digest, byteLength: 0, mediaType: "text/plain" },
          locations: [],
        };
      },
      async readArtifactContentProof() {
        proofReads += 1;
        return undefined;
      },
      async adoptArtifactContentProof() {
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        return "stale" as const;
      },
    },
    sources: {
      async open() {
        return undefined;
      },
    },
    proofStore: {
      async inspect() {},
      async build() {
        throw new Error("not reached");
      },
      async open() {
        throw new Error("not reached");
      },
    },
    executionHost: host,
  });

  await expect(
    access.open({
      selection: { artifactRevisionId: "revision-empty" },
      expectedBlobDigest: digest,
      interval: { startInclusive: 0, endInclusive: -1 },
    }),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-integrity-failed",
  });
  expect(proofReads).toBe(0);
  await host.close();
});
