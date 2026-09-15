import type {
  PlaybackFormatFacts,
  PlaybackFormatInspector,
} from "@digital/application";
import { declareCapability } from "@digital/application";

const probeBytes = 65_536;

/** V1 静态部署的有界媒体格式检查能力。 */
export const boundedPlaybackFormatInspector: PlaybackFormatInspector = {
  capability: declareCapability({
    identity: "digital.playback-format",
    implementationVersion: "1",
    contractVersion: "playback-format-inspector/1",
    kind: "playback-format-inspector",
    interpretationContractVersions: [],
  }),
  async inspect(input) {
    const read = async (start: number, length: number) =>
      await input.bytes.read({
        startInclusive: start,
        endInclusive: start + Math.min(length, probeBytes) - 1,
      });
    return (
      (await inspectWaveFromProbe(read)) ??
      (await inspectMp4FromProbe(read)) ??
      (await inspectMp3FromProbe(read))
    );
  },
};

function mp3Bitrate(version: number, index: number): number | undefined {
  const mpeg1 = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ];
  const mpeg2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  return (version === 3 ? mpeg1 : mpeg2)[index];
}

function mp3SampleRate(version: number, index: number): number | undefined {
  const rates =
    version === 3
      ? [44_100, 48_000, 32_000]
      : version === 2
        ? [22_050, 24_000, 16_000]
        : [11_025, 12_000, 8_000];
  return rates[index];
}

type ProbeRead = (start: number, length: number) => Promise<Uint8Array>;

async function inspectMp3FromProbe(
  read: ProbeRead,
): Promise<PlaybackFormatFacts | undefined> {
  const prefix = await read(0, 10);
  let offset = 0;
  if (ascii(prefix, 0, 3) === "ID3") {
    if (prefix.byteLength < 10) return undefined;
    const sizeBytes = prefix.slice(6, 10);
    if (sizeBytes.some((value) => (value & 0x80) !== 0)) return undefined;
    offset =
      10 +
      ((sizeBytes[0]! << 21) |
        (sizeBytes[1]! << 14) |
        (sizeBytes[2]! << 7) |
        sizeBytes[3]!) +
      ((prefix[5]! & 0x10) === 0 ? 0 : 10);
  }
  const header = await read(offset, 4);
  const frameLength = mp3FrameLength(header);
  if (frameLength === undefined) return undefined;
  const frame = await read(offset, frameLength);
  return frame.byteLength === frameLength
    ? { mediaType: "audio/mpeg", container: "mp3", codecs: ["mp3"] }
    : undefined;
}

function mp3FrameLength(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 4) return undefined;
  const first = bytes[0]!;
  const second = bytes[1]!;
  const third = bytes[2]!;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return undefined;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleRateIndex = (third >> 2) & 0x03;
  if (
    version === 1 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  )
    return undefined;
  const bitrate = mp3Bitrate(version, bitrateIndex);
  const sampleRate = mp3SampleRate(version, sampleRateIndex);
  if (bitrate === undefined || sampleRate === undefined) return undefined;
  return (
    Math.floor(((version === 3 ? 144 : 72) * bitrate * 1_000) / sampleRate) +
    ((third >> 1) & 1)
  );
}

async function inspectWaveFromProbe(
  read: ProbeRead,
): Promise<PlaybackFormatFacts | undefined> {
  const header = await read(0, 12);
  if (
    header.byteLength < 12 ||
    ascii(header, 0, 4) !== "RIFF" ||
    ascii(header, 8, 12) !== "WAVE"
  )
    return undefined;
  const declaredEnd = uint32le(header, 4) + 8;
  if (declaredEnd < 12) return undefined;
  let pcm = false;
  let data = false;
  let offset = 12;
  for (let count = 0; count < 128 && offset + 8 <= declaredEnd; count += 1) {
    const chunk = await read(offset, 8);
    if (chunk.byteLength < 8) return undefined;
    const kind = ascii(chunk, 0, 4);
    const size = uint32le(chunk, 4);
    const start = offset + 8;
    const end = start + size;
    if (end < start || end > declaredEnd) return undefined;
    if (kind === "fmt ") {
      if (size < 16 || size > probeBytes) return undefined;
      const value = await read(start, size);
      if (value.byteLength !== size) return undefined;
      const format = uint16le(value, 0);
      const channels = uint16le(value, 2);
      const sampleRate = uint32le(value, 4);
      const byteRate = uint32le(value, 8);
      const blockAlign = uint16le(value, 12);
      const bits = uint16le(value, 14);
      pcm =
        format === 1 &&
        channels > 0 &&
        sampleRate > 0 &&
        bits > 0 &&
        bits % 8 === 0 &&
        blockAlign === channels * (bits / 8) &&
        byteRate === sampleRate * blockAlign;
    }
    if (kind === "data") {
      data = true;
      break;
    }
    offset = end + (size & 1);
  }
  if (!pcm || !data) return undefined;
  const last = await read(declaredEnd - 1, 1);
  return last.byteLength === 1
    ? { mediaType: "audio/wav", container: "wav", codecs: ["pcm"] }
    : undefined;
}

type ParsedProbeBox = {
  readonly type: string;
  readonly payloadStart: number;
  readonly end: number;
};

