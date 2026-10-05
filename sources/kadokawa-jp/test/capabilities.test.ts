import { describe, expect, it } from "vitest";

import { createKadokawaJapanSource } from "../src/index.ts";

const isbn = "9784049131291";
const query = `kadokawa-jp:isbn-search:${isbn}`;
const first = "321912000002";
const second = "321912000003";

function response(
  body: string,
  url: string,
  media = "application/json",
  status = 200,
) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => media },
    arrayBuffer: async () => bytes.buffer,
  };
}
function detail(code: string, title: string) {
  return `<!doctype html><link rel="canonical" href="https://www.kadokawa.co.jp/product/${code}/"><meta itemprop="isbn" content="${isbn}"><meta property="og:title" content="${title}"><meta property="og:description" content="ライトノベル「${title}」のあらすじ、最新情報をKADOKAWA公式サイトより。概要"><meta itemprop="datePublished" content="2020-03-10"><meta property="og:image" content="https://cdn.kdkw.jp/cover_1000/${code.slice(0, 6)}/${code}.webp">`;
}

describe("KADOKAWA 日本来源", () => {
  it("在网络前拒绝非日本 ISBN，并把日本 ISBN 规范为不透明搜索地址", () => {
    const source = createKadokawaJapanSource();
    expect(
      source.sourceAddressing.normalize({ isbn: "ISBN 978-404-913-129-1" }),
    ).toMatchObject({ status: "accepted", evidence: { sourceAddress: query } });
    for (const input of [
      "9789577435064",
      "9784049131292",
      "ISBN: 9784049131291",
      "9784\u00a0049131291",
      "https://www.kadokawa.co.jp/product/321912000002/",
    ])
      expect(source.sourceAddressing.normalize({ isbn: input })).toMatchObject({
        status: "invalid",
      });
    const accepted = source.sourceAddressing.normalize({ isbn });
    if (accepted.status !== "accepted") throw new Error("expected ISBN input");
    expect(source.collector.coverageScopeIds?.(accepted.evidence)).toEqual([
      "kadokawa-jp.search",
      "kadokawa-jp.detail",
    ]);
    expect(
      source.collector.canCollect({
        ...accepted.evidence,
        sourceAddress: "kadokawa-jp:isbn-search:9784049131292",
      }),
    ).toBe(false);
  });

  it("从一条查询记录和两条独立详情记录形成两个产品批次，而非查询地址批次", async () => {
    const requested: string[] = [];
    let searchRequest: RequestInit | undefined;
    const source = createKadokawaJapanSource({
      request: async (url, init) => {
        requested.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/search/")) searchRequest = init;
        if (url.endsWith("/search/"))
          return response(
            JSON.stringify({
              count_raw: { book: 2 },
              result: {
                book: [
                  { isbn, itemCode: first },
                  { isbn, itemCode: second },
                ],
              },
            }),
            url,
          );
        const code = url.includes(first) ? first : second;
        return response(
          detail(code, code === first ? "第一册" : "第二册"),
          url,
          "text/html",
        );
      },
    });
    const normalized = source.sourceAddressing.normalize({ isbn });
    if (normalized.status !== "accepted")
      throw new Error("expected ISBN input");
    const collected = await source.collector.collect(normalized.evidence);
    expect(requested).toEqual([
      `POST https://www.kadokawa.co.jp/product/search/`,
      `GET https://www.kadokawa.co.jp/product/${first}/`,
      `GET https://www.kadokawa.co.jp/product/${second}/`,
    ]);
    expect(searchRequest).toMatchObject({
      method: "POST",
      body: `isbn=${isbn}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        referer: `https://www.kadokawa.co.jp/product/search/?kw=${isbn}`,
      },
    });
    expect(collected.records).toHaveLength(3);
    expect(collected.records.map((record) => record.nativeAddress)).toEqual([
      query,
      `https://www.kadokawa.co.jp/product/${first}/`,
      `https://www.kadokawa.co.jp/product/${second}/`,
    ]);
    expect(new Set(collected.records.map((record) => record.digest)).size).toBe(
      3,
    );
    const batches = source.interpreter.interpret({
      evidence: [normalized.evidence],
      sourceRecords: collected.records,
    });
    expect(batches.map((batch) => batch.sourceAddress)).toEqual([
      `https://www.kadokawa.co.jp/product/${first}/`,
      `https://www.kadokawa.co.jp/product/${second}/`,
    ]);
    expect(batches[1].metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "第二册",
          sourceRecordIds: [collected.records[2].id],
        }),
      ]),
    );
  });

  it("保留官方零结果的查询记录而不形成批次；不一致查询结构失败关闭", async () => {
    const source = createKadokawaJapanSource({
      request: async (url) =>
        response(
          JSON.stringify({ count_raw: { book: 0 }, result: { book: [] } }),
          url,
        ),
    });
    const normalized = source.sourceAddressing.normalize({ isbn });
    if (normalized.status !== "accepted")
      throw new Error("expected ISBN input");
    const zero = await source.collector.collect(normalized.evidence);
    expect(zero).toMatchObject({
      failures: [],
      records: [expect.objectContaining({ nativeAddress: query })],
    });
    expect(
      source.interpreter.interpret({
        evidence: [normalized.evidence],
        sourceRecords: zero.records,
      }),
    ).toEqual([]);
    const malformed = createKadokawaJapanSource({
      request: async (url) =>
        response(
          JSON.stringify({
            count_raw: { book: 0 },
            result: { book: [{ isbn, itemCode: first }] },
          }),
          url,
        ),
    });
    const badInput = malformed.sourceAddressing.normalize({ isbn });
    if (badInput.status !== "accepted") throw new Error("expected ISBN input");
    await expect(
      malformed.collector.collect(badInput.evidence),
    ).resolves.toMatchObject({
      records: [expect.any(Object)],
      failures: [expect.any(Object)],
    });
  });

  it("将查询和详情的传输、HTTP、空、MIME、重定向与第二详情失败关闭为失败，不拼接部分记录", async () => {
    for (const failed of [
      response(
        "",
        "https://www.kadokawa.co.jp/product/search/",
        "application/json",
        500,
      ),
      response("", "https://www.kadokawa.co.jp/product/search/"),
      response("{}", "https://www.kadokawa.co.jp/product/search/", "text/html"),
      response("{}", "https://example.test/redirect"),
    ]) {
      const source = createKadokawaJapanSource({ request: async () => failed });
      const normalized = source.sourceAddressing.normalize({ isbn });
      if (normalized.status !== "accepted")
        throw new Error("expected ISBN input");
      await expect(
        source.collector.collect(normalized.evidence),
      ).resolves.toMatchObject({ records: [], failures: [expect.any(Object)] });
    }
    const transport = createKadokawaJapanSource({
      request: async () => {
        throw new Error("network unavailable");
      },
    });
    const transportInput = transport.sourceAddressing.normalize({ isbn });
    if (transportInput.status !== "accepted")
      throw new Error("expected ISBN input");
    await expect(
      transport.collector.collect(transportInput.evidence),
    ).resolves.toMatchObject({ records: [], failures: [expect.any(Object)] });
    const oversized = createKadokawaJapanSource({
      request: async (url) => response("x".repeat(2 * 1024 * 1024 + 1), url),
    });
    const oversizedInput = oversized.sourceAddressing.normalize({ isbn });
    if (oversizedInput.status !== "accepted")
      throw new Error("expected ISBN input");
    await expect(
      oversized.collector.collect(oversizedInput.evidence),
    ).resolves.toMatchObject({ records: [], failures: [expect.any(Object)] });
    const source = createKadokawaJapanSource({
      request: async (url) => {
        if (url.endsWith("/search/"))
          return response(
            JSON.stringify({
              count_raw: { book: 2 },
              result: {
                book: [
                  { isbn, itemCode: first },
                  { isbn, itemCode: second },
                ],
              },
            }),
            url,
          );
        return url.includes(second)
          ? response("", url, "text/html", 500)
          : response(detail(first, "第一册"), url, "text/html");
      },
    });
    const normalized = source.sourceAddressing.normalize({ isbn });
    if (normalized.status !== "accepted")
      throw new Error("expected ISBN input");
    await expect(
      source.collector.collect(normalized.evidence),
    ).resolves.toMatchObject({
      records: [expect.any(Object), expect.any(Object)],
      failures: [expect.any(Object)],
    });
    for (const failed of [
      response(
        "",
        `https://www.kadokawa.co.jp/product/${first}/`,
        "text/html",
        500,
      ),
      response("", `https://www.kadokawa.co.jp/product/${first}/`, "text/html"),
      response(
        "{}",
        `https://www.kadokawa.co.jp/product/${first}/`,
        "application/json",
      ),
      response("{}", "https://example.test/redirect", "text/html"),
    ]) {
      const failingDetail = createKadokawaJapanSource({
        request: async (url) =>
          url.endsWith("/search/")
            ? response(
                JSON.stringify({
                  count_raw: { book: 1 },
                  result: { book: [{ isbn, itemCode: first }] },
                }),
                url,
              )
            : failed,
      });
      const input = failingDetail.sourceAddressing.normalize({ isbn });
      if (input.status !== "accepted") throw new Error("expected ISBN input");
      await expect(
        failingDetail.collector.collect(input.evidence),
      ).resolves.toMatchObject({
        records: [expect.any(Object)],
        failures: [expect.any(Object)],
      });
    }
  });

  it("只计划合法同 ISBN 的产品；详情 canonical 或 ISBN 漂移会拒绝整个解释", async () => {
    const source = createKadokawaJapanSource({
      request: async (url) => {
        if (url.endsWith("/search/"))
          return response(
            JSON.stringify({
              count_raw: { book: 4 },
              result: {
                book: [
                  { isbn, itemCode: first },
                  { isbn: "9784049131307", itemCode: second },
                  { isbn },
                  { isbn, itemCode: "not-a-product" },
                ],
              },
            }),
            url,
          );
        return response(detail(second, "错误详情"), url, "text/html");
      },
    });
    const normalized = source.sourceAddressing.normalize({ isbn });
    if (normalized.status !== "accepted")
      throw new Error("expected ISBN input");
    const collected = await source.collector.collect(normalized.evidence);
    expect(collected).toMatchObject({
      failures: [],
      records: [expect.any(Object), expect.any(Object)],
    });
    expect(() =>
      source.interpreter.interpret({
        evidence: [normalized.evidence],
        sourceRecords: collected.records,
      }),
    ).toThrow("详情页结构无效");
  });

  it("把正文读取失败也作为采集失败，而不泄漏异常", async () => {
    const source = createKadokawaJapanSource({
      request: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => "application/json" },
        arrayBuffer: async () => {
          throw new Error("body disconnected");
        },
      }),
    });
    const normalized = source.sourceAddressing.normalize({ isbn });
    if (normalized.status !== "accepted")
      throw new Error("expected ISBN input");
    await expect(
      source.collector.collect(normalized.evidence),
    ).resolves.toMatchObject({
      records: [],
      failures: [expect.any(Object)],
    });
  });

  it("来源关联刷新跳过 POST，只接受同产品详情与本解释器 WebP 候选", async () => {
    const address = `https://www.kadokawa.co.jp/product/${first}/`;
    const requested: string[] = [];
    const source = createKadokawaJapanSource({
      request: async (url, init) => {
        requested.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("cover_1000"))
          return response("webp", url, "image/webp");
        return response(detail(first, "第一册"), url, "text/html");
      },
    });
    const evidence = {
      kind: "source-association" as const,
      sourceIdentity: "kadokawa-jp",
      sourceAddress: address,
      explanation: "既有关联",
      producer: source.collector.capability,
    };
    const collected = await source.collector.collect(evidence);
    expect(source.collector.coverageScopeIds?.(evidence)).toEqual([
      "kadokawa-jp.detail",
    ]);
    expect(requested).toEqual([`GET ${address}`]);
    const [batch] = source.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    expect(
      source.associationInterpreter.canInterpret({
        evidence,
        interpretation: batch,
      }),
    ).toBe(true);
    const candidate = batch.sourceArtifacts[0];
    await expect(
      source.artifactAcquirer.acquire(candidate),
    ).resolves.toMatchObject({ mediaType: "image/webp" });
    expect(
      source.artifactAcquirer.canAcquire({
        ...candidate,
        producer: { ...candidate.producer!, identity: "foreign" },
      }),
    ).toBe(false);
    expect(
      source.artifactAcquirer.canAcquire({
        ...candidate,
        acquisitionReference: candidate.acquisitionReference.replace(
          "cover_1000",
          "cover_b",
        ),
      }),
    ).toBe(false);
  });

  it("只在结构化重复作者区块完全一致时投影角色与贡献者", async () => {
    const authors = `<ul itemprop="author" class="book-auther"><li>著者&nbsp;甲</li><li>插畫&nbsp;乙</li></ul><ul itemprop="author" class="book-auther"><li>著者&nbsp;甲</li><li>插畫&nbsp;乙</li></ul>`;
    const source = createKadokawaJapanSource({
      request: async (url) =>
        response(`${detail(first, "第一册")}${authors}`, url, "text/html"),
    });
    const evidence = {
      kind: "source-association" as const,
      sourceIdentity: "kadokawa-jp",
      sourceAddress: `https://www.kadokawa.co.jp/product/${first}/`,
      explanation: "既有关联",
      producer: source.collector.capability,
    };
    const collected = await source.collector.collect(evidence);
    const [batch] = source.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "book.contributor",
          value: "甲",
        }),
        expect.objectContaining({
          property: "book.contributor-role",
          value: "著者",
        }),
      ]),
    );
    expect(batch.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "甲",
          identityNamespace: "kadokawa-jp.contributor.occurrence-local",
        }),
      ]),
    );
    expect(batch.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "asset.contribution",
          participants: [expect.objectContaining({ role: "著者" })],
        }),
      ]),
    );
    const drifting = createKadokawaJapanSource({
      request: async (url) =>
        response(
          `${detail(first, "第一册")}<ul itemprop="author" class="book-auther"><li>著者&nbsp;甲</li></ul><ul itemprop="author" class="book-auther"><li>著者&nbsp;丙</li></ul>`,
          url,
          "text/html",
        ),
    });
    const driftEvidence = {
      ...evidence,
      producer: drifting.collector.capability,
    };
    const driftCollected = await drifting.collector.collect(driftEvidence);
    const [driftBatch] = drifting.interpreter.interpret({
      evidence: [driftEvidence],
      sourceRecords: driftCollected.records,
    });
    expect(driftBatch.metadata.map((fact) => fact.property)).not.toEqual(
      expect.arrayContaining(["book.contributor", "book.contributor-role"]),
    );
  });

  it("关联只接受同 ISBN 的查询或同地址刷新，并让封面响应失败关闭", async () => {
    const address = `https://www.kadokawa.co.jp/product/${first}/`;
    const collector = createKadokawaJapanSource({
      request: async (url) =>
        response(detail(first, "第一册"), url, "text/html"),
    });
    const evidence = {
      kind: "source-association" as const,
      sourceIdentity: "kadokawa-jp",
      sourceAddress: address,
      explanation: "既有关联",
      producer: collector.collector.capability,
    };
    const collected = await collector.collector.collect(evidence);
    const [batch] = collector.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    const directed = collector.sourceAddressing.normalize({ isbn });
    if (directed.status !== "accepted") throw new Error("expected ISBN input");
    expect(
      collector.associationInterpreter.canInterpret({
        evidence: directed.evidence,
        interpretation: batch,
      }),
    ).toBe(true);
    const subject = {
      subjectId: "asset",
      recognitionDecisionId: "decision",
      sourceAssociations: [],
      metadataSourceRecords: [],
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        artifactRoles: [],
        relationshipTypes: [],
      },
      metadata: [],
    };
    expect(
      collector.associationInterpreter.interpret({
        subject,
        evidence: directed.evidence,
        interpretation: batch,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      collector.associationInterpreter.canInterpret({
        evidence: {
          ...evidence,
          sourceAddress: `https://www.kadokawa.co.jp/product/${second}/`,
        },
        interpretation: batch,
      }),
    ).toBe(false);
    expect(
      collector.associationInterpreter.canInterpret({
        evidence: { ...evidence, sourceIdentity: "foreign" },
        interpretation: batch,
      }),
    ).toBe(false);
    const candidate = batch.sourceArtifacts[0];
    for (const failed of [
      response("", candidate.acquisitionReference, "image/webp", 500),
      response("", candidate.acquisitionReference, "image/webp"),
      response("not a webp", candidate.acquisitionReference, "image/jpeg"),
    ]) {
      const source = createKadokawaJapanSource({ request: async () => failed });
      await expect(
        source.artifactAcquirer.acquire(candidate),
      ).rejects.toThrow();
    }
    const tooLarge = createKadokawaJapanSource({
      request: async (url) =>
        response("x".repeat(20 * 1024 * 1024 + 1), url, "image/webp"),
    });
    await expect(
      tooLarge.artifactAcquirer.acquire(candidate),
    ).rejects.toThrow();
  });

  it("详情可选字段漂移时只保留 ISBN 与标题，不猜测出版者或搜索快捷字段", async () => {
    const source = createKadokawaJapanSource({
      request: async (url) =>
        response(
          `<!doctype html><link rel="canonical" href="https://www.kadokawa.co.jp/product/${first}/"><meta itemprop="isbn" content="${isbn}"><meta property="og:title" content="第一册"><meta property="og:description" content="错误摘要"><meta itemprop="datePublished" content="2020-02-31"><meta name="author" content="KADOKAWA CORPORATION">`,
          url,
          "text/html",
        ),
    });
    const evidence = {
      kind: "source-association" as const,
      sourceIdentity: "kadokawa-jp",
      sourceAddress: `https://www.kadokawa.co.jp/product/${first}/`,
      explanation: "既有关联",
      producer: source.collector.capability,
    };
    const collected = await source.collector.collect(evidence);
    const [batch] = source.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "book.isbn-13", value: isbn }),
        expect.objectContaining({ property: "asset.title", value: "第一册" }),
      ]),
    );
    expect(batch.metadata.map((fact) => fact.property)).not.toEqual(
      expect.arrayContaining([
        "asset.summary",
        "book.publication-date",
        "book.publisher",
        "book.series",
        "book.volume",
      ]),
    );
    const subject = {
      subjectId: "asset",
      recognitionDecisionId: "decision",
      sourceAssociations: [],
      metadataSourceRecords: [],
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        artifactRoles: [],
        relationshipTypes: [],
      },
      metadata: [
        {
          property: "book.isbn-13",
          value: "9789577435064",
          sourceRecordIds: ["existing"],
        },
      ],
    };
    expect(
      source.associationInterpreter.interpret({
        subject,
        evidence,
        interpretation: batch,
      }),
    ).toMatchObject({ status: "contradicted" });
  });
});
