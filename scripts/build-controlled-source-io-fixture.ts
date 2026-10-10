import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { loadControlledSourceIo } from "../packages/test-support/src/source-io.ts";

/**
 * 受控外部来源 I/O 夹具的生成器：把轻量的合成媒体写进夹具目录，并给出清单的内容身份。
 * 输出完全确定，因此内容身份只有在清单文本或响应字节被改动后才会变化。
 */
const fixtureDirectory = path.resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "controlled-source-io",
);

const workTitle =
  "塩対応な義妹ちゃん、大好きな兄さんの濃厚快感責めでメロ堕ち♡〜逆転イチャあま同棲ASMR〜";

/** 语料根内 `01_本編` 的第一轨原名；字节全部由本脚本合成，不复制原始音频。 */
const reducedTrack = path.join(
  "material",
  "RJ01668691",
  workTitle,
  "01_本編",
  "01_おかえり、兄さん…別に待ってないけど.wav",
);

const sampleRate = 8000;
const sampleCount = 2000;

function pcmWav(): Buffer {
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(
      8000 * Math.sin((2 * Math.PI * 440 * index) / sampleRate),
    );
    buffer.writeInt16LE(value, 44 + index * bytesPerSample);
  }
  return buffer;
}

const crcPolynomial = 0xedb88320;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? crcPolynomial ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const chunk = Buffer.alloc(8 + body.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 4 + body.length);
  return chunk;
}

/** 官方主图角色需要的响应字节：一张合法的 8×8 不透明 PNG。 */
function pngCover(): Buffer {
  const width = 8;
  const height = 8;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 4] = (x * 32) % 256;
      row[2 + x * 4] = (y * 32) % 256;
      row[3 + x * 4] = 128;
      row[4 + x * 4] = 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets: readonly {
  readonly relative: string;
  readonly bytes: Buffer;
}[] = [
  { relative: reducedTrack, bytes: pcmWav() },
  { relative: path.join("responses", "dlsite-cover.png"), bytes: pngCover() },
];

for (const target of targets) {
  const absolute = path.join(fixtureDirectory, target.relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, target.bytes);
}

const manifests = ["manifest.json", "manifest-without-cover.json"] as const;
const identities: Record<string, string> = {};
for (const manifest of manifests) {
  const manifestPath = path.join(fixtureDirectory, manifest);
  identities[manifest] = (
    await loadControlledSourceIo({ manifestPath })
  ).contentIdentity;
}
process.stdout.write(
  `${JSON.stringify(
    {
      manifestPath: path.join(fixtureDirectory, "manifest.json"),
      identities,
    },
    undefined,
    2,
  )}\n`,
);