async function inspectMp4FromProbe(
  read: ProbeRead,
): Promise<PlaybackFormatFacts | undefined> {
  let offset = 0;
  let ftyp = false;
  for (let count = 0; count < 128; count += 1) {
    const box = await probeBox(read, offset, Number.MAX_SAFE_INTEGER);
    if (box === undefined) return undefined;
    if (box.type === "ftyp") {
      const brands = await read(
        box.payloadStart,
        Math.min(16, box.end - box.payloadStart),
      );
      if (brands.byteLength < 8) return undefined;
      ftyp = true;
    }
    if (box.type === "moov") {
      if (!ftyp) return undefined;
      const codecs = await codecsFromProbeContainer(
        read,
        box.payloadStart,
        box.end,
        0,
      );
      if (codecs === undefined || codecs.length === 0) return undefined;
      const ordered = [...new Set(codecs)].toSorted();
      return {
        mediaType: ordered.some(
          (codec) => codec.startsWith("avc1.") || codec.startsWith("avc3."),
        )
          ? "video/mp4"
          : "audio/mp4",
        container: "mp4",
        codecs: ordered,
      };
    }
    if (box.end <= offset) return undefined;
    offset = box.end;
  }
  return undefined;
}

async function codecsFromProbeContainer(
  read: ProbeRead,
  start: number,
  end: number,
  depth: number,
): Promise<string[] | undefined> {
  if (depth > 6) return undefined;
  const result: string[] = [];
  let offset = start;
  for (let count = 0; count < 256 && offset < end; count += 1) {
    const box = await probeBox(read, offset, end);
    if (box === undefined) return undefined;
    if (["moov", "trak", "mdia", "minf", "stbl"].includes(box.type)) {
      const nested = await codecsFromProbeContainer(
        read,
        box.payloadStart,
        box.end,
        depth + 1,
      );
      if (nested === undefined) return undefined;
      result.push(...nested);
    } else if (box.type === "stsd") {
      const nested = await codecsFromProbeStsd(read, box.payloadStart, box.end);
      if (nested === undefined) return undefined;
      result.push(...nested);
    }
    offset = box.end;
  }
  return offset === end ? result : undefined;
}

async function codecsFromProbeStsd(
  read: ProbeRead,
  start: number,
  end: number,
): Promise<string[] | undefined> {
  const header = await read(start, 8);
  if (header.byteLength < 8) return undefined;
  const count = uint32be(header, 4);
  let offset = start + 8;
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = await probeBox(read, offset, end);
    if (entry === undefined) return undefined;
    if (entry.type === "avc1" || entry.type === "avc3") {
      const child = await findProbeChild(read, offset + 86, entry.end, "avcC");
      if (child === undefined) return undefined;
      const config = await read(child.payloadStart, 4);
      if (config.byteLength < 4 || config[0] !== 1) return undefined;
      result.push(
        `${entry.type}.${hexByte(config[1]!)}${hexByte(config[2]!)}${hexByte(config[3]!)}`,
      );
    } else if (entry.type === "mp4a") {
      const child = await findProbeChild(read, offset + 36, entry.end, "esds");
      if (child === undefined || child.end - child.payloadStart > probeBytes)
        return undefined;
      const esds = await read(
        child.payloadStart,
        child.end - child.payloadStart,
      );
      const config = findAacConfig(esds, 4, esds.byteLength);
      if (config === undefined) return undefined;
      result.push(`mp4a.40.${config}`);
    } else return undefined;
    offset = entry.end;
  }
  return offset === end ? result : undefined;
}

async function findProbeChild(
  read: ProbeRead,
  start: number,
  end: number,
  type: string,
): Promise<ParsedProbeBox | undefined> {
  let offset = start;
  for (let count = 0; count < 64 && offset < end; count += 1) {
    const box = await probeBox(read, offset, end);
    if (box === undefined) return undefined;
    if (box.type === type) return box;
    offset = box.end;
  }
  return undefined;
}

async function probeBox(
  read: ProbeRead,
  offset: number,
  enclosingEnd: number,
): Promise<ParsedProbeBox | undefined> {
  const header = await read(offset, 16);
  if (header.byteLength < 8) return undefined;
  const size32 = uint32be(header, 0);
  const type = ascii(header, 4, 8);
  let headerLength = 8;
  let size = size32;
  if (size32 === 1) {
    if (header.byteLength < 16) return undefined;
    const high = uint32be(header, 8);
    const low = uint32be(header, 12);
    size = high * 2 ** 32 + low;
    headerLength = 16;
  }
  if (
    size === 0 ||
    !Number.isSafeInteger(size) ||
    size < headerLength ||
    offset + size > enclosingEnd
  )
    return undefined;
  return {
    type,
    payloadStart: offset + headerLength,
    end: offset + size,
  };
}

function findAacConfig(
  bytes: Uint8Array,
  start: number,
  end: number,
): number | undefined {
  for (let offset = start; offset + 2 < end; offset += 1) {
    if (bytes[offset] !== 0x05) continue;
    let length = 0;
    let cursor = offset + 1;
    for (let count = 0; count < 4 && cursor < end; count += 1) {
      const value = bytes[cursor++]!;
      length = (length << 7) | (value & 0x7f);
      if ((value & 0x80) === 0) {
        if (length < 2 || cursor + length > end) return undefined;
        const objectType = bytes[cursor]! >> 3;
        return objectType === 2 ? 2 : undefined;
      }
    }
  }
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, false);
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}
