import { createHash } from "node:crypto";

import {
  ApplicationArtifactByteAccess,
  ExecutionHost,
  planDirectPlayback,
  type ArtifactByteSource,
  type ArtifactContentProofMetadata,
} from "@digital/application";
import { expect, it } from "vitest";

import { boundedPlaybackFormatInspector } from "../src/index.ts";

async function inspect(bytes: Uint8Array) {
  return await boundedPlaybackFormatInspector.inspect({
    revisionId: "revision-format",
    blobDigest: "a".repeat(64),
    bytes: {
      async read(interval) {
        return bytes.slice(interval.startInclusive, interval.endInclusive + 1);
      },
    },
  });
}

async function inspectWithReads(bytes: Uint8Array) {
  const reads: Array<{
    readonly startInclusive: number;
    readonly endInclusive: number;
  }> = [];
  const result = await boundedPlaybackFormatInspector.inspect({
    revisionId: "revision-format",
    blobDigest: "a".repeat(64),
    bytes: {
      async read(interval) {
        reads.push(interval);
        return bytes.slice(interval.startInclusive, interval.endInclusive + 1);
      },
    },
  });
  return { result, reads };
}

it("从实际帧头识别 MP3，而不依赖扩展名或媒体类型", async () => {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  expect(await inspect(bytes)).toEqual({
    mediaType: "audio/mpeg",
    container: "mp3",
    codecs: ["mp3"],
  });
});

it("从 RIFF/WAVE fmt 与 data 结构识别 PCM WAV", async () => {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 40, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 192_000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 4, true);
  expect(await inspect(bytes)).toEqual({
    mediaType: "audio/wav",
    container: "wav",
    codecs: ["pcm"],
  });
});

it("拒绝只有扩展名语义、畸形边界或未知结构的字节", async () => {
  expect(await inspect(new TextEncoder().encode("track.mp3"))).toBeUndefined();
  expect(
    await inspect(new TextEncoder().encode("RIFF\u0001\u0000\u0000\u0000WAVE")),
  ).toBeUndefined();
});

