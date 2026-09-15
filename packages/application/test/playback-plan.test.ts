import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import {
  ApplicationArtifactByteAccess,
  ArtifactByteAccessError,
  ExecutionHost,
  planDirectPlayback,
  type ArtifactByteSource,
  type ArtifactContentProofMetadata,
  type ArtifactLocationByteSources,
  type ArtifactRevisionAccessFacts,
  type OpenedArtifactByteSource,
  type PlaybackFormatInspector,
} from "../src/index.ts";

it("为规范化后的兼容 MP3 声明确定性选择直接播放", () => {
  const first = planDirectPlayback({
    descriptor: {
      revisionId: "revision-mp3",
      blobDigest: "a".repeat(64),
      byteLength: 42,
      mediaType: "application/octet-stream",
      suggestedFilename: "track.bin",
    },
    consumer: {
      contractVersion: "consumer-playback/1",
      supportsByteRanges: true,
      media: [
        { mediaType: "audio/mpeg", codecs: ["MP3", "mp3"] },
        { mediaType: " AUDIO/MPEG ", codecs: ["mp3"] },
      ],
    },
    preferences: {},
    format: {
      mediaType: "audio/mpeg",
      container: "mp3",
      codecs: ["mp3"],
    },
    deployment: {
      direct: { contractVersion: "direct-playback/1" },
      processors: [],
    },
  });

  expect(first).toEqual({
    status: "ready",
    revisionId: "revision-mp3",
    blobDigest: "a".repeat(64),
    rendition: {
      kind: "direct",
      mediaType: "audio/mpeg",
      codecs: ["mp3"],
      byteLength: 42,
    },
  });
});

it.each([
  [false, undefined, {}, "byte-ranges-required"],
  [true, undefined, {}, "format-unknown"],
  [
    true,
    { mediaType: "video/webm", container: "webm", codecs: ["vp9"] },
    {},
    "container-unsupported",
  ],
  [
    true,
    { mediaType: "audio/mpeg", container: "mp3", codecs: ["mp3"] },
    { audioTrackId: "track-2" },
    "preference-unavailable",
  ],
] as const)(
  "返回稳定的不兼容原因 %#",
  (supportsByteRanges, format, preferences, reason) => {
    expect(
      planDirectPlayback({
        descriptor: {
          revisionId: "revision-incompatible",
          blobDigest: "b".repeat(64),
          byteLength: 10,
          mediaType: "application/octet-stream",
          suggestedFilename: "unknown.bin",
        },
        consumer: {
          contractVersion: "consumer-playback/1",
          supportsByteRanges,
          media: [{ mediaType: "audio/mpeg", codecs: ["mp3"] }],
        },
        preferences,
        format,
        deployment: {
          direct: { contractVersion: "direct-playback/1" },
          processors: [],
        },
      }),
    ).toEqual({ status: "incompatible", reason });
  },
);

it("区分容器兼容但 codec 不兼容", () => {
  expect(
    planDirectPlayback({
      descriptor: {
        revisionId: "revision-codec",
        blobDigest: "c".repeat(64),
        byteLength: 10,
        mediaType: "video/mp4",
        suggestedFilename: "video.mp4",
      },
      consumer: {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "video/mp4", codecs: ["avc1.640028"] }],
      },
      preferences: {},
      format: {
        mediaType: "video/mp4",
        container: "mp4",
        codecs: ["avc1.42e01e"],
      },
      deployment: {
        direct: { contractVersion: "direct-playback/1" },
        processors: [],
      },
    }),
  ).toEqual({ status: "incompatible", reason: "codec-unsupported" });
});

