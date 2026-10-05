import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  type ArtifactFormatInspector,
  type ObservedArtifactPartAcquirer,
  type ObservedByteSource,
  type RecognitionCandidateContext,
  type Recognizer,
} from "@digital/application";
import type {
  CapabilityCoordinate,
  ObservedArtifactPartCandidate,
  RecognitionEvidence,
  RecognitionProposalDraft,
} from "@digital/domain";
import { createCanvas } from "@napi-rs/canvas";
import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import {
  InvalidPDFException,
  PasswordException,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

const maximumArtifactBytes = 64 * 1024 * 1024;
const maximumPages = 2_000;
const maximumRenderedPixels = 6_000_000;
const maximumRenderedLongEdge = 2_048;
const maximumRenderedBytes = 16 * 1024 * 1024;
const maximumMetadataValueBytes = 1024 * 1024;
const maximumMetadataTotalBytes = 8 * 1024 * 1024;

const inspectorCapability = declareCapability({
  identity: "pdf.publication-inspection",
  implementationVersion: "2",
  kind: "artifact-format-inspector",
  contractVersion: "2",
  interpretationContractVersions: ["2"],
});
const recognizerCapability = declareCapability({
  identity: "pdf.local-publication-recognizer",
  implementationVersion: "2",
  kind: "recognizer",
  contractVersion: "2",
  interpretationContractVersions: ["2"],
});
const acquirerCapability = declareCapability({
  identity: "pdf.first-page-cover-acquirer",
  implementationVersion: "2",
  kind: "observed-artifact-part-acquirer",
  contractVersion: "2",
  interpretationContractVersions: ["2"],
});

export const trustedPdfLocalPublicationRule = {
  capabilityId: recognizerCapability.capabilityId,
  capabilityVersion: recognizerCapability.capabilityVersion,
  ruleId: "pdf.valid-single-publication-revision",
  ruleVersion: "2",
} as const;

export type PdfRecognitionCapabilities = Readonly<{
  formatInspectors: readonly [ArtifactFormatInspector];
  recognizers: readonly [Recognizer];
  observedArtifactPartAcquirers: readonly [ObservedArtifactPartAcquirer];
}>;

export function createPdfRecognitionCapabilities(): PdfRecognitionCapabilities {
  return {
    formatInspectors: [new PdfPublicationInspector()],
    recognizers: [new PdfLocalPublicationRecognizer()],
    observedArtifactPartAcquirers: [new PdfFirstPageCoverAcquirer()],
  };
}

class PdfPublicationInspector implements ArtifactFormatInspector {
  readonly capability = inspectorCapability;

  async inspect(input: {
    readonly observedArtifactReference: string;
    readonly byteSource: ObservedByteSource;
  }): Promise<readonly RecognitionEvidence[]> {
    const declared = input.byteSource.logicalLocation
      .toLowerCase()
      .endsWith(".pdf");
    const header = hasPdfHeader(
      (await input.byteSource.readChunk(0, 1_024)).bytes,
    );
    if (!declared && !header) return [];
    if (input.byteSource.byteLength > maximumArtifactBytes)
      throw new Error("resource-limit:artifact-bytes");
    const bytes = await input.byteSource.read();
    if (bytes.byteLength > maximumArtifactBytes)
      throw new Error("resource-limit:artifact-bytes");
    if (!header) throw new Error("damaged-pdf");

    let document: PDFDocumentProxy | undefined;
    let loading: ReturnType<typeof getDocument> | undefined;
    try {
      loading = getDocument(pdfDocumentOptions(bytes));
      document = await loading.promise;
      if (document.numPages > maximumPages)
        throw new Error("resource-limit:pages");
      const metadata = await document.getMetadata();
      enforceMetadataBudgets(metadata.info, metadata.metadata);
      const infoTitle = metadataText(metadata.info, "Title");
      const xmpTitleCandidates = xmpCandidates(metadata.metadata, "title");
      const xmpTitleCandidate =
        xmpTitleCandidates.length === 1 ? xmpTitleCandidates[0] : undefined;
      const xmpTitle = metadataTextValue(xmpTitleCandidate?.value);
      const title =
        xmpTitleCandidates.length > 1 ||
        (infoTitle !== undefined &&
          xmpTitle !== undefined &&
          infoTitle !== xmpTitle)
          ? undefined
          : (infoTitle ?? xmpTitle);
      const author = metadataText(metadata.info, "Author");
      return [
        {
          kind: "artifact-format-inspection",
          explanation: "格式检查确认该 PDF 修订版可按本地出版物规则评估",
          producer: this.capability,
          inspection: {
            identifiers: xmpIsbn13s(
              xmpCandidates(metadata.metadata, "identifier"),
            ),
            observedArtifactReference: input.observedArtifactReference,
            revision: {
              digest: createHash("sha256").update(bytes).digest("hex"),
              byteLength: bytes.byteLength,
              mediaType: "application/pdf",
            },
            metadata: [
              {
                property: "pdf.page-count",
                sourceSlot: "pdf.page-count",
                value: String(document.numPages),
                locator: "pdf:catalog/pages",
              },
              ...(title === undefined
                ? []
                : [
                    {
                      property: "asset.title",
                      sourceSlot:
                        infoTitle === undefined
                          ? "pdf.xmp.dc-title"
                          : "pdf.info.title",
                      value: title,
                      locator:
                        infoTitle === undefined
                          ? xmpTitleCandidate!.locator
                          : "pdf:info/Title",
                    },
                  ]),
              ...(author === undefined
                ? []
                : [
                    {
                      property: "pdf.document-author",
                      sourceSlot: "pdf.info.author",
                      value: author,
                      locator: "pdf:info/Author",
                    },
                  ]),
            ],
            parts: [
              {
                role: "asset.material-image",
                locator: "pdf:page[1]",
                mediaType: "image/png",
              },
            ],
          },
        },
      ];
    } catch (error) {
      throw stablePdfFailure(error);
    } finally {
      await loading?.destroy();
    }
  }
}

class PdfLocalPublicationRecognizer implements Recognizer {
  readonly capability = recognizerCapability;

  canRecognize(input: RecognitionCandidateContext): boolean {
    if (
      input.basis.kind !== "observed-evidence" ||
      input.basis.artifactRevisions.length !== 1 ||
      input.evidence.length !== 1
    )
      return false;
    const evidence = input.evidence[0]!;
    const inspection = evidence.inspection;
    const revision = input.basis.artifactRevisions[0]!;
    return (
      evidence.kind === "artifact-format-inspection" &&
      sameCapability(evidence.producer, inspectorCapability) &&
      sameCapability(input.basis.producer, inspectorCapability) &&
      inspection !== undefined &&
      revision.observedArtifactReference ===
        inspection.observedArtifactReference &&
      revision.blob.digest === inspection.revision.digest &&
      revision.blob.byteLength === inspection.revision.byteLength &&
      revision.blob.mediaType === inspection.revision.mediaType &&
      sameCapability(revision.producer, inspectorCapability)
    );
  }

  recognize(input: RecognitionCandidateContext): RecognitionProposalDraft {
    if (!this.canRecognize(input))
      throw new Error("PDF 本地识别只接受格式检查确认的单一出版物修订版");
    const identifiers = input.evidence[0]!.inspection!.identifiers.filter(
      (identifier) =>
        identifier.scheme === "isbn-13" && isValidIsbn13(identifier.value),
    );
    const outcome = identifiers.length === 0 ? "satisfied" : "contradicted";
    return {
      id: `recognition-proposal_${randomUUID()}`,
      ruleResults: [
        {
          ...trustedPdfLocalPublicationRule,
          outcome,
          explanation:
            identifiers.length === 0
              ? "格式检查确认该单一 PDF 修订版是无有效 ISBN 的独立本地出版物边界"
              : identifiers.length === 1
                ? "格式检查发现唯一有效 ISBN，本地无 ISBN 识别规则被反证"
                : `格式检查发现 ${identifiers.length} 个有效 ISBN，本地无 ISBN 识别规则被反证`,
          evidence: input.evidence,
        },
      ],
    };
  }
}

class PdfFirstPageCoverAcquirer implements ObservedArtifactPartAcquirer {
  readonly capability = acquirerCapability;

  canAcquire(candidate: ObservedArtifactPartCandidate): boolean {
    return (
      candidate.role === "asset.material-image" &&
      candidate.locator === "pdf:page[1]" &&
      candidate.mediaType === "image/png" &&
      sameCapability(candidate.producer, inspectorCapability)
    );
  }

  async acquire(input: {
    readonly candidate: ObservedArtifactPartCandidate;
    readonly byteSource: ObservedByteSource;
  }): Promise<{
    readonly candidateId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly origin: {
      readonly digest: string;
      readonly mediaType: string;
      readonly byteLength: number;
    };
  }> {
    if (!this.canAcquire(input.candidate))
      throw new Error("PDF 第一页封面候选不受支持");
    if (input.byteSource.byteLength > maximumArtifactBytes)
      throw new Error("resource-limit:artifact-bytes");
    const bytes = await input.byteSource.read();
    if (bytes.byteLength > maximumArtifactBytes)
      throw new Error("resource-limit:artifact-bytes");
    const origin = {
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: "application/pdf",
    };
    let document: PDFDocumentProxy | undefined;
    let loading: ReturnType<typeof getDocument> | undefined;
    try {
      loading = getDocument(pdfDocumentOptions(bytes));
      document = await loading.promise;
      const page = await document.getPage(1);
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(
        1,
        maximumRenderedLongEdge / Math.max(natural.width, natural.height),
        Math.sqrt(maximumRenderedPixels / (natural.width * natural.height)),
      );
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      if (width * height > maximumRenderedPixels)
        throw new Error("resource-limit:render-pixels");
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({
        canvas: null,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        annotationMode: 0,
        background: "#ffffff",
      }).promise;
      const rendered = canvas.toBuffer("image/png");
      if (rendered.byteLength > maximumRenderedBytes)
        throw new Error("resource-limit:rendered-bytes");
      return {
        candidateId: input.candidate.id,
        bytes: rendered,
        mediaType: "image/png",
        origin,
      };
    } catch (error) {
      throw stablePdfFailure(error);
    } finally {
      await loading?.destroy();
    }
  }
}

function pdfDocumentOptions(bytes: Uint8Array) {
  return {
    data: bytes.slice(),
    stopAtErrors: true,
    useSystemFonts: false,
    isEvalSupported: false,
    enableXfa: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  } as const;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1")
    .decode(bytes.subarray(0, 1_024))
    .includes("%PDF-");
}

function metadataText(info: object, key: string): string | undefined {
  return metadataTextValue(Reflect.get(info, key) as unknown);
}

function metadataTextValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (
    new TextEncoder().encode(normalized).byteLength > maximumMetadataValueBytes
  )
    throw new Error("resource-limit:metadata-value");
  return normalized;
}

