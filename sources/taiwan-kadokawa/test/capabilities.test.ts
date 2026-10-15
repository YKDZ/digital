import { assert, describe, expect, it } from "vitest";

import { createTaiwanKadokawaSource } from "../src/index.ts";

const isbn = "9789577435064";
const address = `https://www.kadokawa.com.tw/products/${isbn}`;
const cover =
  "https://img.shoplineapp.com/media/image_clips/663fbed6f37f0900224cb6a6/original.jpg?1715453654";
const secondIsbn = "9789577439680";
const secondAddress = `https://www.kadokawa.com.tw/products/${secondIsbn}`;
const secondCover =
  "https://img.shoplineapp.com/media/image_clips/6640445fcdb300001db83f86/original.jpg?1715487839";

function page(
  input: {
    readonly canonical?: string;
    readonly products?: readonly Record<string, unknown>[];
    readonly organizations?: readonly Record<string, unknown>[];
    readonly description?: string;
    readonly image?: unknown;
  } = {},
) {
  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "終將成為妳 關於佐伯沙彌香 (1)",
    sku: "663d2856eb0ebd0023fd644b",
    description:
      input.description ??
      "作者資訊：入間人間, 入間人間, 仲谷鳰上市日期：2020-01-22購買 BOOKWALKER 電子書試閱 BOOKWALKER 電子書第一行\n第二行",
    image: input.image ?? [cover],
  };
  const organization = { "@type": "Organization", name: "台灣角川" };
  const scripts = [
    { "@type": "WebSite", name: "台灣角川" },
    ...(input.products ?? [product]),
    ...(input.organizations ?? [organization]),
  ]
    .map(
      (item) =>
        `<script type="application/ld+json">${JSON.stringify(item)}</script>`,
    )
    .join("");
  return `<!doctype html><html><head><link rel="canonical" href="${input.canonical ?? address}">${scripts}</head><body></body></html>`;
}

function response(
  body: string | Uint8Array,
  options: {
    readonly status?: number;
    readonly mediaType?: string;
    readonly url?: string;
    readonly bodyReadFails?: boolean;
  } = {},
) {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    url: options.url ?? address,
    headers: {
      get: (name: string) =>
        name === "content-type"
          ? (options.mediaType ?? "text/html; charset=utf-8")
          : null,
    },
    arrayBuffer: async () => {
      if (options.bodyReadFails) throw new Error("讀取中斷");
      return bytes.slice().buffer;
    },
  };
}

function directed(source: ReturnType<typeof createTaiwanKadokawaSource>) {
  const normalized = source.sourceAddressing.normalize({
    isbn: "ISBN 978-957-743-506-4",
  });
  if (normalized.status !== "accepted") throw new Error(normalized.reason);
  return normalized.evidence;
}