it.each([undefined, []] as const)(
  "将 consumer codecs=%s 解释为 mediaType wildcard",
  (codecs) => {
    expect(
      planDirectPlayback({
        descriptor: {
          revisionId: "revision-wildcard",
          blobDigest: "f".repeat(64),
          byteLength: 100,
          mediaType: "application/octet-stream",
          suggestedFilename: "opaque.bin",
        },
        consumer: {
          contractVersion: "consumer-playback/1",
          supportsByteRanges: true,
          media: [
            {
              mediaType: "video/mp4",
              ...(codecs === undefined ? {} : { codecs }),
            },
          ],
        },
        preferences: {},
        format: {
          mediaType: "video/mp4",
          container: "mp4",
          codecs: ["avc1.640032", "mp4a.40.2"],
        },
        deployment: {
          direct: { contractVersion: "direct-playback/1" },
          processors: [],
        },
      }),
    ).toMatchObject({ status: "ready" });
  },
);

it.each([
  ["audio/mpeg", "mp3", ["mp3"]],
  ["audio/wav", "wav", ["pcm"]],
  ["video/mp4", "mp4", ["avc1.42e01e"]],
] as const)("为受检 %s/%s 结构选择 direct", (mediaType, container, codecs) => {
  expect(
    planDirectPlayback({
      descriptor: {
        revisionId: "revision-direct",
        blobDigest: "e".repeat(64),
        byteLength: 100,
        mediaType: "application/octet-stream",
        suggestedFilename: "opaque.bin",
      },
      consumer: {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType, codecs: [...codecs].toReversed() }],
      },
      preferences: {},
      format: { mediaType, container, codecs: [...codecs].toReversed() },
      deployment: {
        direct: { contractVersion: "direct-playback/1" },
        processors: [],
      },
    }),
  ).toMatchObject({
    status: "ready",
    rendition: { kind: "direct", mediaType },
  });
});

it("planPlayback 以一个 Host reservation 覆盖 describe、probe、关闭和结果发布", async () => {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  const host = new ExecutionHost();
  const leaseSpy = vi.spyOn(host, "lease");
  let opens = 0;
  let closes = 0;
  let writes = 0;
  const access = playbackAccess({
    bytes,
    host,
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        expect(
          await input.bytes.read({ startInclusive: 0, endInclusive: 3 }),
        ).toEqual(bytes.slice(0, 4));
        return { mediaType: "audio/mpeg", container: "mp3", codecs: ["mp3"] };
      },
    },
    onOpen: () => (opens += 1),
    onClose: () => (closes += 1),
    onWrite: () => (writes += 1),
  });

  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "audio/mpeg", codecs: ["mp3"] }],
      },
      {},
    ),
  ).resolves.toMatchObject({ status: "ready", revisionId: "revision-plan" });
  expect(leaseSpy).toHaveBeenCalledTimes(1);
  expect(opens).toBe(3);
  expect(closes).toBe(3);
  expect(writes).toBe(0);
  await expect(host.close()).resolves.toBeUndefined();
});

it("拒绝超过单次 probe 预算并关闭 describe 短租约", async () => {
  const bytes = new Uint8Array(70_000);
  const host = new ExecutionHost();
  let closes = 0;
  const access = playbackAccess({
    bytes,
    host,
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        await input.bytes.read({ startInclusive: 0, endInclusive: 65_536 });
        return undefined;
      },
    },
    onOpen() {},
    onClose: () => (closes += 1),
  });
  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [],
      },
      {},
    ),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-integrity-failed",
  });
  expect(closes).toBe(1);
  await expect(host.close()).resolves.toBeUndefined();
});

it("同一 1MiB proof frame 内跨过五个 64KiB 区域仍只验证一次", async () => {
  const bytes = new Uint8Array(262_145);
  const host = new ExecutionHost();
  let opens = 0;
  let closes = 0;
  let manifestOpens = 0;
  let frameChecks = 0;
  let frameReadCalls = 0;
  let frameBytes = 0;
  const access = playbackAccess({
    bytes,
    host,
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        for (let index = 0; index < 5; index += 1)
          await input.bytes.read({
            startInclusive: index * 65_536,
            endInclusive: index * 65_536,
          });
        return undefined;
      },
    },
    onOpen: () => (opens += 1),
    onClose: () => (closes += 1),
    onManifestOpen: () => (manifestOpens += 1),
    onFrameCheck: () => (frameChecks += 1),
    onSourceRead(readBytes) {
      frameReadCalls += 1;
      frameBytes += readBytes;
    },
  });
  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [],
      },
      {},
    ),
  ).resolves.toEqual({ status: "incompatible", reason: "format-unknown" });
  expect(opens).toBe(3);
  expect(closes).toBe(3);
  expect(manifestOpens).toBe(1);
  expect(frameChecks).toBe(1);
  expect(frameReadCalls).toBe(1);
  expect(frameBytes).toBe(bytes.byteLength);
  await expect(host.close()).resolves.toBeUndefined();
});

