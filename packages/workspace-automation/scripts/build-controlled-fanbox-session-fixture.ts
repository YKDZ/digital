import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

import {
  controlledSourceIoFormatVersion,
  fanboxPrivateContextIdentity,
  loadControlledSourceIo,
  type ControlledRequestEntryInput,
  type ControlledSessionEntryInput,
} from "@digital/test-support/source-io";

import { requireInput } from "./inputs.ts";

/**
 * 受控 FANBOX 会话夹具的维护脚本：写出缩减资料、封闭端点响应字节、合成凭据与各份清单，
 * 并打印每份清单的内容身份。输出完全确定，因此内容身份只在清单文本或响应字节改动后变化。
 *
 * 帖子事实（创作者、postId、发布时间、标题、形态、封面存在）来自
 * `expectations/customudon-7225781.reviewed-oracle.json` 记录的独立审阅结论；
 * 其余字段只是既有解析契约要求的协议代表值，见本目录 README。
 */
const fixtureDirectory = requireInput("DIGITAL_AUTOMATION_OUTPUT_DIRECTORY");

const creatorId = "customudon";
const postId = "7225781";
const publishedDatetime = "2023-12-31T17:10:55+09:00";
const postTitle = "Movie | コスプレ4";
/** 缩减后的资料目录名：真实根的父目录含空格，改为独立 oracle 已确认的 creatorId。 */
const dateDirectory = "23.12.31 コスプレ4";
const reducedVideo = path.join(
  "material",
  creatorId,
  dateDirectory,
  "Season 1",
  "S01E01 - Cosplay4.mp4",
);
const coverAddress = `https://downloads.fanbox.cc/images/post/${postId}/controlled-cover.png`;
const attachmentAddress = `https://downloads.fanbox.cc/files/post/${postId}/S01E01.mp4`;

/** 合成凭据：只满足既有形状校验，没有任何真实登录能力，也不得出现在 UI 或日志中。 */
const syntheticCredential = {
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/999.0.0.0 Safari/537.36 digital-controlled-fanbox-synthetic",
  cookies: [
    {
      name: "FANBOXSESSID",
      value: "synthetic-controlled-session-not-a-real-credential",
      domain: ".fanbox.cc" as const,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax" as const,
      expires: 1_893_456_000,
    },
  ],
};

/** 与来源实现相同的规范化串；清单只声明它的摘要，不重复凭据本身。 */
const privateContextIdentity = fanboxPrivateContextIdentity({
  format: "fanbox-browser-request-context/2",
  userAgent: syntheticCredential.userAgent,
  cookies: syntheticCredential.cookies,
});

const summaryPost = {
  id: postId,
  creatorId,
  title: postTitle,
  publishedDatetime,
  type: "file",
  feeRequired: 0,
};

/** 缩减的创作者摘要：只保留实际走到的分支，不声称完整创作者历史。 */
function summariesResponse(): string {
  return `${JSON.stringify({ body: { posts: [summaryPost] } })}\n`;
}

/** 详情声明 `file` 形态，因此按既有契约给出一个附件与一个规范封面地址。 */
function detailResponse(): string {
  return `${JSON.stringify({
    body: {
      post: {
        ...summaryPost,
        coverImageUrl: coverAddress,
        user: { name: "Custom Udon" },
        body: {
          files: [
            {
              id: "f1",
              name: "S01E01 - Cosplay4.mp4",
              size: reducedVideoPayload.length,
              extension: "mp4",
              url: attachmentAddress,
            },
          ],
        },
      },
    },
  })}\n`;
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

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

/**
 * 缩减资料的载荷：结构正确的最小 MP4 盒序列（ftyp + mdat）。它不是可播放视频，
 * 也不是原帖附件字节，只服务目录观察与准入。
 */
function buildReducedVideoPayload(): Buffer {
  const ftyp = Buffer.alloc(12);
  ftyp.write("isom", 0, "ascii");
  ftyp.writeUInt32BE(512, 4);
  ftyp.write("isom", 8, "ascii");
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
    ftyp.subarray(0, 8),
    ftyp,
    box("mdat", Buffer.from("digital-controlled-fanbox-reduced-payload")),
  ]);
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
      row[3 + x * 4] = 255;
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