describe("台灣角川 ISBN 產品頁來源", () => {
  it("以唯一工廠提供固定五個能力，且只接受合法台灣 ISBN 輸入", () => {
    const source = createTaiwanKadokawaSource();
    expect(Object.keys(source).toSorted()).toEqual([
      "artifactAcquirer",
      "associationInterpreter",
      "collector",
      "interpreter",
      "sourceAddressing",
    ]);
    expect(directed(source)).toMatchObject({
      sourceIdentity: "taiwan-kadokawa",
      sourceAddress: address,
    });
    for (const input of [
      {},
      { isbn: "9789577435065" },
      { isbn: "9784049131291" },
      { isbn: address },
      { isbn, extra: "no" },
      { isbn: "isbn 9789577435064" },
      { isbn: "ISBN: 9789577435064" },
      { isbn: "ISBN\t9789577435064" },
      { isbn: "ISBN\n9789577435064" },
      { isbn: "ISBN\u00a09789577435064" },
    ])
      expect(source.sourceAddressing.normalize(input)).toMatchObject({
        status: "invalid",
      });
  });

  it("只保留一次 exact HTML 成功採集，將結構失敗留給解釋階段", async () => {
    const requested: string[] = [];
    const source = createTaiwanKadokawaSource({
      request: async (input) => {
        requested.push(input);
        return response(page({ products: [] }));
      },
    });
    const evidence = directed(source);
    const collected = await source.collector.collect(evidence);
    expect(requested).toEqual([address]);
    expect(collected).toMatchObject({
      failures: [],
      records: [
        {
          sourceIdentity: "taiwan-kadokawa",
          nativeAddress: address,
          mediaType: "text/html",
          coverage: { completeness: "complete", authority: "official" },
          producer: source.collector.capability,
        },
      ],
    });
    expect(() =>
      source.interpreter.interpret({
        evidence: [evidence],
        sourceRecords: collected.records,
      }),
    ).toThrow("JSON-LD");
  });

  it("拒絕採集前的錯誤地址與非 HTML、重定向、空白和超限回應", async () => {
    const requested: string[] = [];
    const source = createTaiwanKadokawaSource({
      request: async (input) => {
        requested.push(input);
        return response("", {
          mediaType: "application/json",
          url: `${address}?unexpected=1`,
        });
      },
    });
    expect(
      source.collector.canCollect({
        ...directed(source),
        sourceAddress: `${address}?x=1`,
      }),
    ).toBe(false);
    expect(
      await source.collector.collect({
        ...directed(source),
        sourceAddress: `${address}?x=1`,
      }),
    ).toMatchObject({ records: [] });
    expect(requested).toEqual([]);
    expect(await source.collector.collect(directed(source))).toMatchObject({
      records: [],
      failures: [expect.any(Object)],
    });
    expect(requested).toEqual([address]);
  });

  it("將 HTTP、傳輸、讀取、空白、超限與非 HTML 都關閉為採集失敗", async () => {
    const bodies = [
      response(page(), { status: 404 }),
      response("", { bodyReadFails: true }),
      response(""),
      response(new Uint8Array(2 * 1024 * 1024 + 1)),
      response(page(), { mediaType: "application/json" }),
      response(page(), { url: secondAddress }),
    ];
    for (const failedResponse of bodies) {
      const source = createTaiwanKadokawaSource({
        request: async () => failedResponse,
      });
      await expect(
        source.collector.collect(directed(source)),
      ).resolves.toMatchObject({ records: [], failures: [expect.any(Object)] });
    }
    const transport = createTaiwanKadokawaSource({
      request: async () => {
        throw new Error("網路中斷");
      },
    });
    await expect(
      transport.collector.collect(directed(transport)),
    ).resolves.toMatchObject({ records: [], failures: [expect.any(Object)] });
  });

  it("要求唯一同地址 canonical、Product 與台灣角川 Organization，並在結構漂移時失敗關閉", async () => {
    const source = createTaiwanKadokawaSource({
      request: async () => response(page()),
    });
    const evidence = directed(source);
    const collected = await source.collector.collect(evidence);
    const record = collected.records[0];
    const product = {
      "@type": "Product",
      name: "終將成為妳 關於佐伯沙彌香 (1)",
      sku: "663d2856eb0ebd0023fd644b",
      description:
        "作者資訊：入間人間上市日期：2020-01-22購買 BOOKWALKER 電子書試閱 BOOKWALKER 電子書簡介",
      image: [cover],
    };
    const invalidBodies = [
      page({ canonical: secondAddress }),
      page({ products: [] }),
      page({ products: [product, product] }),
      page({ organizations: [] }),
      page({
        organizations: [
          { "@type": "Organization", name: "台灣角川" },
          { "@type": "Organization", name: "台灣角川" },
        ],
      }),
      page({ products: [{ ...product, name: "" }] }),
      page({ products: [{ ...product, sku: "" }] }),
      page().replace('{"@type":"WebSite","name":"台灣角川"}', "{"),
    ];
    assert.isDefined(record);
    for (const body of invalidBodies)
      expect(() =>
        source.interpreter.interpret({
          evidence: [evidence],
          sourceRecords: [{ ...record, body }],
        }),
      ).toThrow();
  });

  it("只投影合同书籍事实、精确 provenance 和合格封面；描述边界变化时整体省略派生字段", async () => {
    const source = createTaiwanKadokawaSource({
      request: async () => response(page()),
    });
    const evidence = directed(source);
    const collected = await source.collector.collect(evidence);
    const [batch] = source.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    assert.isDefined(batch);
    assert.isDefined(collected.records[0]);
    expect(batch).toMatchObject({
      sourceAddress: address,
      sourceRecordIds: [collected.records[0].id],
    });
    assert.isDefined(collected.records[0]);
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "book.isbn-13",
          value: isbn,
          sourceRecordIds: [collected.records[0].id],
        }),
        expect.objectContaining({
          property: "asset.title",
          value: "終將成為妳 關於佐伯沙彌香 (1)",
        }),
        expect.objectContaining({
          property: "book.publisher",
          value: "台灣角川",
        }),
        expect.objectContaining({
          property: "book.contributor",
          value: "入間人間",
        }),
        expect.objectContaining({
          property: "book.publication-date",
          value: "2020-01-22",
        }),
        expect.objectContaining({
          property: "asset.introduction",
          value: "第一行\n第二行",
        }),
      ]),
    );
    expect(batch.metadata.map((fact) => fact.property)).not.toEqual(
      expect.arrayContaining(["book.series", "book.volume", "commerce.price"]),
    );
    expect(batch.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "入間人間",
          identityNamespace: "taiwan-kadokawa.contributor.occurrence-local",
        }),
      ]),
    );
    expect(batch.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "asset.contribution",
          participants: [expect.objectContaining({ role: "book.contributor" })],
        }),
      ]),
    );
    assert.isDefined(collected.records[0]);
    expect(batch.sourceArtifacts).toEqual([
      expect.objectContaining({
        role: "asset.primary-cover",
        acquisitionReference: cover,
        sourceRecordId: collected.records[0].id,
        producer: source.interpreter.capability,
      }),
    ]);
    const malformed = await createTaiwanKadokawaSource({
      request: async () =>
        response(
          page({ description: "作者資訊：入間人間 上市日期：2020-01-22" }),
        ),
    }).collector.collect(evidence);
    const [withoutDerived] = source.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: [
        {
          ...collected.records[0],
          body: page({
            description: "作者資訊：入間人間 上市日期：2020-01-22",
          }),
        },
      ],
    });
    assert.isDefined(withoutDerived);
    expect(malformed.records).toHaveLength(1);
    expect(withoutDerived.metadata.map((fact) => fact.property)).not.toEqual(
      expect.arrayContaining([
        "book.contributor",
        "book.publication-date",
        "asset.introduction",
      ]),
    );
    const [withoutDescription] = source.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: [
        {
          ...collected.records[0],
          body: page({
            products: [
              {
                "@type": "Product",
                name: "終將成為妳 關於佐伯沙彌香 (1)",
                sku: "663d2856eb0ebd0023fd644b",
                image: [cover],
              },
            ],
          }),
        },
      ],
    });
    assert.isDefined(withoutDescription);
    expect(withoutDescription.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "book.isbn-13", value: isbn }),
        expect.objectContaining({ property: "asset.title" }),
        expect.objectContaining({
          property: "book.publisher",
          value: "台灣角川",
        }),
      ]),
    );
    expect(
      withoutDescription.metadata.map((fact) => fact.property),
    ).not.toEqual(
      expect.arrayContaining([
        "book.contributor",
        "book.publication-date",
        "asset.introduction",
      ]),
    );
  });

  it("为两份当前产品结构各自产生独立的 ISBN、事实与封面候选", async () => {
    const secondProduct = {
      "@type": "Product",
      name: "終將成為妳 關於佐伯沙彌香 (2)",
      sku: "663d1d1567853d002273bb67",
      description:
        "作者資訊：入間人間, 仲谷鳰上市日期：2020-09-07購買 BOOKWALKER 電子書試閱 BOOKWALKER 電子書第二冊簡介",
      image: [secondCover],
    };
    const source = createTaiwanKadokawaSource({
      request: async (requested) =>
        response(
          requested === address
            ? page()
            : page({ canonical: secondAddress, products: [secondProduct] }),
          { url: requested },
        ),
    });
    for (const [
      input,
      expectedAddress,
      expectedIsbn,
      expectedTitle,
      expectedCover,
    ] of [
      [isbn, address, isbn, "終將成為妳 關於佐伯沙彌香 (1)", cover],
      [
        secondIsbn,
        secondAddress,
        secondIsbn,
        "終將成為妳 關於佐伯沙彌香 (2)",
        secondCover,
      ],
    ] as const) {
      const normalized = source.sourceAddressing.normalize({ isbn: input });
      if (normalized.status !== "accepted") throw new Error(normalized.reason);
      const collected = await source.collector.collect(normalized.evidence);
      const [batch] = source.interpreter.interpret({
        evidence: [normalized.evidence],
        sourceRecords: collected.records,
      });
      assert.isDefined(batch);
      expect(batch).toMatchObject({ sourceAddress: expectedAddress });
      expect(batch.metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: "book.isbn-13",
            value: expectedIsbn,
          }),
          expect.objectContaining({
            property: "asset.title",
            value: expectedTitle,
          }),
        ]),
      );
      expect(batch.sourceArtifacts).toEqual([
        expect.objectContaining({ acquisitionReference: expectedCover }),
      ]);
    }
  });

  it("只在 ISBN 无冲突时建立关联，并且封面获取严格验证候选与实际 JPEG 响应", async () => {
    const source = createTaiwanKadokawaSource({
      request: async (input) =>
        input === cover
          ? response(new Uint8Array([1]), {
              mediaType: "image/jpeg",
              url: cover,
            })
          : response(page()),
    });
    const evidence = directed(source);
    const collected = await source.collector.collect(evidence);
    const [batch] = source.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    assert.isDefined(batch);
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
      source.associationInterpreter.interpret({
        subject,
        evidence,
        interpretation: batch,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      source.associationInterpreter.interpret({
        subject: {
          ...subject,
          metadata: [
            {
              property: "book.isbn-13",
              sourceSlot: "book.isbn-13",
              target: { kind: "entity", entityId: "asset" },
              value: isbn,
              sourceRecordIds: ["local"],
            },
          ],
        },
        evidence,
        interpretation: batch,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      source.associationInterpreter.interpret({
        subject: {
          ...subject,
          metadata: [
            {
              property: "book.isbn-13",
              sourceSlot: "book.isbn-13",
              target: { kind: "entity", entityId: "asset" },
              value: "9789577439680",
              sourceRecordIds: ["local"],
            },
          ],
        },
        evidence,
        interpretation: batch,
      }),
    ).toMatchObject({ status: "contradicted" });
    expect(
      source.associationInterpreter.interpret({
        subject,
        evidence: { ...evidence, sourceIdentity: "another-source" },
        interpretation: batch,
      }),
    ).toBeUndefined();
    expect(
      source.associationInterpreter.interpret({
        subject: {
          ...subject,
          metadata: [
            {
              property: "book.isbn-13",
              sourceSlot: "book.isbn-13",
              target: { kind: "entity", entityId: "asset" },
              value: "9784049131291",
              sourceRecordIds: ["local"],
            },
          ],
        },
        evidence,
        interpretation: batch,
      }),
    ).toMatchObject({ status: "contradicted" });
    expect(
      source.associationInterpreter.interpret({
        subject,
        evidence,
        interpretation: { ...batch, sourceAddress: secondAddress },
      }),
    ).toBeUndefined();
    expect(
      source.associationInterpreter.canInterpret({
        evidence,
        interpretation: { ...batch, sourceAddress: secondAddress },
      }),
    ).toBe(false);
    const candidate = batch.sourceArtifacts[0];
    assert.isDefined(candidate);
    await expect(
      source.artifactAcquirer.acquire(candidate),
    ).resolves.toMatchObject({
      candidateId: candidate.id,
      mediaType: "image/jpeg",
    });
    expect(
      source.artifactAcquirer.canAcquire({
        ...candidate,
        acquisitionReference: "https://example.test/cover.jpg?1",
      }),
    ).toBe(false);
    expect(
      source.artifactAcquirer.canAcquire({
        ...candidate,
        acquisitionReference: cover.replace("/original.jpg", "/preview.jpg"),
      }),
    ).toBe(false);
    expect(
      source.artifactAcquirer.canAcquire({
        ...candidate,
        producer: { ...candidate.producer!, identity: "foreign.interpreter" },
      }),
    ).toBe(false);
  });

  it("封面获取核验响应 JPEG、状态、内容和界限，而非页面声明", async () => {
    const source = createTaiwanKadokawaSource({
      request: async () => response(page()),
    });
    const evidence = directed(source);
    const collected = await source.collector.collect(evidence);
    const [batch] = source.interpreter.interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });
    assert.isDefined(batch);
    const candidate = batch.sourceArtifacts[0];
    assert.isDefined(candidate);
    for (const failedResponse of [
      response(new Uint8Array([1]), {
        status: 404,
        mediaType: "image/jpeg",
        url: cover,
      }),
      response(new Uint8Array(0), { mediaType: "image/jpeg", url: cover }),
      response(new Uint8Array(20 * 1024 * 1024 + 1), {
        mediaType: "image/jpeg",
        url: cover,
      }),
      response(new Uint8Array([1]), { mediaType: "image/webp", url: cover }),
    ]) {
      const failingSource = createTaiwanKadokawaSource({
        request: async () => failedResponse,
      });
      await expect(
        failingSource.artifactAcquirer.acquire(candidate),
      ).rejects.toThrow("封面回應不符合獲取限制");
    }
  });
});