it("第五个不同的 1MiB proof frame 在打开前 fail closed", async () => {
  const bytes = new Uint8Array(4 * 1_048_576 + 1);
  const host = new ExecutionHost();
  let opens = 0;
  let closes = 0;
  let manifestOpens = 0;
  let frameChecks = 0;
  let frameReadCalls = 0;
  let frameBytes = 0;
  const access = playbackAccess({
    bytes,
    host,
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        for (let index = 0; index < 5; index += 1)
          await input.bytes.read({
            startInclusive: index * 1_048_576,
            endInclusive: index * 1_048_576,
          });
        return undefined;
      },
    },
    onOpen: () => (opens += 1),
    onClose: () => (closes += 1),
    onManifestOpen: () => (manifestOpens += 1),
    onFrameCheck: () => (frameChecks += 1),
    onSourceRead(readBytes) {
      frameReadCalls += 1;
      frameBytes += readBytes;
    },
  });

  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [],
      },
      {},
    ),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-integrity-failed",
  });
  expect(opens).toBe(5);
  expect(closes).toBe(5);
  expect(manifestOpens).toBe(4);
  expect(frameChecks).toBe(4);
  expect(frameReadCalls).toBe(4);
  expect(frameBytes).toBe(4 * 1_048_576);
  await expect(host.close()).resolves.toBeUndefined();
});

it("缓存已验证 proof frame 并正确拼接跨 frame 读取", async () => {
  const bytes = Uint8Array.from(
    { length: 1_048_592 },
    (_, index) => index % 251,
  );
  const host = new ExecutionHost();
  let opens = 0;
  let closes = 0;
  let manifestOpens = 0;
  const access = playbackAccess({
    bytes,
    host,
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        for (const interval of [
          { startInclusive: 4, endInclusive: 7 },
          { startInclusive: 20, endInclusive: 23 },
          { startInclusive: 1_048_570, endInclusive: 1_048_581 },
          { startInclusive: 1_048_578, endInclusive: 1_048_585 },
        ])
          expect(await input.bytes.read(interval)).toEqual(
            bytes.slice(interval.startInclusive, interval.endInclusive + 1),
          );
        return {
          mediaType: "video/mp4",
          container: "mp4",
          codecs: ["avc1.640032", "mp4a.40.2"],
        };
      },
    },
    onOpen: () => (opens += 1),
    onClose: () => (closes += 1),
    onManifestOpen: () => (manifestOpens += 1),
  });

  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "video/mp4", codecs: [] }],
      },
      {},
    ),
  ).resolves.toMatchObject({ status: "ready" });
  expect(manifestOpens).toBe(2);
  expect(opens).toBe(4);
  expect(closes).toBe(4);
  await expect(host.close()).resolves.toBeUndefined();
});