const reducedVideoPayload = buildReducedVideoPayload();

const mediaTargets: readonly {
  readonly relative: string;
  readonly bytes: Buffer;
}[] = [
  { relative: reducedVideo, bytes: reducedVideoPayload },
  { relative: path.join("responses", "fanbox-cover.png"), bytes: pngCover() },
];

const responseTargets: readonly {
  readonly relative: string;
  readonly text: string;
}[] = [
  {
    relative: path.join("responses", "fanbox-login-status.json"),
    text: `${JSON.stringify({ body: 0 })}\n`,
  },
  {
    relative: path.join("responses", "fanbox-verify-summaries.json"),
    text: summariesResponse(),
  },
  {
    relative: path.join("responses", "fanbox-collect-summaries.json"),
    text: summariesResponse(),
  },
  {
    relative: path.join("responses", "fanbox-post-detail.json"),
    text: detailResponse(),
  },
  {
    relative: path.join("connections", "synthetic-customudon.json"),
    text: `${JSON.stringify(syntheticCredential, undefined, 2)}\n`,
  },
];

const ordinary: readonly ControlledRequestEntryInput[] = [
  {
    id: "fanbox-cover-image",
    url: coverAddress,
    method: "GET",
    status: 200,
    mediaType: "image/png",
    responseFile: "responses/fanbox-cover.png",
  },
];

/**
 * 每条会话条目都声明它服务的合成上下文摘要：摘要属于请求键的一部分，因此错误上下文
 * 无法借用任何响应字节，内容身份也随声明变化。
 */
function controlledSessionEntries(
  declaredPrivateContextIdentity: string,
  declaredCreatorId = creatorId,
): readonly ControlledSessionEntryInput[] {
  return [
    {
      id: "fanbox-login-status",
      creatorId: declaredCreatorId,
      endpoint: "login-status",
      privateContextIdentity: declaredPrivateContextIdentity,
      status: 200,
      mediaType: "application/json",
      responseFile: "responses/fanbox-login-status.json",
    },
    {
      id: "fanbox-verify-summaries",
      creatorId: declaredCreatorId,
      endpoint: "creator-summaries",
      limit: 1,
      privateContextIdentity: declaredPrivateContextIdentity,
      status: 200,
      mediaType: "application/json",
      responseFile: "responses/fanbox-verify-summaries.json",
    },
    {
      id: "fanbox-collect-summaries",
      creatorId: declaredCreatorId,
      endpoint: "creator-summaries",
      limit: 300,
      privateContextIdentity: declaredPrivateContextIdentity,
      status: 200,
      mediaType: "application/json",
      responseFile: "responses/fanbox-collect-summaries.json",
    },
    {
      id: "fanbox-post-detail",
      creatorId: declaredCreatorId,
      endpoint: "post-detail",
      postId,
      access: "connected",
      privateContextIdentity: declaredPrivateContextIdentity,
      status: 200,
      mediaType: "application/json",
      responseFile: "responses/fanbox-post-detail.json",
    },
  ];
}

const session = controlledSessionEntries(privateContextIdentity);
const successManifest = {
  formatVersion: controlledSourceIoFormatVersion,
  ordinary,
  session,
};

/** 删掉成功链路上的一条必需响应；同名 id 只出现一次。 */
function without(id: string): readonly ControlledSessionEntryInput[] {
  return session.filter((entry) => entry.id !== id);
}