function enforceMetadataBudgets(
  info: object,
  metadata: { getRaw(): unknown } | null,
): void {
  const values = Object.values(info).filter(
    (value): value is string => typeof value === "string",
  );
  const rawXmp = metadata?.getRaw();
  if (typeof rawXmp === "string") values.push(rawXmp);
  let total = 0;
  for (const value of values) {
    const length = new TextEncoder().encode(value).byteLength;
    if (length > maximumMetadataValueBytes)
      throw new Error("resource-limit:metadata-value");
    total += length;
  }
  if (total > maximumMetadataTotalBytes)
    throw new Error("resource-limit:metadata-total");
}

type XmpCandidate = Readonly<{ value: string; locator: string }>;

const dcNamespace = "http://purl.org/dc/elements/1.1/";
const rdfNamespace = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

function xmpCandidates(
  metadata: { getRaw(): unknown } | null,
  field: "title" | "identifier",
): readonly XmpCandidate[] {
  if (metadata === null) return [];
  const raw = metadata.getRaw();
  if (typeof raw !== "string") return [];
  const document = new DOMParser({
    locator: false,
    onError() {
      throw new Error("invalid XMP XML");
    },
  }).parseFromString(raw, "application/xml");
  const fields = [
    ...document.getElementsByTagNameNS(rdfNamespace, "Description"),
  ].flatMap((description) =>
    [...description.childNodes].filter(
      (node): node is Element =>
        isElement(node) &&
        node.namespaceURI === dcNamespace &&
        node.localName === field,
    ),
  );
  return fields.flatMap((element, elementIndex) => {
    const base = `pdf:xmp/dc:${field}[${elementIndex + 1}]`;
    const children = [...element.childNodes];
    const elements = children.filter(isElement);
    if (elements.length === 0)
      return directTextValues(element).map((value) => ({
        value,
        locator: base,
      }));
    if (elements.length !== 1 || directTextValues(element).length > 0)
      return [];
    const container = elements[0]!;
    if (
      container.namespaceURI !== rdfNamespace ||
      !["Alt", "Bag", "Seq"].includes(container.localName ?? "")
    )
      return [];
    const listItems = [...container.childNodes].filter(
      (node): node is Element =>
        isElement(node) &&
        node.namespaceURI === rdfNamespace &&
        node.localName === "li",
    );
    return listItems.flatMap((item, itemIndex) =>
      [...item.childNodes].some(isElement)
        ? []
        : directTextValues(item).map((value) => ({
            value,
            locator: `${base}/rdf:li[${itemIndex + 1}]`,
          })),
    );
  });
}