it("缓存失败窗口、关闭其短租约且不把重试放大为第二次 proof 工作", async () => {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  const host = new ExecutionHost();
  let sourceOpens = 0;
  let sourceCloses = 0;
  let manifestOpens = 0;
  const access = playbackAccess({
    bytes,
    host,
    async openCandidate(_openInput, source) {
      sourceOpens += 1;
      if (sourceOpens === 2) {
        const changed = bytes.slice();
        changed[0] ^= 0xff;
        source = byteSource(changed, () => (sourceCloses += 1));
      }
      return { source, suggestedFilename: "track.bin" };
    },
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        for (let attempt = 0; attempt < 2; attempt += 1)
          await expect(
            input.bytes.read({ startInclusive: 0, endInclusive: 3 }),
          ).rejects.toMatchObject<ArtifactByteAccessError>({
            code: "artifact-integrity-failed",
          });
        return undefined;
      },
    },
    onOpen() {},
    onClose: () => (sourceCloses += 1),
    onManifestOpen: () => (manifestOpens += 1),
  });

  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [],
      },
      {},
    ),
  ).resolves.toEqual({ status: "incompatible", reason: "format-unknown" });
  expect(manifestOpens).toBe(1);
  expect(sourceOpens).toBe(3);
  expect(sourceCloses).toBe(3);
  await expect(host.close()).resolves.toBeUndefined();
});

it("窗口读取仍拒绝检查器并发 read", async () => {
  const bytes = new Uint8Array(417);
  const host = new ExecutionHost();
  const access = playbackAccess({
    bytes,
    host,
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        const first = input.bytes.read({ startInclusive: 0, endInclusive: 3 });
        await expect(
          input.bytes.read({ startInclusive: 4, endInclusive: 7 }),
        ).rejects.toMatchObject<ArtifactByteAccessError>({
          code: "byte-read-in-progress",
        });
        await first;
        return undefined;
      },
    },
    onOpen() {},
    onClose() {},
  });

  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [],
      },
      {},
    ),
  ).resolves.toEqual({ status: "incompatible", reason: "format-unknown" });
  await expect(host.close()).resolves.toBeUndefined();
});

it("初始观察根读取失败后释放绑定并回退到另一观察根", async () => {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  const host = new ExecutionHost();
  const bound: string[] = [];
  let closes = 0;
  let rootAOpens = 0;
  const access = playbackAccess({
    bytes,
    host,
    locations: [observedLocation("root-a"), observedLocation("root-b")],
    async openCandidate(openInput, source) {
      const registrationId = openInput.candidate.locationId;
      bound.push(registrationId);
      if (registrationId === "root-a") rootAOpens += 1;
      const observedBinding = openInput.operation.bindObservedRoot({
        registrationId,
        registrationVersion: 1,
      });
      if (registrationId === "root-a" && rootAOpens === 2) {
        const changed = bytes.slice();
        changed[0] ^= 0xff;
        source = byteSource(changed, () => (closes += 1));
      }
      return {
        source,
        suggestedFilename: "track.bin",
        observedBinding,
        observedAuthority: { registrationId, registrationVersion: 1 },
      };
    },
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        await input.bytes.read({ startInclusive: 0, endInclusive: 3 });
        return { mediaType: "audio/mpeg", container: "mp3", codecs: ["mp3"] };
      },
    },
    onOpen() {},
    onClose: () => (closes += 1),
  });
  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "audio/mpeg", codecs: ["mp3"] }],
      },
      {},
    ),
  ).resolves.toMatchObject({ status: "ready" });
  expect(bound).toContain("root-a");
  expect(bound).toContain("root-b");
  expect(closes).toBeGreaterThanOrEqual(4);
  await expect(host.close()).resolves.toBeUndefined();
});

it("观察源关闭失败时保留其绑定且不把下一根资源交给计划", async () => {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  const host = new ExecutionHost();
  let rootAOpens = 0;
  let rootBReturned = false;
  const access = playbackAccess({
    bytes,
    host,
    locations: [observedLocation("root-a"), observedLocation("root-b")],
    async openCandidate(openInput, source) {
      const registrationId = openInput.candidate.locationId;
      const observedBinding = openInput.operation.bindObservedRoot({
        registrationId,
        registrationVersion: 1,
      });
      if (registrationId === "root-a") {
        rootAOpens += 1;
        if (rootAOpens === 2) {
          const changed = bytes.slice();
          changed[0] ^= 0xff;
          source = {
            ...byteSource(changed, () => undefined),
            async close() {
              throw new Error("root-a close failed");
            },
          };
        }
      } else rootBReturned = true;
      return {
        source,
        suggestedFilename: "track.bin",
        observedBinding,
        observedAuthority: { registrationId, registrationVersion: 1 },
      };
    },
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        await input.bytes.read({ startInclusive: 0, endInclusive: 3 });
        return undefined;
      },
    },
    onOpen() {},
    onClose() {},
  });

  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [],
      },
      {},
    ),
  ).rejects.toMatchObject<ArtifactByteAccessError>({
    code: "artifact-integrity-failed",
  });
  expect(rootBReturned).toBe(false);
  await expect(host.close()).resolves.toBeUndefined();
});