/** 反例清单：逐个删掉成功链路必需的一条响应，或把公开与已连接、创作者与上下文混用。 */
const variants: readonly {
  readonly file: string;
  readonly document: unknown;
}[] = [
  { file: "manifest.json", document: successManifest },
  {
    // 09-1：保留全部普通请求，只删会话集合；配置验证必须失败。
    file: "manifest-without-session.json",
    document: {
      formatVersion: controlledSourceIoFormatVersion,
      ordinary,
    },
  },
  {
    // 09-3：缺少连接验证第一步的 login-status；连接无法被产品验证。
    file: "manifest-without-login-status.json",
    document: { ...successManifest, session: without("fanbox-login-status") },
  },
  {
    // 09-3：缺少 limit=1 的验证摘要；验证无法取得待核对的帖子。
    file: "manifest-without-verify-summaries.json",
    document: {
      ...successManifest,
      session: without("fanbox-verify-summaries"),
    },
  },
  {
    // 09-3：connected 详情是验证与采集共同的封闭端点键；缺少它两条链路都不成立。
    file: "manifest-without-post-detail.json",
    document: { ...successManifest, session: without("fanbox-post-detail") },
  },
  {
    // 09-3：缺少 limit=300 的采集摘要；验证成功但采集无法形成帖子。
    file: "manifest-without-collect-summaries.json",
    document: {
      ...successManifest,
      session: without("fanbox-collect-summaries"),
    },
  },
  {
    // 09-3/09-4：会话全成功，但独立图片请求没有条目。
    file: "manifest-without-cover-image.json",
    document: { ...successManifest, ordinary: [] },
  },
  {
    // 09-3：connected 与 public 是两个键；只给公开详情时不能借用已连接响应。
    file: "manifest-public-detail-only.json",
    document: {
      ...successManifest,
      session: session.map((entry) =>
        entry.endpoint === "post-detail"
          ? {
              ...entry,
              id: "fanbox-post-detail-public",
              access: "public" as const,
            }
          : entry,
      ),
    },
  },
  {
    // 09-3：清单声明的合成上下文与产品实际使用的不同，事务整体被拒。
    file: "manifest-mismatched-context.json",
    document: {
      ...successManifest,
      session: controlledSessionEntries(
        fanboxPrivateContextIdentity({
          format: "fanbox-browser-request-context/2",
          userAgent: syntheticCredential.userAgent,
          cookies: [
            {
              ...syntheticCredential.cookies[0]!,
              value: "synthetic-controlled-session-substituted",
            },
          ],
        }),
      ),
    },
  },
  {
    // 09-3：清单声明的创作者范围与产品导入的连接不同，属于未知创作者范围。
    file: "manifest-other-creator.json",
    document: {
      ...successManifest,
      session: controlledSessionEntries(
        privateContextIdentity,
        "customudon-other",
      ),
    },
  },
  {
    // 09-3：只有详情条目声明另一个创作者；login 与摘要仍属 customudon，
    // 因此错配必须落在详情这一条边界上，而不是被更早的步骤挡住。
    file: "manifest-detail-creator-mismatch.json",
    document: {
      ...successManifest,
      session: session.map((entry) =>
        entry.endpoint === "post-detail"
          ? { ...entry, creatorId: "customudon-other" }
          : entry,
      ),
    },
  },
  {
    // 09-3：公开详情同样受声明创作者范围约束；只换该条目的创作者声明。
    file: "manifest-public-detail-creator-mismatch.json",
    document: {
      ...successManifest,
      session: session.map((entry) =>
        entry.endpoint === "post-detail"
          ? {
              ...entry,
              id: "fanbox-post-detail-public",
              access: "public" as const,
              creatorId: "customudon-other",
            }
          : entry,
      ),
    },
  },
];

for (const target of [...mediaTargets, ...responseTargets]) {
  const absolute = path.join(fixtureDirectory, target.relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  if ("bytes" in target) await writeFile(absolute, target.bytes);
  else await writeFile(absolute, target.text, "utf8");
}

const identities: Record<string, string> = {};
for (const variant of variants) {
  const manifestPath = path.join(fixtureDirectory, variant.file);
  await writeFile(
    manifestPath,
    `${JSON.stringify(variant.document, undefined, 2)}\n`,
    "utf8",
  );
  identities[variant.file] = (
    await loadControlledSourceIo({ manifestPath })
  ).contentIdentity;
}

process.stdout.write(
  `${JSON.stringify(
    {
      fixtureDirectory,
      credentialFile: path.join(
        fixtureDirectory,
        "connections",
        "synthetic-customudon.json",
      ),
      privateContextIdentity,
      identities,
    },
    undefined,
    2,
  )}\n`,
);
