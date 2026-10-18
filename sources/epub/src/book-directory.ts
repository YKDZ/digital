import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  type ArtifactFormatInspector,
  type AssetRefreshWorkPlan,
  type DirectoryInterpreter,
  type FilesystemPackageSnapshot,
  type RecognitionCandidateContext,
  type Recognizer,
} from "@digital/application";
import type {
  CapabilityCoordinate,
  RecognitionEvidence,
  RecognitionProposalDraft,
} from "@digital/domain";

const directoryCapability = declareCapability({
  identity: "book.same-name-directory",
  implementationVersion: "3",
  kind: "directory-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const recognizerCapability = declareCapability({
  identity: "book.local-directory-recognizer",
  implementationVersion: "2",
  kind: "recognizer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const imageInspectorCapability = declareCapability({
  identity: "book.cover-image-inspection",
  implementationVersion: "1",
  kind: "artifact-format-inspector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

export const trustedBookLocalDirectoryRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "book.same-name-directory-with-valid-publication",
  ruleVersion: "2",
} as const;

/** 路径只提出范围；可解析正文由本地识别规则另行确认。 */
export class BookDirectoryInterpreter implements DirectoryInterpreter {
  readonly capability = directoryCapability;

  interpret(
    snapshot: FilesystemPackageSnapshot,
  ): AssetRefreshWorkPlan | readonly RecognitionEvidence[] {
    const roots = new Map<string, string[]>();
    for (const file of snapshot.files) {
      if (!/\.(?:epub|pdf)$/iu.test(file.relativePath)) continue;
      const root = parentPath(file.relativePath);
      const publications = roots.get(root) ?? [];
      publications.push(file.relativePath);
      roots.set(root, publications);
    }
    const workItems = [...roots].flatMap(([relativeRoot, publications]) => {
      const name = baseName(
        relativeRoot === "." ? snapshot.root : relativeRoot,
      );
      if (
        publications.some(
          (reference) => baseName(reference).replace(/\.[^.]+$/u, "") !== name,
        )
      )
        return [];
      const prefix = relativeRoot === "." ? "" : `${relativeRoot}/`;
      const relativePaths = snapshot.files
        .filter((file) => file.relativePath.startsWith(prefix))
        .map((file) => file.relativePath)
        .toSorted();
      const covers = relativePaths.filter(
        (reference) =>
          parentPath(reference) === relativeRoot &&
          /^cover\.(?:jpg|png)$/u.test(baseName(reference)),
      );
      return [
        {
          key: `book:directory:${relativeRoot}`,
          relativePaths,
          materialBoundary: {
            kind: "directory" as const,
            relativePath: relativeRoot,
          },
          observedArtifactAssociations: [
            ...relativePaths.map((reference) => ({
              observedArtifactReference: reference,
              role: "asset.material-delivered",
            })),
            // 由书籍规则自己声明哪几份是这一册的代表正文；核心不解释目录名或格式偏好。
            ...publications.toSorted().map((observedArtifactReference) => ({
              observedArtifactReference,
              role: "asset.representative-body",
              producer: this.capability,
            })),
            // 根封面同时声明两份身份：它自己是一份材料图片，也代表整本书的封面。
            ...covers.flatMap((reference) => [
              {
                observedArtifactReference: reference,
                role: "asset.material-image",
                producer: this.capability,
              },
              {
                observedArtifactReference: reference,
                role: "asset.primary-cover",
                producer: this.capability,
              },
            ]),
          ],
          evidence: [
            {
              kind: "book.same-name-directory/v1",
              explanation: "目录与直接正文同名，提出一册书籍的持续材料范围",
              producer: this.capability,
            },
          ],
        },
      ];
    });
    return workItems.length === 0 ? [] : { workItems };
  }
}

/** 固定封面名只限制检查入口；是否为书籍封面仍由已接受目录声明决定。 */
export class BookImageInspector implements ArtifactFormatInspector {
  readonly capability = imageInspectorCapability;

  async inspect(
    input: Parameters<ArtifactFormatInspector["inspect"]>[0],
  ): Promise<readonly RecognitionEvidence[]> {
    if (
      !/^cover\.(?:jpg|png)$/u.test(baseName(input.byteSource.logicalLocation))
    )
      return [];
    if (input.byteSource.byteLength > 32 * 1024 * 1024) return [];
    const bytes = await input.byteSource.read();
    const png =
      bytes.length >= 33 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, index) => bytes[index] === value,
      ) &&
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        8,
      ) === 13 &&
      String.fromCharCode(...bytes.slice(12, 16)) === "IHDR" &&
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        16,
      ) > 0 &&
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        20,
      ) > 0;
    const jpeg = jpegHasImageFrame(bytes);
    if (!png && !jpeg) return [];
    return [
      {
        kind: "artifact-format-inspection",
        explanation: "已核对封面文件的图片格式头与完整字节摘要",
        producer: this.capability,
        inspection: {
          observedArtifactReference: input.observedArtifactReference,
          identifiers: [],
          metadata: [],
          parts: [],
          revision: {
            digest: createHash("sha256").update(bytes).digest("hex"),
            byteLength: bytes.byteLength,
            mediaType: png ? "image/png" : "image/jpeg",
          },
        },
      },
    ];
  }
}