it("切到 managed probe 后旧观察根撤销不再取消计划", async () => {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  const host = new ExecutionHost();
  let managedAttempts = 0;
  const access = playbackAccess({
    bytes,
    host,
    locations: [managedLocation(), observedLocation("root-a")],
    async openCandidate(openInput, source) {
      if (openInput.candidate.kind === "managed") {
        managedAttempts += 1;
        return managedAttempts === 1
          ? undefined
          : { source, suggestedFilename: "track.bin" };
      }
      const observedBinding = openInput.operation.bindObservedRoot({
        registrationId: "root-a",
        registrationVersion: 1,
      });
      return {
        source,
        suggestedFilename: "track.bin",
        observedBinding,
        observedAuthority: { registrationId: "root-a", registrationVersion: 1 },
      };
    },
    inspector: {
      ...inspectorCoordinate,
      async inspect(input) {
        await input.bytes.read({ startInclusive: 0, endInclusive: 3 });
        host.invalidateObservedRoot({ registrationId: "root-a" });
        return { mediaType: "audio/mpeg", container: "mp3", codecs: ["mp3"] };
      },
    },
    onOpen() {},
    onClose() {},
  });

  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-plan" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "audio/mpeg", codecs: ["mp3"] }],
      },
      {},
    ),
  ).resolves.toMatchObject({ status: "ready" });
  await expect(host.close()).resolves.toBeUndefined();
});

it.each(["revoke", "shutdown"] as const)(
  "最终观察授权在同步发布前发生 %s 时拒绝计划",
  async (event) => {
    const bytes = new Uint8Array(417);
    bytes.set([0xff, 0xfb, 0x90, 0x64]);
    const host = new ExecutionHost();
    let closes = 0;
    const access = playbackAccess({
      bytes,
      host,
      observed: true,
      inspector: {
        ...inspectorCoordinate,
        async inspect(input) {
          await input.bytes.read({ startInclusive: 0, endInclusive: 3 });
          return { mediaType: "audio/mpeg", container: "mp3", codecs: ["mp3"] };
        },
      },
      onOpen() {},
      onClose() {
        closes += 1;
        if (closes !== 3) return;
        if (event === "revoke")
          host.invalidateObservedRoot({ registrationId: "root-plan" });
        else void host.close();
      },
    });
    await expect(
      access.planPlayback(
        { artifactRevisionId: "revision-plan" },
        {
          contractVersion: "consumer-playback/1",
          supportsByteRanges: true,
          media: [{ mediaType: "audio/mpeg", codecs: ["mp3"] }],
        },
        {},
      ),
    ).rejects.toMatchObject<ArtifactByteAccessError>({
      code:
        event === "revoke"
          ? "artifact-location-revoked"
          : "application-shutting-down",
    });
    await expect(host.close()).resolves.toBeUndefined();
  },
);

const inspectorCoordinate = {
  capability: {
    capabilityId: "test.playback-format",
    capabilityVersion: "1",
    contractVersion: "playback-format-inspector/1",
  },
};