function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE;
}

function directTextValues(element: Element): readonly string[] {
  return [...element.childNodes].flatMap((node) => {
    if (node.nodeType !== node.TEXT_NODE) return [];
    const value = node.nodeValue?.trim() ?? "";
    return value.length === 0 ? [] : [value];
  });
}

function xmpIsbn13s(candidates: readonly XmpCandidate[]) {
  const identifiers = new Map<string, string[]>();
  for (const candidate of candidates) {
    const normalized = candidate.value.replaceAll(/[-\s]/gu, "");
    if (!isValidIsbn13(normalized)) continue;
    const locators = identifiers.get(normalized) ?? [];
    if (!locators.includes(candidate.locator)) locators.push(candidate.locator);
    identifiers.set(normalized, locators);
  }
  return [...identifiers].map(([value, locators]) => ({
    scheme: "isbn-13",
    value,
    locators: [locators[0]!, ...locators.slice(1)] as const,
  }));
}

function isValidIsbn13(value: string): boolean {
  if (!/^(?:978|979)\d{10}$/u.test(value)) return false;
  const digits = Array.from(value).map(Number);
  const sum = digits
    .slice(0, 12)
    .reduce(
      (total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3),
      0,
    );
  return (10 - (sum % 10)) % 10 === digits[12];
}

function sameCapability(
  actual: CapabilityCoordinate,
  expected: CapabilityCoordinate,
): boolean {
  return (
    actual.capabilityId === expected.capabilityId &&
    actual.capabilityVersion === expected.capabilityVersion &&
    actual.contractVersion === expected.contractVersion &&
    actual.identity === expected.identity &&
    actual.implementationVersion === expected.implementationVersion &&
    actual.kind === expected.kind &&
    actual.interpretationContractVersions?.join("\0") ===
      expected.interpretationContractVersions?.join("\0")
  );
}

function stablePdfFailure(error: unknown): Error {
  if (
    error instanceof Error &&
    /^(?:resource-limit:|stale-pdf-revision|unsupported-encryption)/u.test(
      error.message,
    )
  )
    return error;
  if (error instanceof PasswordException)
    return new Error("unsupported-encryption");
  if (error instanceof InvalidPDFException) return new Error("damaged-pdf");
  return new Error("damaged-pdf");
}