function jpegHasImageFrame(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return false;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    )
      return (
        length >= 8 &&
        (((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0)) > 0 &&
        (((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)) > 0
      );
    offset += length;
  }
  return false;
}

export class BookLocalPublicationRecognizer implements Recognizer {
  readonly capability = recognizerCapability;

  canRecognize(input: RecognitionCandidateContext): boolean {
    if (
      input.basis.kind !== "observed-evidence" ||
      !sameCapability(input.basis.producer, directoryCapability) ||
      input.basis.materialBoundary?.kind !== "directory"
    )
      return false;
    const relativeRoot = input.basis.materialBoundary.relativePath;
    const basis = input.basis;
    const directoryEvidence = input.evidence.filter(
      (evidence) =>
        evidence.kind === "book.same-name-directory/v1" &&
        sameCapability(evidence.producer, directoryCapability),
    );
    return (
      directoryEvidence.length === 1 &&
      input.evidence.some((evidence) => {
        const inspection = evidence.inspection;
        if (
          evidence.kind !== "artifact-format-inspection" ||
          inspection === undefined ||
          parentPath(inspection.observedArtifactReference) !== relativeRoot ||
          !validPublicationInspection(evidence)
        )
          return false;
        return basis.artifactRevisions.some(
          (revision) =>
            revision.observedArtifactReference ===
              inspection.observedArtifactReference &&
            revision.blob.digest === inspection.revision.digest &&
            revision.blob.mediaType === inspection.revision.mediaType &&
            revision.blob.byteLength === inspection.revision.byteLength &&
            sameCapability(revision.producer, evidence.producer),
        );
      })
    );
  }

  recognize(input: RecognitionCandidateContext): RecognitionProposalDraft {
    if (!this.canRecognize(input))
      throw new Error("书籍目录本地准入需要同名范围和可解析正文的精确修订依据");
    return {
      id: `recognition-proposal_${randomUUID()}`,
      ruleResults: [
        {
          ...trustedBookLocalDirectoryRule,
          outcome: "satisfied",
          explanation:
            "同名目录内存在可解析的 EPUB／PDF 正文，形成一项本地书籍内容",
          evidence: input.evidence,
        },
      ],
    };
  }
}

function validPublicationInspection(evidence: RecognitionEvidence): boolean {
  const inspection = evidence.inspection;
  if (inspection === undefined || evidence.producer.contractVersion !== "2")
    return false;
  return (
    (evidence.producer.capabilityId === "epub.publication-inspection" &&
      evidence.producer.capabilityVersion === "3" &&
      /\.epub$/iu.test(inspection.observedArtifactReference) &&
      inspection.revision.mediaType === "application/epub+zip") ||
    (evidence.producer.capabilityId === "pdf.publication-inspection" &&
      evidence.producer.capabilityVersion === "2" &&
      /\.pdf$/iu.test(inspection.observedArtifactReference) &&
      inspection.revision.mediaType === "application/pdf")
  );
}

function sameCapability(
  actual: CapabilityCoordinate,
  expected: CapabilityCoordinate,
): boolean {
  return (
    actual.capabilityId === expected.capabilityId &&
    actual.capabilityVersion === expected.capabilityVersion &&
    actual.contractVersion === expected.contractVersion
  );
}

function baseName(value: string): string {
  return value.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
}

function parentPath(value: string): string {
  return value.split("/").slice(0, -1).join("/") || ".";
}