function playbackAccess(input: {
  readonly bytes: Uint8Array;
  readonly host: ExecutionHost;
  readonly inspector: PlaybackFormatInspector;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly observed?: boolean;
  readonly onWrite?: () => void;
  readonly onManifestOpen?: () => void;
  readonly onFrameCheck?: () => void;
  readonly onSourceRead?: (bytes: number) => void;
  readonly locations?: ArtifactRevisionAccessFacts["locations"];
  readonly openCandidate?: (
    input: Parameters<ArtifactLocationByteSources["open"]>[0],
    source: ArtifactByteSource,
  ) => Promise<OpenedArtifactByteSource | undefined>;
}) {
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  const proof: ArtifactContentProofMetadata = {
    blobDigest: digest,
    scheme: "artifact-frame-manifest/1",
    byteLength: input.bytes.byteLength,
    frameSize: 1_048_576,
    frameCount: Math.ceil(input.bytes.byteLength / 1_048_576),
    manifestDigest: "d".repeat(64),
  };
  return new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-plan",
            artifactId: "artifact-plan",
            blobDigest: digest,
          },
          blob: {
            digest,
            byteLength: input.bytes.byteLength,
            mediaType: "application/octet-stream",
          },
          locations:
            input.locations ??
            (input.observed
              ? [
                  {
                    kind: "observed" as const,
                    locationId: "observed-plan",
                    address: "private-plan",
                    confirmedObservation: {
                      snapshotId: "snapshot-plan",
                      observedAt: "2026-08-29T00:00:00.000Z",
                      size: input.bytes.byteLength,
                      modifiedAt: "2026-08-29T00:00:00.000Z",
                    },
                    confirmationBaseline: "baseline-plan",
                  },
                ]
              : [
                  {
                    kind: "managed" as const,
                    locationId: "managed-plan",
                    address: "private-plan",
                  },
                ]),
        };
      },
      async readArtifactContentProof() {
        return proof;
      },
      async adoptArtifactContentProof() {
        input.onWrite?.();
        return "stale" as const;
      },
      async observedFileSelectionForLocation() {
        return undefined;
      },
      async readObservedFileConfirmationFacts() {
        return undefined;
      },
      async submitConfirmedObservedRevision() {
        input.onWrite?.();
        return "stale" as const;
      },
    },
    sources: {
      async open(openInput) {
        input.onOpen();
        const source = byteSource(
          input.bytes,
          input.onClose,
          input.onSourceRead,
        );
        if (input.openCandidate !== undefined)
          return await input.openCandidate(openInput, source);
        if (!input.observed) return { source, suggestedFilename: "track.bin" };
        const observedBinding = openInput.operation.bindObservedRoot({
          registrationId: "root-plan",
          registrationVersion: 1,
        });
        return {
          source,
          suggestedFilename: "track.bin",
          observedBinding,
          observedAuthority: {
            registrationId: "root-plan",
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
        input.onManifestOpen?.();
        return {
          async expectedFrameDigest(ordinal) {
            input.onFrameCheck?.();
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

function byteSource(
  bytes: Uint8Array,
  onClose: () => void,
  onRead?: (bytes: number) => void,
): ArtifactByteSource {
  return {
    byteLength: bytes.byteLength,
    async readChunk(offset, maximumBytes) {
      const chunk = bytes.slice(offset, offset + maximumBytes);
      onRead?.(chunk.byteLength);
      return {
        bytes: chunk,
        done: offset + chunk.byteLength >= bytes.byteLength,
      };
    },
    async close() {
      onClose();
    },
  };
}

function managedLocation(): ArtifactRevisionAccessFacts["locations"][number] {
  return {
    kind: "managed",
    locationId: "managed-plan",
    address: "private-plan",
  };
}

function observedLocation(
  locationId: string,
): ArtifactRevisionAccessFacts["locations"][number] {
  return {
    kind: "observed",
    locationId,
    address: `private-${locationId}`,
    confirmedObservation: {
      snapshotId: `snapshot-${locationId}`,
      observedAt: "2026-08-29T00:00:00.000Z",
      size: 417,
      modifiedAt: "2026-08-29T00:00:00.000Z",
    },
    confirmationBaseline: `baseline-${locationId}`,
  };
}