it("从 MP4 box 与 avcC 样本条目识别浏览器兼容 H.264 codec", async () => {
  const encode = new TextEncoder();
  const box = (type: string, payload: Uint8Array) => {
    const result = new Uint8Array(8 + payload.byteLength);
    new DataView(result.buffer).setUint32(0, result.byteLength);
    result.set(encode.encode(type), 4);
    result.set(payload, 8);
    return result;
  };
  const join = (...parts: Uint8Array[]) => {
    const result = new Uint8Array(
      parts.reduce((sum, part) => sum + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  };
  const sample = box(
    "avc1",
    join(
      new Uint8Array(78),
      box("avcC", new Uint8Array([1, 0x42, 0xe0, 0x1e])),
    ),
  );
  const stsdHeader = new Uint8Array(8);
  new DataView(stsdHeader.buffer).setUint32(4, 1);
  const bytes = join(
    box("ftyp", encode.encode("isom\u0000\u0000\u0000\u0000isom")),
    box(
      "moov",
      box(
        "trak",
        box(
          "mdia",
          box("minf", box("stbl", box("stsd", join(stsdHeader, sample)))),
        ),
      ),
    ),
  );
  expect(await inspect(bytes)).toEqual({
    mediaType: "video/mp4",
    container: "mp4",
    codecs: ["avc1.42e01e"],
  });
});

it("从 avc3 sample entry 发布精确 codec，并由 direct policy 精确匹配", async () => {
  const encode = new TextEncoder();
  const box = (type: string, payload: Uint8Array) => {
    const result = new Uint8Array(8 + payload.byteLength);
    new DataView(result.buffer).setUint32(0, result.byteLength);
    result.set(encode.encode(type), 4);
    result.set(payload, 8);
    return result;
  };
  const join = (...parts: Uint8Array[]) => {
    const result = new Uint8Array(
      parts.reduce((sum, part) => sum + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  };
  const sample = box(
    "avc3",
    join(new Uint8Array(78), box("avcC", new Uint8Array([1, 0x64, 0, 0x32]))),
  );
  const stsdHeader = new Uint8Array(8);
  new DataView(stsdHeader.buffer).setUint32(4, 1);
  const bytes = join(
    box("ftyp", encode.encode("isom\u0000\u0000\u0000\u0000isom")),
    box(
      "moov",
      box(
        "trak",
        box(
          "mdia",
          box("minf", box("stbl", box("stsd", join(stsdHeader, sample)))),
        ),
      ),
    ),
  );
  const format = await inspect(bytes);
  expect(format).toEqual({
    mediaType: "video/mp4",
    container: "mp4",
    codecs: ["avc3.640032"],
  });
  const plan = (codec: string) =>
    planDirectPlayback({
      descriptor: {
        revisionId: "revision-avc3",
        blobDigest: "a".repeat(64),
        byteLength: bytes.byteLength,
        mediaType: "application/octet-stream",
        suggestedFilename: "opaque.bin",
      },
      consumer: {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "video/mp4", codecs: [codec] }],
      },
      preferences: {},
      format,
      deployment: {
        direct: { contractVersion: "direct-playback/1" },
        processors: [],
      },
    });
  expect(plan("avc1.640032")).toEqual({
    status: "incompatible",
    reason: "codec-unsupported",
  });
  expect(plan("avc3.640032")).toMatchObject({ status: "ready" });
});

it("包含 avc1 与未完整识别的 vp09 sample entry 时拒绝发布部分 codec facts", async () => {
  const encode = new TextEncoder();
  const box = (type: string, payload: Uint8Array) => {
    const result = new Uint8Array(8 + payload.byteLength);
    new DataView(result.buffer).setUint32(0, result.byteLength);
    result.set(encode.encode(type), 4);
    result.set(payload, 8);
    return result;
  };
  const join = (...parts: Uint8Array[]) => {
    const result = new Uint8Array(
      parts.reduce((sum, part) => sum + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  };
  const visualEntry = (type: string, configuration: Uint8Array) => {
    const header = new Uint8Array(78);
    const view = new DataView(header.buffer);
    view.setUint16(6, 1);
    view.setUint16(24, 1920);
    view.setUint16(26, 1080);
    view.setUint32(28, 0x0048_0000);
    view.setUint32(32, 0x0048_0000);
    view.setUint16(40, 1);
    view.setUint16(74, 0x18);
    view.setUint16(76, 0xffff);
    return box(type, join(header, configuration));
  };
  const avc1 = visualEntry(
    "avc1",
    box("avcC", new Uint8Array([1, 0x64, 0, 0x32])),
  );
  const vp09 = visualEntry("vp09", box("vpcC", new Uint8Array(12)));
  const stsdHeader = new Uint8Array(8);
  new DataView(stsdHeader.buffer).setUint32(4, 2);
  const stsd = box("stsd", join(stsdHeader, avc1, vp09));
  const bytes = join(
    box("ftyp", encode.encode("isom\u0000\u0000\u0000\u0000isom")),
    box("moov", box("trak", box("mdia", box("minf", box("stbl", stsd))))),
  );

  expect(await inspect(bytes)).toBeUndefined();
});

it("跨过大 ID3 标签和 WAV data 随机读取结构，且不读取整文件", async () => {
  const mp3 = new Uint8Array(70_427);
  mp3.set(new TextEncoder().encode("ID3"));
  const tagSize = 70_000;
  mp3.set(
    [
      (tagSize >> 21) & 0x7f,
      (tagSize >> 14) & 0x7f,
      (tagSize >> 7) & 0x7f,
      tagSize & 0x7f,
    ],
    6,
  );
  mp3.set([0xff, 0xfb, 0x90, 0x64], 70_010);
  const mp3Result = await inspectWithReads(mp3);
  expect(mp3Result.result?.container).toBe("mp3");

  const wav = new Uint8Array(100_044);
  const wavView = new DataView(wav.buffer);
  wav.set(new TextEncoder().encode("RIFF"), 0);
  wavView.setUint32(4, wav.byteLength - 8, true);
  wav.set(new TextEncoder().encode("WAVEfmt "), 8);
  wavView.setUint32(16, 16, true);
  wavView.setUint16(20, 1, true);
  wavView.setUint16(22, 2, true);
  wavView.setUint32(24, 48_000, true);
  wavView.setUint32(28, 192_000, true);
  wavView.setUint16(32, 4, true);
  wavView.setUint16(34, 16, true);
  wav.set(new TextEncoder().encode("data"), 36);
  wavView.setUint32(40, 100_000, true);
  const wavResult = await inspectWithReads(wav);
  expect(wavResult.result?.container).toBe("wav");
  expect(wavResult.reads).toContainEqual({
    startInclusive: wav.byteLength - 1,
    endInclusive: wav.byteLength - 1,
  });

  expect(
    [...mp3Result.reads, ...wavResult.reads].every(
      (range) => range.endInclusive - range.startInclusive + 1 <= 65_536,
    ),
  ).toBe(true);
});

it("按 box 尺寸跳过大 MP4 mdat 后读取 moov codec 结构", async () => {
  const encode = new TextEncoder();
  const box = (type: string, payload: Uint8Array) => {
    const result = new Uint8Array(8 + payload.byteLength);
    new DataView(result.buffer).setUint32(0, result.byteLength);
    result.set(encode.encode(type), 4);
    result.set(payload, 8);
    return result;
  };
  const join = (...parts: Uint8Array[]) => {
    const result = new Uint8Array(
      parts.reduce((sum, part) => sum + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  };
  const sample = box(
    "avc1",
    join(new Uint8Array(78), box("avcC", new Uint8Array([1, 0x42, 0, 0x1e]))),
  );
  const stsdHeader = new Uint8Array(8);
  new DataView(stsdHeader.buffer).setUint32(4, 1);
  const stsd = box("stsd", join(stsdHeader, sample));
  const moov = box(
    "moov",
    box("trak", box("mdia", box("minf", box("stbl", stsd)))),
  );
  const bytes = join(
    box("ftyp", encode.encode("isom\u0000\u0000\u0000\u0000isom")),
    box("mdat", new Uint8Array(100_000)),
    moov,
  );
  const inspected = await inspectWithReads(bytes);
  expect(inspected.result).toMatchObject({
    container: "mp4",
    codecs: ["avc1.42001e"],
  });
  expect(inspected.reads.some((range) => range.startInclusive >= 100_000)).toBe(
    true,
  );
  expect(
    inspected.reads.reduce(
      (sum, range) => sum + range.endInclusive - range.startInclusive + 1,
      0,
    ),
  ).toBeLessThan(1_000);
});

it("实际 AVC+AAC box 结构的细粒度读取只落入至多四个 64KiB 窗口", async () => {
  const encode = new TextEncoder();
  const box = (type: string, payload: Uint8Array) => {
    const result = new Uint8Array(8 + payload.byteLength);
    new DataView(result.buffer).setUint32(0, result.byteLength);
    result.set(encode.encode(type), 4);
    result.set(payload, 8);
    return result;
  };
  const join = (...parts: Uint8Array[]) => {
    const result = new Uint8Array(
      parts.reduce((sum, part) => sum + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  };
  const stsd = (entry: Uint8Array) => {
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(4, 1);
    return box("stsd", join(header, entry));
  };
  const avc1 = box(
    "avc1",
    join(new Uint8Array(78), box("avcC", new Uint8Array([1, 0x64, 0, 0x32]))),
  );
  const mp4a = box(
    "mp4a",
    join(
      new Uint8Array(28),
      box("esds", new Uint8Array([0, 0, 0, 0, 0x05, 0x02, 0x12, 0x10])),
    ),
  );
  const track = (entry: Uint8Array) =>
    box("trak", box("mdia", box("minf", box("stbl", stsd(entry)))));
  const bytes = join(
    box("ftyp", encode.encode("isom\u0000\u0000\u0000\u0000isom")),
    box("mdat", new Uint8Array(100_000)),
    box("moov", join(track(avc1), track(mp4a))),
  );

  const inspected = await inspectWithReads(bytes);
  expect(inspected.result).toEqual({
    mediaType: "video/mp4",
    container: "mp4",
    codecs: ["avc1.640032", "mp4a.40.2"],
  });
  const windows = new Set(
    inspected.reads.flatMap((interval) => {
      const result: number[] = [];
      for (
        let start = Math.floor(interval.startInclusive / 65_536) * 65_536;
        start <= interval.endInclusive;
        start += 65_536
      )
        result.push(start);
      return result;
    }),
  );
  expect(inspected.reads.length).toBeGreaterThan(windows.size);
  expect(windows.size).toBeLessThanOrEqual(4);
});

it("实际 AVC+AAC inspector 经 production Application seam 只验证一个 proof frame", async () => {
  const bytes = avcAacFixtureAcrossMany64KiBRegions();
  const direct = await inspectWithReads(bytes);
  expect(direct.result).toMatchObject({
    mediaType: "video/mp4",
    codecs: ["avc1.640032", "mp4a.40.2"],
  });
  expect(
    direct.reads.reduce(
      (total, interval) =>
        total + interval.endInclusive - interval.startInclusive + 1,
      0,
    ),
  ).toBeLessThanOrEqual(262_144);
  expect(
    new Set(
      direct.reads.map((interval) =>
        Math.floor(interval.startInclusive / 1_048_576),
      ),
    ).size,
  ).toBe(1);
  expect(
    new Set(
      direct.reads.map((interval) =>
        Math.floor(interval.startInclusive / 65_536),
      ),
    ).size,
  ).toBeGreaterThan(4);
  const host = new ExecutionHost();
  const metrics = {
    sourceOpens: 0,
    manifestOpens: 0,
    frameChecks: 0,
    frameReadCalls: 0,
    frameBytes: 0,
  };
  const access = applicationPlaybackAccess(bytes, host, metrics);

  await expect(
    access.planPlayback(
      { artifactRevisionId: "revision-real-structure" },
      {
        contractVersion: "consumer-playback/1",
        supportsByteRanges: true,
        media: [{ mediaType: "video/mp4", codecs: [] }],
      },
      {},
    ),
  ).resolves.toMatchObject({
    status: "ready",
    rendition: {
      kind: "direct",
      mediaType: "video/mp4",
      codecs: ["avc1.640032", "mp4a.40.2"],
    },
  });
  expect(metrics).toEqual({
    sourceOpens: 3,
    manifestOpens: 1,
    frameChecks: 1,
    frameReadCalls: 1,
    frameBytes: bytes.byteLength,
  });
  await expect(host.close()).resolves.toBeUndefined();
});

function avcAacFixtureAcrossMany64KiBRegions(): Uint8Array {
  const encode = new TextEncoder();
  const box = (type: string, payload: Uint8Array) => {
    const result = new Uint8Array(8 + payload.byteLength);
    new DataView(result.buffer).setUint32(0, result.byteLength);
    result.set(encode.encode(type), 4);
    result.set(payload, 8);
    return result;
  };
  const join = (...parts: Uint8Array[]) => {
    const result = new Uint8Array(
      parts.reduce((sum, part) => sum + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  };
  const stsd = (entry: Uint8Array) => {
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(4, 1);
    return box("stsd", join(header, entry));
  };
  const track = (entry: Uint8Array) =>
    box("trak", box("mdia", box("minf", box("stbl", stsd(entry)))));
  const avc1 = box(
    "avc1",
    join(new Uint8Array(78), box("avcC", new Uint8Array([1, 0x64, 0, 0x32]))),
  );
  const mp4a = box(
    "mp4a",
    join(
      new Uint8Array(28),
      box("esds", new Uint8Array([0, 0, 0, 0, 0x05, 0x02, 0x12, 0x10])),
    ),
  );
  return join(
    box("ftyp", encode.encode("isom\u0000\u0000\u0000\u0000isom")),
    ...Array.from({ length: 6 }, () => box("free", new Uint8Array(70_000))),
    box("moov", join(track(avc1), track(mp4a))),
  );
}

function applicationPlaybackAccess(
  bytes: Uint8Array,
  host: ExecutionHost,
  metrics: {
    sourceOpens: number;
    manifestOpens: number;
    frameChecks: number;
    frameReadCalls: number;
    frameBytes: number;
  },
) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const proof: ArtifactContentProofMetadata = {
    blobDigest: digest,
    scheme: "artifact-frame-manifest/1",
    byteLength: bytes.byteLength,
    frameSize: 1_048_576,
    frameCount: 1,
    manifestDigest: "d".repeat(64),
  };
  return new ApplicationArtifactByteAccess({
    persistence: {
      async readArtifactRevisionAccessFacts() {
        return {
          revision: {
            id: "revision-real-structure",
            artifactId: "artifact-real-structure",
            blobDigest: digest,
          },
          blob: {
            digest,
            byteLength: bytes.byteLength,
            mediaType: "application/octet-stream",
          },
          locations: [
            {
              kind: "managed" as const,
              locationId: "managed-real-structure",
              address: "private-real-structure",
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
        metrics.sourceOpens += 1;
        const source: ArtifactByteSource = {
          byteLength: bytes.byteLength,
          async readChunk(offset, maximumBytes) {
            const chunk = bytes.slice(offset, offset + maximumBytes);
            metrics.frameReadCalls += 1;
            metrics.frameBytes += chunk.byteLength;
            return {
              bytes: chunk,
              done: offset + chunk.byteLength >= bytes.byteLength,
            };
          },
          async close() {},
        };
        return { source, suggestedFilename: "opaque.bin" };
      },
    },
    proofStore: {
      async inspect() {},
      async build() {
        throw new Error("not reached");
      },
      async open() {
        metrics.manifestOpens += 1;
        return {
          async expectedFrameDigest() {
            metrics.frameChecks += 1;
            const coordinate = Buffer.alloc(20);
            coordinate.writeBigUInt64BE(0n, 0);
            coordinate.writeBigUInt64BE(0n, 8);
            coordinate.writeUInt32BE(bytes.byteLength, 16);
            return createHash("sha256")
              .update(Buffer.from("digital-artifact-frame-v1\0", "utf8"))
              .update(coordinate)
              .update(bytes)
              .digest();
          },
          async close() {},
        };
      },
    },
    executionHost: host,
    playbackInspector: boundedPlaybackFormatInspector,
  });
}
