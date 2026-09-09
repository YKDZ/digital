import { createHash, randomUUID } from "node:crypto";

import {
  declareCapability,
  type SourceAddressingCapability,
  type SourceArtifactAcquirer,
  type SourceAssociationInterpreter,
  type SourceCollectionFailure,
  type SourceCollectionResult,
  type SourceCollector,
  type SourceInterpreter,
  type StagedSourceArtifact,
} from "@digital/application";
import type {
  CapabilityCoordinate,
  RecognitionEvidence,
  SourceRecord,
} from "@digital/domain";
import { parse } from "parse5";

const identity = "kadokawa-jp";
const origin = "https://www.kadokawa.co.jp";
const searchUrl = `${origin}/product/search/`;
const limit = 2 * 1024 * 1024;
const coverLimit = 20 * 1024 * 1024;
const addressing = declareCapability({
  identity: "kadokawa-jp.explicit-isbn-addressing",
  implementationVersion: "1",
  kind: "source-addressing",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const collection = declareCapability({
  identity: "kadokawa-jp.official-collection",
  implementationVersion: "1",
  kind: "source-collector",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const interpretation = declareCapability({
  identity: "kadokawa-jp.product-interpretation",
  implementationVersion: "1",
  kind: "source-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const association = declareCapability({
  identity: "kadokawa-jp.isbn-association-interpretation",
  implementationVersion: "1",
  kind: "source-association-interpreter",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});
const acquisition = declareCapability({
  identity: "kadokawa-jp.source-artifact-acquirer",
  implementationVersion: "1",
  kind: "source-artifact-acquirer",
  contractVersion: "1",
  interpretationContractVersions: ["1"],
});

type Request = (
  url: string,
  init?: RequestInit,
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
type RequestOptions = {
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};
type Ports = {
  readonly sourceAddressing: SourceAddressingCapability;
  readonly collector: SourceCollector;
  readonly interpreter: SourceInterpreter;
  readonly associationInterpreter: SourceAssociationInterpreter;
  readonly artifactAcquirer: SourceArtifactAcquirer;
};
type Book = { readonly isbn: string; readonly code: string };

/** 建立固定配套的 KADOKAWA 日本来源能力；查询、页面和 HTML 细节不越过该集成。 */
export function createKadokawaJapanSource(
  options: { readonly request?: Request } = {},
): Ports {
  const request = options.request ?? fetch;
  const sourceAddressing: SourceAddressingCapability = {
    capability: addressing,
    inputRequirement: {
      sourceIdentity: identity,
      displayName: "KADOKAWA 日本",
      fields: [
        {
          key: "isbn",
          label: "ISBN",
          required: true,
          acceptedInput: "日本 ISBN-13 编号",
          example: "9784049131291",
        },
      ],
    },
    normalize(input) {
      if (!same(Object.keys(input), ["isbn"])) return invalid();
      const isbn = japaneseIsbn(input.isbn);
      if (isbn === undefined) return invalid();
      return {
        status: "accepted",
        normalizedInput: { isbn },
        evidence: {
          kind: "directed-source-address",
          sourceIdentity: identity,
          sourceAddress: queryAddress(isbn),
          explanation: "用户明确指定 KADOKAWA 日本 ISBN",
          producer: addressing,
        },
      };
    },
  };
  const collector: SourceCollector = {
    capability: collection,
    canCollect: (evidence) => addressFromEvidence(evidence) !== undefined,
    coverageScopeIds: (evidence) => {
      const address = addressFromEvidence(evidence);
      if (address === undefined) return [];
      return isProduct(address)
        ? ["kadokawa-jp.detail"]
        : ["kadokawa-jp.search", "kadokawa-jp.detail"];
    },
    async collect(evidence) {
      const address = addressFromEvidence(evidence);
      if (address === undefined) return failure("KADOKAWA 日本来源地址无效");
      if (isProduct(address)) return await collectDetail(request, address);
      const isbn = isbnFromQuery(address)!;
      const queried = await responseRecord(
        request,
        searchUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
            referer: `${searchUrl}?kw=${isbn}`,
          },
          body: `isbn=${isbn}`,
        },
        address,
        "application/json",
        "kadokawa-jp.search",
      );
      if (queried.record === undefined) return queried.result;
      let books: readonly Book[];
      try {
        books = booksFromQuery(queried.record.body, isbn);
      } catch {
        return {
          records: [queried.record],
          failures: [failureItem("KADOKAWA 日本搜索 JSON 结构无效")],
        };
      }
      const records = [queried.record];
      const failures = [] as SourceCollectionFailure[];
      for (const book of books) {
        const detail = await collectDetail(request, productAddress(book.code));
        records.push(...detail.records);
        failures.push(...detail.failures);
        if (detail.failures.length > 0) break;
      }
      return { records, failures };
    },
  };
  const interpreter: SourceInterpreter = {
    capability: interpretation,
    canInterpret: ({ evidence, sourceRecords }) =>
      requestedAddress(evidence) !== undefined &&
      sourceRecords.some((record) => record.sourceIdentity === identity),
    interpret(input) {
      const address = requestedAddress(input.evidence);
      if (address === undefined) throw new Error("KADOKAWA 日本证据无效");
      if (isProduct(address)) {
        const detail = onlyDetail(input.sourceRecords, address);
        return [batchFromDetail(detail, undefined, undefined)];
      }
      const query = onlyQuery(input.sourceRecords, address);
      const books = booksFromQuery(query.body, isbnFromQuery(address)!);
      return books.map((book) => {
        const detail = onlyDetail(
          input.sourceRecords,
          productAddress(book.code),
        );
        return batchFromDetail(detail, query.id, book.isbn);
      });
    },
  };
  const associationInterpreter: SourceAssociationInterpreter = {
    capability: association,
    canInterpret({ evidence, interpretation: batch }) {
      const address = addressFromEvidence(evidence);
      if (address === undefined || batch.sourceIdentity !== identity)
        return false;
      return isProduct(address)
        ? address === batch.sourceAddress
        : isbnFromQuery(address) === batchIsbn(batch);
    },
    interpret({ subject, evidence, interpretation: batch }) {
      if (!this.canInterpret({ evidence, interpretation: batch }))
        return undefined;
      const isbn = batchIsbn(batch);
      if (isbn === undefined) return undefined;
      const existing = subject.metadata
        .filter((fact) => fact.property === "book.isbn-13")
        .map((fact) => isbn13(String(fact.value)))
        .filter((value): value is string => value !== undefined);
      return existing.every((value) => value === isbn)
        ? {
            status: "accepted",
            explanation: "KADOKAWA 日本 ISBN 与当前主体无冲突",
          }
        : {
            status: "contradicted",
            explanation: "KADOKAWA 日本 ISBN 与当前主体已有 ISBN 冲突",
          };
    },
  };
  const artifactAcquirer: SourceArtifactAcquirer = {
    capability: acquisition,
    canAcquire(candidate) {
      return (
        candidate.role === "asset.primary-cover" &&
        candidate.mediaType === "image/webp" &&
        candidate.producer !== undefined &&
        sameCapability(candidate.producer, interpretation) &&
        coverUrl(candidate.acquisitionReference)
      );
    },
    async acquire(candidate) {
      if (!this.canAcquire(candidate))
        throw new Error("KADOKAWA 日本封面候选无效");
      const response = await request(candidate.acquisitionReference);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        !response.ok ||
        !isMedia(response.headers.get("content-type"), "image/webp") ||
        bytes.byteLength === 0 ||
        bytes.byteLength > coverLimit
      )
        throw new Error("KADOKAWA 日本封面响应不符合获取限制");
      return {
        candidateId: candidate.id,
        sourceRecordId: candidate.sourceRecordId,
        bytes,
        mediaType: "image/webp",
      } satisfies StagedSourceArtifact;
    },
  };
  return {
    sourceAddressing,
    collector,
    interpreter,
    associationInterpreter,
    artifactAcquirer,
  };
}

function invalid() {
  return {
    status: "invalid" as const,
    reason: "请输入有效的日本 ISBN-13 编号",
  };
}
function queryAddress(isbn: string) {
  return `${identity}:isbn-search:${isbn}`;
}
function productAddress(code: string) {
  return `${origin}/product/${code}/`;
}
function isProduct(address: string) {
  return /^https:\/\/www\.kadokawa\.co\.jp\/product\/\d{12}\/$/u.test(address);
}
function isbnFromQuery(address: string) {
  const value = new RegExp(
    `^${identity}:isbn-search:(97[89]\\d{10})$`,
    "u",
  ).exec(address)?.[1];
  return value === undefined ? undefined : canonicalJapaneseIsbn(value);
}
function productCode(address: string) {
  return /product\/(\d{12})\/$/u.exec(address)?.[1];
}
function japaneseIsbn(value: string | undefined) {
  if (value === undefined) return undefined;
  const text = value.startsWith("ISBN") ? value.slice(4) : value;
  if (!/^[0-9 -]+$/u.test(text)) return undefined;
  const isbn = text.replaceAll(/[ -]/gu, "");
  return /^9784\d{9}$/u.test(isbn) && isbn13(isbn) ? isbn : undefined;
}
function isbn13(value: string) {
  if (!/^97[89]\d{10}$/u.test(value)) return undefined;
  const sum = value
    .slice(0, 12)
    .split("")
    .reduce(
      (total, digit, index) =>
        total + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    );
  return (10 - (sum % 10)) % 10 === Number(value[12]) ? value : undefined;
}
function addressFromEvidence(evidence: RecognitionEvidence) {
  if (
    evidence.sourceIdentity !== identity ||
    evidence.sourceAddress === undefined
  )
    return undefined;
  if (evidence.kind === "source-association")
    return isProduct(evidence.sourceAddress)
      ? evidence.sourceAddress
      : undefined;
  return evidence.kind === "directed-source-address" &&
    sameCapability(evidence.producer, addressing) &&
    isbnFromQuery(evidence.sourceAddress) !== undefined
    ? evidence.sourceAddress
    : undefined;
}
function requestedAddress(evidence: readonly RecognitionEvidence[]) {
  const addresses = [
    ...new Set(
      evidence
        .map(addressFromEvidence)
        .filter((value): value is string => value !== undefined),
    ),
  ];
  return addresses.length === 1 ? addresses[0] : undefined;
}
function failure(reason: string): SourceCollectionResult {
  return { records: [], failures: [failureItem(reason)] };
}
function failureItem(reason: string): SourceCollectionFailure {
  return { capability: collection, reason };
}
async function responseRecord(
  request: Request,
  url: string,
  init: RequestOptions,
  nativeAddress: string,
  media: string,
  coverage: string,
): Promise<{
  readonly record?: SourceRecord;
  readonly result: SourceCollectionResult;
}> {
  let response: Awaited<ReturnType<Request>>;
  try {
    response = await request(url, init);
  } catch {
    return { result: failure("KADOKAWA 日本请求失败") };
  }
  if (
    !response.ok ||
    response.url !== url ||
    !isMedia(response.headers.get("content-type"), media)
  )
    return { result: failure("KADOKAWA 日本响应无效") };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { result: failure("KADOKAWA 日本响应读取失败") };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > limit)
    return { result: failure("KADOKAWA 日本响应不符合保存限制") };
  const record: SourceRecord = {
    id: `source-record_kadokawa-jp_${randomUUID()}`,
    sourceIdentity: identity,
    nativeAddress,
    mediaType: media,
    acquiredAt: new Date().toISOString(),
    acquisition: {
      requestedAddress: url,
      method: init.method,
      authorized: false,
    },
    coverage: { id: coverage, completeness: "complete", authority: "official" },
    digest: createHash("sha256").update(bytes).digest("hex"),
    body: new TextDecoder().decode(bytes),
    producer: collection,
  };
  return { record, result: { records: [record], failures: [] } };
}
async function collectDetail(request: Request, address: string) {
  const result = await responseRecord(
    request,
    address,
    { method: "GET" },
    address,
    "text/html",
    "kadokawa-jp.detail",
  );
  return result.record === undefined
    ? result.result
    : { records: [result.record], failures: [] };
}
function booksFromQuery(body: string, wanted: string): readonly Book[] {
  const value = JSON.parse(body) as {
    readonly count_raw?: { readonly book?: number };
    readonly result?: {
      readonly book?: readonly {
        readonly isbn?: string;
        readonly itemCode?: string;
        readonly media?: string;
      }[];
    };
  };
  const list = value.result?.book;
  if (
    !Array.isArray(list) ||
    !Number.isSafeInteger(value.count_raw?.book) ||
    value.count_raw!.book! < 0
  )
    throw new Error("搜索结构无效");
  if (value.count_raw!.book! === 0) {
    if (list.length === 0) return [];
    throw new Error("搜索零结果结构无效");
  }
  if (list.length === 0) throw new Error("搜索结果结构无效");
  const found = new Map<string, Book>();
  for (const item of list)
    if (
      item.isbn === wanted &&
      japaneseIsbn(item.isbn) !== undefined &&
      /^\d{12}$/u.test(item.itemCode ?? "")
    )
      found.set(item.itemCode!, { isbn: item.isbn!, code: item.itemCode! });
  return [...found.values()];
}
function onlyDetail(records: readonly SourceRecord[], address: string) {
  const found = records.filter(
    (record) =>
      record.sourceIdentity === identity &&
      record.nativeAddress === address &&
      record.coverage.id === "kadokawa-jp.detail" &&
      record.coverage.completeness === "complete" &&
      record.coverage.authority === "official" &&
      record.mediaType === "text/html" &&
      record.producer !== undefined &&
      sameCapability(record.producer, collection),
  );
  if (found.length !== 1) throw new Error("缺少同产品 KADOKAWA 日本详情记录");
  return found[0]!;
}
function onlyQuery(records: readonly SourceRecord[], address: string) {
  const found = records.filter(
    (record) =>
      record.sourceIdentity === identity &&
      record.nativeAddress === address &&
      record.coverage.id === "kadokawa-jp.search" &&
      record.coverage.completeness === "complete" &&
      record.coverage.authority === "official" &&
      record.mediaType === "application/json" &&
      record.producer !== undefined &&
      sameCapability(record.producer, collection),
  );
  if (found.length !== 1) throw new Error("缺少完整官方 KADOKAWA 日本搜索记录");
  return found[0]!;
}
function batchFromDetail(
  record: SourceRecord,
  queryRecordId: string | undefined,
  expectedIsbn: string | undefined,
) {
  const page = detail(record.body);
  if (
    page.canonical !== record.nativeAddress ||
    page.code !== productCode(record.nativeAddress) ||
    page.isbn === undefined ||
    (expectedIsbn !== undefined && page.isbn !== expectedIsbn)
  )
    throw new Error("KADOKAWA 日本详情页结构无效");
  const metadata = [
    {
      property: "book.isbn-13",
      sourceSlot: "kadokawa-jp.isbn-13",
      value: page.isbn,
      sourceRecordIds: [record.id],
    },
    {
      property: "asset.title",
      sourceSlot: "kadokawa-jp.og-title",
      value: page.title,
      sourceRecordIds: [record.id],
    },
    ...(page.summary === undefined
      ? []
      : [
          {
            property: "asset.summary",
            sourceSlot: "kadokawa-jp.summary",
            value: page.summary,
            sourceRecordIds: [record.id],
          },
        ]),
    ...(page.date === undefined
      ? []
      : [
          {
            property: "book.publication-date",
            sourceSlot: "kadokawa-jp.publication-date",
            value: page.date,
            sourceRecordIds: [record.id],
          },
        ]),
    ...(page.authors === undefined
      ? []
      : page.authors.flatMap(([role, name], index) => [
          {
            property: "book.contributor",
            sourceSlot: `kadokawa-jp.contributor.${index + 1}`,
            value: name,
            sourceRecordIds: [record.id],
          },
          {
            property: "book.contributor-role",
            sourceSlot: `kadokawa-jp.contributor.${index + 1}.role`,
            value: role,
            sourceRecordIds: [record.id],
          },
        ])),
  ];
  return {
    id: `source-interpretation_${randomUUID()}`,
    producer: interpretation,
    sourceRecordIds:
      queryRecordId === undefined ? [record.id] : [queryRecordId, record.id],
    sourceIdentity: identity,
    sourceAddress: record.nativeAddress,
    metadata,
    sourceArtifacts:
      page.cover === undefined
        ? []
        : [
            {
              id: `kadokawa-jp-cover_${randomUUID()}`,
              sourceRecordId: record.id,
              role: "asset.primary-cover",
              acquisitionReference: page.cover,
              mediaType: "image/webp",
              producer: interpretation,
            },
          ],
  };
}
function batchIsbn(batch: {
  readonly metadata: readonly {
    readonly property: string;
    readonly value: string;
  }[];
}) {
  const values = batch.metadata
    .filter((fact) => fact.property === "book.isbn-13")
    .map((fact) => canonicalJapaneseIsbn(fact.value))
    .filter((value): value is string => value !== undefined);
  return values.length === 1 ? values[0] : undefined;
}
function canonicalJapaneseIsbn(value: string) {
  return /^9784\d{9}$/u.test(value) && isbn13(value) ? value : undefined;
}
type Node = {
  readonly tagName?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly Node[];
  readonly value?: string;
};
function detail(html: string) {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html) as unknown as Node);
  const attr = (node: Node, name: string) =>
    node.attrs?.find((item) => item.name === name)?.value;
  const text = (node: Node): string =>
    node.childNodes?.map((child) => child.value ?? text(child)).join("") ??
    node.value ??
    "";
  const one = (nodes: readonly Node[]) =>
    nodes.length === 1 ? nodes[0]! : undefined;
  const canonical = one(
    nodes.filter(
      (node) => node.tagName === "link" && attr(node, "rel") === "canonical",
    ),
  );
  const isbn = one(nodes.filter((node) => attr(node, "itemprop") === "isbn"));
  const title = one(
    nodes.filter((node) => attr(node, "property") === "og:title"),
  );
  const image = one(
    nodes.filter((node) => attr(node, "property") === "og:image"),
  );
  const date = one(
    nodes.filter((node) => attr(node, "itemprop") === "datePublished"),
  );
  const authorBlocks = nodes
    .filter(
      (node) =>
        node.tagName === "ul" &&
        attr(node, "itemprop") === "author" &&
        attr(node, "class")?.split(" ").includes("book-auther") === true,
    )
    .map(
      (block) =>
        block.childNodes?.filter((node) => node.tagName === "li").map(text) ??
        [],
    );
  const canonicalAddress =
    canonical === undefined ? undefined : attr(canonical, "href");
  const code =
    canonicalAddress === undefined ? undefined : productCode(canonicalAddress);
  const isbnValue =
    isbn === undefined
      ? undefined
      : japaneseIsbn(attr(isbn, "content") ?? text(isbn));
  const titleValue =
    title === undefined ? undefined : attr(title, "content")?.trim();
  if (
    canonicalAddress === undefined ||
    code === undefined ||
    isbnValue === undefined ||
    titleValue === undefined ||
    titleValue.length === 0
  )
    throw new Error("KADOKAWA 日本详情必需字段无效");
  const description = one(
    nodes.filter((node) => attr(node, "property") === "og:description"),
  );
  const prefix = `ライトノベル「${titleValue}」のあらすじ、最新情報をKADOKAWA公式サイトより。`;
  const raw =
    description === undefined ? undefined : attr(description, "content");
  const summary =
    raw?.startsWith(prefix) === true &&
    raw.slice(prefix.length).trim().length > 0
      ? raw.slice(prefix.length)
      : undefined;
  const dateValue = date === undefined ? undefined : attr(date, "content");
  const published =
    dateValue !== undefined && isIsoDate(dateValue) ? dateValue : undefined;
  const imageUrl = image === undefined ? undefined : attr(image, "content");
  const cover =
    imageUrl !== undefined &&
    coverUrl(imageUrl) &&
    imageUrl.includes(`/${code.slice(0, 6)}/${code}.webp`)
      ? imageUrl
      : undefined;
  const authors =
    authorBlocks.length === 0 ? undefined : normalizedAuthors(authorBlocks);
  return {
    canonical: canonicalAddress,
    code,
    isbn: isbnValue,
    title: titleValue,
    summary,
    date: published,
    cover,
    authors,
  };
}
function normalizedAuthors(blocks: readonly (readonly string[])[]) {
  if (blocks.some((block) => block.length === 0)) return undefined;
  const parsed = blocks.map((block) =>
    block.map((item) => {
      const value = trimAscii(item);
      const parts = value.split("\u00a0");
      return parts.length === 2 &&
        trimAscii(parts[0]!).length > 0 &&
        trimAscii(parts[1]!).length > 0
        ? ([trimAscii(parts[0]!), trimAscii(parts[1]!)] as const)
        : undefined;
    }),
  );
  if (parsed.some((block) => block.some((item) => item === undefined)))
    return undefined;
  const first = parsed[0]! as readonly (readonly [string, string])[];
  return parsed.every(
    (block) => JSON.stringify(block) === JSON.stringify(first),
  )
    ? first
    : undefined;
}
function trimAscii(value: string) {
  return value.replaceAll(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "");
}
function isIsoDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().startsWith(value)
  );
}
function coverUrl(value: string) {
  try {
    const url = new URL(value);
    const match = /^\/cover_1000\/(\d{6})\/(\d{12})\.webp$/u.exec(url.pathname);
    return (
      url.protocol === "https:" &&
      url.hostname === "cdn.kdkw.jp" &&
      match !== null &&
      match[1] === match[2]!.slice(0, 6) &&
      url.search === "" &&
      url.hash === "" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}
function isMedia(value: string | null, expected: string) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}
function same(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
function sameCapability(
  left: CapabilityCoordinate,
  right: CapabilityCoordinate,
) {
  return (
    left.capabilityId === right.capabilityId &&
    left.capabilityVersion === right.capabilityVersion &&
    left.contractVersion === right.contractVersion &&
    left.identity === right.identity &&
    left.implementationVersion === right.implementationVersion &&
    left.kind === right.kind &&
    same(
      left.interpretationContractVersions ?? [],
      right.interpretationContractVersions ?? [],
    )
  );
}
