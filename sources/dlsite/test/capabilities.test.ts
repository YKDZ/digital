import { assert, describe, expect, it } from "vitest";

import {
  DlsiteArtifactAcquirer,
  DlsiteCollector,
  DlsiteExactDirectoryInterpreter,
  DlsiteExactRecognizer,
  DlsiteLocalSourceCandidateInterpreter,
  DlsiteSourceAddressing,
  DlsiteSourceAssociationInterpreter,
  DlsiteSourceInterpreter,
} from "../src/index.ts";

const snapshot = (root: string) => ({
  id: "snapshot",
  root,
  complete: true,
  excluded: [],
  files: [],
  observedAt: "2026-07-29T00:00:00.000Z",
});

// 独立预期：精确目录能力的现行声明坐标（v3 实现、合同 1、解释合同 ["1"]）。
const exactDirectoryCapability = {
  capabilityId: "dlsite.exact-directory",
  capabilityVersion: "3",
  contractVersion: "1",
  identity: "dlsite.exact-directory",
  implementationVersion: "3",
  kind: "directory-interpreter",
  interpretationContractVersions: ["1"],
};

const evidence = {
  kind: "source-address",
  explanation: "exact",
  sourceIdentity: "dlsite",
  sourceAddress:
    "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
  producer: {
    capabilityId: "dlsite.exact-directory",
    capabilityVersion: "1",
    contractVersion: "1",
  },
};

const response = (body: string, mediaType: string) => ({
  ok: true,
  status: 200,
  headers: { get: () => mediaType },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

describe("DLsite exact directory convention", () => {
  it("精确目录建立有限内容范围，普通文件名和范围之外的祖先名称不建立身份", () => {
    const interpreter = new DlsiteExactDirectoryInterpreter();
    const matched = interpreter.interpret({
      ...snapshot("/library/RJ01668691"),
      files: [
        {
          relativePath: "audio/track.wav",
          size: 1,
          modifiedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });
    // 现行返回是资产刷新工作计划信封：精确目录自声明材料边界，身份仍来自本能力坐标。
    if (!("workItems" in matched))
      throw new Error("精确目录命中必须返回 workItems 信封，而不是裸证据数组");
    expect(matched.workItems).toHaveLength(1);
    expect(matched.workItems[0]).toEqual({
      key: "dlsite-directory:.",
      relativePaths: ["audio/track.wav"],
      materialBoundary: { kind: "directory", relativePath: "." },
      independentIdentityDeclaredBy: exactDirectoryCapability,
      evidence: [
        {
          kind: "source-address",
          sourceIdentity: "dlsite",
          sourceAddress:
            "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
          explanation: "DLsite 精确目录规则匹配；普通下级文件服务同一作品",
          producer: exactDirectoryCapability,
        },
      ],
    });
    expect(
      interpreter.interpret(snapshot("/library/RJ01668691 notes")),
    ).toEqual([]);
    expect(
      interpreter.interpret(snapshot("/RJ01668691/ordinary-directory")),
    ).toEqual([]);
    expect(
      interpreter.interpret({
        ...snapshot("/library/ordinary-directory"),
        files: [
          {
            relativePath: "title RJ01668691.wav",
            size: 1,
            modifiedAt: "2026-07-29T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("DLsite explicit product addressing", () => {
  it.each([
    [
      "RJ01668691",
      "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
    ],
    [
      "VJ014635",
      "https://www.dlsite.com/maniax/work/=/product_id/VJ014635.html",
    ],
    [
      "https://www.dlsite.com/girls/work/=/product_id/RJ01497788.html",
      "https://www.dlsite.com/girls/work/=/product_id/RJ01497788.html",
    ],
  ])("normalizes an explicit product %s", (product, sourceAddress) => {
    const addressing = new DlsiteSourceAddressing();

    expect(addressing.normalize({ product })).toEqual({
      status: "accepted",
      normalizedInput: { product: sourceAddress },
      evidence: {
        kind: "directed-source-address",
        sourceIdentity: "dlsite",
        sourceAddress,
        explanation: "用户明确指定 DLsite 产品",
        producer: addressing.capability,
      },
    });
  });

  it("rejects unknown fields and non-canonical product addresses", () => {
    const addressing = new DlsiteSourceAddressing();

    expect(
      addressing.normalize({
        product: "RJ01668691",
        address: "https://www.dlsite.com/",
      }),
    ).toMatchObject({ status: "invalid" });
    expect(
      addressing.normalize({
        product:
          "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html?token=secret",
      }),
    ).toMatchObject({ status: "invalid" });
    expect(addressing.normalize({ product: "RJ1668691" })).toMatchObject({
      status: "invalid",
    });
  });
});

describe("DLsite collection and interpretation", () => {
  it("matches an official VJ catalogue page to the exact locally observed product", () => {
    const associationInterpreter = new DlsiteSourceAssociationInterpreter();
    const localCandidate = new DlsiteLocalSourceCandidateInterpreter();
    const sourceInterpreter = new DlsiteSourceInterpreter();
    const evidence = {
      kind: "source-association",
      sourceIdentity: "dlsite",
      sourceAddress:
        "https://www.dlsite.com/maniax/work/=/product_id/VJ014635.html",
      explanation: "exact local VJ directory",
      producer: localCandidate.capability,
    } as const;
    const interpretation = {
      id: "interpretation",
      producer: sourceInterpreter.capability,
      sourceRecordIds: [],
      sourceIdentity: "dlsite",
      sourceAddress:
        "https://www.dlsite.com/soft/work/=/product_id/VJ014635.html",
      metadata: [],
      sourceArtifacts: [],
    } as const;
    const subject = {
      subjectId: "subject",
      recognitionDecisionId: "recognition-decision",
      sourceAssociations: [],
      metadata: [],
      metadataSourceRecords: [],
      informationRequirement: {
        metadataUsageContext: "test",
        metadata: [],
        artifactRoles: [],
        relationshipTypes: [],
      },
    } as const;

    expect(
      associationInterpreter.interpret({
        subject,
        evidence,
        interpretation,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      associationInterpreter.interpret({
        subject,
        evidence,
        interpretation: {
          ...interpretation,
          sourceAddress:
            "https://www.dlsite.com/soft/work/=/product_id/VJ014636.html",
        },
      }),
    ).toBeUndefined();
  });

  it("retries a bounded transient official request inside the source capability", async () => {
    const requested: string[] = [];
    let firstJsonRequest = true;
    const collector = new DlsiteCollector(
      async (address) => {
        requested.push(address);
        if (address.includes("ajax") && firstJsonRequest) {
          firstJsonRequest = false;
          throw new TypeError("temporary transport failure");
        }
        return response(
          address.includes("ajax")
            ? JSON.stringify({ RJ01668691: { site_id: "maniax" } })
            : "<html></html>",
          address.includes("ajax") ? "application/json" : "text/html",
        );
      },
      async () => {},
    );

    const result = await collector.collect(evidence);

    expect(result.failures).toEqual([]);
    expect(result.records).toHaveLength(2);
    expect(
      requested.filter((address) => address.includes("ajax")),
    ).toHaveLength(2);
  });

  it("uses the official catalogue section declared by product JSON for the product page", async () => {
    const requested: string[] = [];
    const collector = new DlsiteCollector(async (address) => {
      requested.push(address);
      if (address.includes("/product/info/ajax")) {
        return response(
          JSON.stringify({
            VJ014635: {
              site_id: "soft",
              work_name: "work",
              regist_date: "2021-08-02",
            },
          }),
          "application/json",
        );
      }
      return response("<html></html>", "text/html");
    });

    const result = await collector.collect({
      kind: "source-address",
      sourceIdentity: "dlsite",
      sourceAddress:
        "https://www.dlsite.com/maniax/work/=/product_id/VJ014635.html",
      explanation: "directory",
      producer: new DlsiteExactDirectoryInterpreter().capability,
    });

    expect(result.failures).toEqual([]);
    expect(requested).toEqual([
      "https://www.dlsite.com/maniax/product/info/ajax?product_id=VJ014635",
      "https://www.dlsite.com/soft/work/=/product_id/VJ014635.html",
    ]);
    expect(result.records.map((record) => record.nativeAddress)).toEqual([
      "https://www.dlsite.com/soft/work/=/product_id/VJ014635.html",
      "https://www.dlsite.com/soft/work/=/product_id/VJ014635.html",
    ]);
  });

  it("keeps JSON and HTML responses as independent records with one canonical native address", async () => {
    const collector = new DlsiteCollector(async (address) =>
      address.includes("ajax")
        ? response(
            JSON.stringify({ RJ01668691: { site_id: "maniax" } }),
            "application/json",
          )
        : response(address, "text/html"),
    );
    const result = await collector.collect(evidence);

    expect(result.failures).toEqual([]);
    expect(result.records.map((record) => record.coverage.id)).toEqual([
      "dlsite.product-json",
      "dlsite.product-html",
    ]);
    expect(result.records.map((record) => record.nativeAddress)).toEqual([
      evidence.sourceAddress,
      evidence.sourceAddress,
    ]);
    expect(result.records[0]?.acquisition.requestedAddress).not.toBe(
      evidence.sourceAddress,
    );
  });

  it("returns completed endpoint records alongside required endpoint failure diagnostics", async () => {
    let ajaxAttempts = 0;
    const collector = new DlsiteCollector(
      async (address) => {
        if (address.includes("ajax")) ajaxAttempts += 1;
        return {
          ok: !address.includes("ajax"),
          status: 503,
          headers: { get: () => "text/html" },
          arrayBuffer: async () =>
            new TextEncoder().encode("official page").buffer,
        };
      },
      async () => {},
    );
    const result = await collector.collect(evidence);

    expect(result.records).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("HTTP 503");
    expect(ajaxAttempts).toBe(3);
  });

  it("retains a successful product response when its requested identity is no longer exposed", async () => {
    const collector = new DlsiteCollector(async (address) =>
      address.includes("ajax")
        ? response("{}", "application/json")
        : {
            ok: false,
            status: 404,
            headers: { get: () => "text/html" },
            arrayBuffer: async () => new ArrayBuffer(0),
          },
    );

    const result = await collector.collect(evidence);

    expect(result.records.map((record) => record.coverage.id)).toEqual([
      "dlsite.product-json",
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("HTTP 404");
  });

  it("does not claim a foreign source association or perform network I/O", async () => {
    let requests = 0;
    const collector = new DlsiteCollector(async () => {
      requests += 1;
      throw new Error("network must not be reached");
    });
    const foreignAssociation = {
      ...evidence,
      kind: "source-association",
      sourceIdentity: "fanbox",
      producer: {
        capabilityId: "application.known-source-association",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    };

    expect(collector.canCollect(foreignAssociation)).toBe(false);
    expect(
      collector.canCollect({
        ...foreignAssociation,
        kind: "directed-source-address",
      }),
    ).toBe(false);
    expect(requests).toBe(0);
  });

  it("rejects foreign source evidence even when it carries a DLsite producer coordinate", async () => {
    let requests = 0;
    const collector = new DlsiteCollector(async () => {
      requests += 1;
      throw new Error("network must not be reached");
    });
    const conflictingEvidence = {
      ...evidence,
      sourceIdentity: "fanbox",
    };

    expect(collector.canCollect(conflictingEvidence)).toBe(false);
    const result = await collector.collect(conflictingEvidence);

    expect(requests).toBe(0);
    expect(result.records).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it.each([
    "http://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
    "https://example.test/maniax/work/=/product_id/RJ01668691.html",
    "https://www.dlsite.com/maniax/product/info/ajax?product_id=RJ01668691",
    "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html?redirect=internal",
  ])(
    "rejects an unsafe directed address before making any request: %s",
    async (sourceAddress) => {
      let requests = 0;
      const collector = new DlsiteCollector(async () => {
        requests += 1;
        throw new Error("network must not be reached");
      });

      const result = await collector.collect({
        ...evidence,
        kind: "directed-source-address",
        sourceAddress,
        producer: {
          capabilityId: "application.directed-recognition",
          capabilityVersion: "1",
          contractVersion: "1",
        },
      });

      expect(requests).toBe(0);
      expect(result.records).toEqual([]);
      expect(result.failures[0]?.reason).toContain(
        "official HTTPS product address",
      );
    },
  );

  it("normalizes an exact directed DLsite product address before collection", async () => {
    const requested: string[] = [];
    const collector = new DlsiteCollector(async (address) => {
      requested.push(address);
      return response(
        address.includes("ajax")
          ? JSON.stringify({ RJ01668691: { site_id: "maniax" } })
          : "<html></html>",
        address.includes("ajax") ? "application/json" : "text/html",
      );
    });

    const result = await collector.collect({
      ...evidence,
      kind: "directed-source-address",
      sourceAddress:
        "https://www.dlsite.com/maniax/work/=/product_id/rj01668691.html",
      producer: {
        capabilityId: "application.directed-recognition",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    });

    expect(requested).toHaveLength(2);
    expect(result.records.map((record) => record.nativeAddress)).toEqual([
      "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
      "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
    ]);
  });

  it("keeps interpretation generic and lets a separate recognizer emit the rule result", () => {
    const interpreter = new DlsiteSourceInterpreter();
    const json = {
      id: "json",
      sourceIdentity: "dlsite",
      nativeAddress: evidence.sourceAddress,
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "dlsite.product-json",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: JSON.stringify({
        RJ01668691: {
          work_name: "Title",
          regist_date: "2026-07-17",
          work_image: "//img.dlsite.jp/explicit.jpg",
          maker_id: "RG123",
          maker_name: "Circle",
          price: 660,
          voice: "Voice Name",
          scenario: "Scenario Name",
          illustration: "Illustrator",
          options: "SND#ENG#CHI_HANS#CHI_HANT#JPN#KO_KR#DLP",
          title_id: "SRI0000036577",
          title_name: "裏世界少女",
        },
      }),
    };
    const html = {
      ...json,
      id: "html",
      mediaType: "text/html",
      coverage: {
        id: "dlsite.product-html",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      body: '<meta name="description" content="Real introduction「DLsite store" />',
    };
    const [batch] = interpreter.interpret({
      evidence: [evidence],
      sourceRecords: [json, html],
    });
    assert.isDefined(batch);
    const proposal = new DlsiteExactRecognizer().recognize({
      evidence: [evidence],
      basis: { kind: "source-interpretation", interpretation: batch },
    });

    expect(batch.sourceAddress).toBe(evidence.sourceAddress);
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "asset.title", value: "Title" }),
        expect.objectContaining({
          property: "asset.declared-language",
          value: "ENG",
        }),
        expect.objectContaining({
          property: "asset.declared-language",
          value: "CHI_HANS",
        }),
        expect.objectContaining({
          property: "asset.declared-language",
          value: "JPN",
        }),
        expect.objectContaining({
          property: "asset.introduction",
          value: "Real introduction",
        }),
        expect.objectContaining({
          property: "dlsite.product.price-jpy",
          value: "660",
        }),
      ]),
    );
    expect(batch.metadata.map((entry) => entry.property)).not.toContain(
      "dlsite.product-id",
    );
    expect(batch.metadata.map((entry) => entry.property)).not.toContain(
      "dlsite.circle-id",
    );
    expect(batch.entities ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identityNamespace: "dlsite.circle",
          sourceKey: "RG123",
        }),
        expect.objectContaining({
          identityNamespace: "dlsite.credit.voice.voice.occurrence-local",
          label: "Voice Name",
        }),
        expect.objectContaining({
          identityNamespace: "dlsite.credit.scenario.scenario.occurrence-local",
          label: "Scenario Name",
        }),
        expect.objectContaining({
          identityNamespace:
            "dlsite.credit.illustration.illustration.occurrence-local",
          label: "Illustrator",
        }),
        expect.objectContaining({
          identityNamespace: "dlsite.series",
          sourceKey: "SRI0000036577",
          label: "裏世界少女",
        }),
      ]),
    );
    expect(batch.relationships ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participants: [expect.objectContaining({ role: "circle" })],
        }),
        expect.objectContaining({
          participants: [expect.objectContaining({ role: "voice" })],
        }),
        expect.objectContaining({
          type: "asset.membership",
          participants: [
            expect.objectContaining({ role: "dlsite.series.member" }),
          ],
        }),
      ]),
    );
    expect(batch.entityMentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "voice",
          role: "voice",
          label: "Voice Name",
        }),
        expect.objectContaining({ field: "scenario", role: "scenario" }),
      ]),
    );
    expect(batch.entityResolutionDecisions).toHaveLength(4);
    const [repeated] = interpreter.interpret({
      evidence: [evidence],
      sourceRecords: [json, html],
    });
    expect(repeated!.entityMentions?.map(({ id }) => id)).toEqual(
      batch.entityMentions?.map(({ id }) => id),
    );
    expect(
      repeated!.entities?.find(({ sourceKey }) => sourceKey === "RG123")?.id,
    ).toBe(batch.entities?.find(({ sourceKey }) => sourceKey === "RG123")?.id);
    const otherEvidence = {
      ...evidence,
      sourceAddress: evidence.sourceAddress.replace("RJ01668691", "RJ01668692"),
    };
    const [otherWork] = interpreter.interpret({
      evidence: [otherEvidence],
      sourceRecords: [
        {
          ...json,
          nativeAddress: otherEvidence.sourceAddress,
          body: json.body.replace("RJ01668691", "RJ01668692"),
        },
        { ...html, nativeAddress: otherEvidence.sourceAddress },
      ],
    });
    expect(
      otherWork!.entityMentions?.find(({ field }) => field === "voice")?.id,
    ).not.toBe(
      batch.entityMentions?.find(({ field }) => field === "voice")?.id,
    );
    expect(
      batch.entityMentions?.find(({ field }) => field === "voice")?.id,
    ).not.toBe(
      batch.entityMentions?.find(({ field }) => field === "scenario")?.id,
    );
    expect(proposal.ruleResults[0]).toMatchObject({
      capabilityId: "dlsite.exact-recognizer",
      ruleId: "exact-official-product-address",
      outcome: "satisfied",
    });
  });

  it("keeps an official zero yen DLsite price instead of treating it as missing", () => {
    const interpreter = new DlsiteSourceInterpreter();
    const json = {
      id: "json",
      sourceIdentity: "dlsite",
      nativeAddress: evidence.sourceAddress,
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "dlsite.product-json",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: JSON.stringify({
        RJ01668691: {
          work_name: "Bonus",
          regist_date: "2026-07-17",
          work_image: "//img.dlsite.jp/bonus.jpg",
          price: 0,
          discount_rate: 50,
          sales: 12345,
          ranking: { daily: 1 },
          rating: { average: 4.9, count: 456 },
          coupon: { available: true },
          campaign: { id: "summer" },
        },
      }),
    };
    const html = {
      ...json,
      id: "html",
      mediaType: "text/html",
      coverage: {
        id: "dlsite.product-html",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      body: "<html></html>",
    };

    const [batch] = interpreter.interpret({
      evidence: [evidence],
      sourceRecords: [json, html],
    });
    assert.isDefined(batch);

    expect(batch.metadata).toContainEqual(
      expect.objectContaining({
        property: "dlsite.product.price-jpy",
        value: "0",
      }),
    );
    expect(JSON.parse(json.body)).toMatchObject({
      RJ01668691: {
        discount_rate: 50,
        sales: 12345,
        ranking: { daily: 1 },
        rating: { average: 4.9, count: 456 },
        coupon: { available: true },
        campaign: { id: "summer" },
      },
    });
    expect(
      batch.metadata.some((item) =>
        [
          "dlsite.product.discount",
          "dlsite.product.sales",
          "dlsite.product.ranking",
          "dlsite.product.rating",
          "dlsite.product.coupon",
          "dlsite.product.campaign",
        ].includes(item.property),
      ),
    ).toBe(false);
  });

  it("interprets the official HTML product detail when the AJAX catalogue omits the product", () => {
    const interpreter = new DlsiteSourceInterpreter();
    const json = {
      id: "json",
      sourceIdentity: "dlsite",
      nativeAddress: evidence.sourceAddress,
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "dlsite.product-json",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: "[]",
    };
    const html = {
      ...json,
      id: "html",
      mediaType: "text/html",
      coverage: {
        id: "dlsite.product-html",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      body: `
        <a href="maker_id/RG123.html"><span>Circle</span></a>
        <meta name="description" content="Official introduction「DLsite store" />
        <script type="text/javascript">
          var contents = {
            "detail": [{
              "id": "RJ01668691",
              "name": "HTML Title",
              "brand": "RG123",
              "regist_date": "2026/07/17",
              "image_main": "//img.dlsite.jp/html-main.jpg",
              "age_category": 3,
              "title_id": "SRI0000057117",
              "title_name": "HTML Series",
              "lang_options": "SND#JPN#CHI_HANS#DLP"
            }],
            "time": 0.1
          };
        </script>
      `,
    };

    const [batch] = interpreter.interpret({
      evidence: [evidence],
      sourceRecords: [json, html],
    });
    assert.isDefined(batch);

    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "HTML Title",
          sourceRecordIds: ["html"],
        }),
        expect.objectContaining({
          property: "asset.release-date",
          value: "2026-07-17",
          sourceRecordIds: ["html"],
        }),
        expect.objectContaining({
          property: "asset.declared-language",
          value: "CHI_HANS",
          sourceRecordIds: ["html"],
        }),
      ]),
    );
    expect(batch.sourceArtifacts[0]).toMatchObject({
      acquisitionReference: "https://img.dlsite.jp/html-main.jpg",
      sourceRecordId: "html",
    });
    expect(batch.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identityNamespace: "dlsite.circle",
          sourceKey: "RG123",
          label: "Circle",
          sourceRecordIds: ["html"],
        }),
        expect.objectContaining({
          identityNamespace: "dlsite.series",
          sourceKey: "SRI0000057117",
          label: "HTML Series",
          sourceRecordIds: ["html"],
        }),
      ]),
    );
    expect(batch.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participants: [
            expect.objectContaining({ role: "dlsite.series.member" }),
          ],
          sourceRecordIds: ["html"],
        }),
      ]),
    );
  });

  it("does not turn provider N/A placeholders into entities, mentions, resolutions, or relationships", () => {
    const interpreter = new DlsiteSourceInterpreter();
    const json = {
      id: "json",
      sourceIdentity: "dlsite",
      nativeAddress: evidence.sourceAddress,
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "dlsite.product-json",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: JSON.stringify({
        RJ01668691: {
          work_name: "Title",
          regist_date: "2026-07-17",
          work_image: "//img.dlsite.jp/explicit.jpg",
          voice: "N/A",
          scenario: ["n/a"],
          illustration: " N/A ",
          author: "N/A",
        },
      }),
    };
    const html = {
      ...json,
      id: "html",
      mediaType: "text/html",
      coverage: {
        id: "dlsite.product-html",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      body: "<table><tr><th>声優</th><td>N/A</td></tr><tr><th>シナリオ</th><td>N/A</td></tr><tr><th>イラスト</th><td>N/A</td></tr><tr><th>作者</th><td>N/A</td></tr></table>",
    };

    const [batch] = interpreter.interpret({
      evidence: [evidence],
      sourceRecords: [json, html],
    });
    assert.isDefined(batch);

    expect(batch.entities).toEqual([]);
    expect(batch.entityMentions).toEqual([]);
    expect(batch.entityResolutionDecisions).toEqual([]);
    expect(batch.relationships).toEqual([]);
    expect(JSON.stringify(batch).toUpperCase()).not.toContain("N/A");
  });

  it("recognizes validated directed evidence as directed rather than pretending it was a directory rule", () => {
    const interpretation = {
      id: "interpretation",
      producer: {
        capabilityId: "dlsite.product-interpretation",
        capabilityVersion: "1",
        contractVersion: "1",
      },
      sourceRecordIds: ["json"],
      sourceIdentity: "dlsite",
      sourceAddress: evidence.sourceAddress,
      metadata: [],
      sourceArtifacts: [],
    };
    const proposal = new DlsiteExactRecognizer().recognize({
      evidence: [
        {
          ...evidence,
          kind: "directed-source-address",
          producer: {
            capabilityId: "application.directed-recognition",
            capabilityVersion: "1",
            contractVersion: "1",
          },
        },
      ],
      basis: { kind: "source-interpretation", interpretation },
    });
    expect(proposal.ruleResults[0]).toMatchObject({ outcome: "satisfied" });
    expect(proposal.ruleResults[0]?.explanation).toContain("用户指定");
  });

  it("uses the provider-declared main image and only falls back to an ordered carousel", () => {
    const interpreter = new DlsiteSourceInterpreter();
    const records = (workImage?: string) => [
      {
        id: "json",
        sourceIdentity: "dlsite",
        nativeAddress: evidence.sourceAddress,
        mediaType: "application/json",
        acquiredAt: "2026-07-29T00:00:00.000Z",
        acquisition: {
          requestedAddress: "json",
          method: "GET" as const,
          authorized: false,
        },
        coverage: {
          id: "dlsite.product-json",
          completeness: "complete" as const,
          authority: "official" as const,
        },
        digest: "digest",
        body: JSON.stringify({
          RJ01668691: {
            work_name: "Title",
            regist_date: "2026-07-17",
            ...(workImage === undefined ? {} : { work_image: workImage }),
          },
        }),
      },
      {
        id: "html",
        sourceIdentity: "dlsite",
        nativeAddress: evidence.sourceAddress,
        mediaType: "text/html",
        acquiredAt: "2026-07-29T00:00:00.000Z",
        acquisition: {
          requestedAddress: "html",
          method: "GET" as const,
          authorized: false,
        },
        coverage: {
          id: "dlsite.product-html",
          completeness: "complete" as const,
          authority: "official" as const,
        },
        digest: "digest",
        body: '<div class="work_slider"><img src="//img.dlsite.jp/carousel.png" /></div>',
      },
    ];
    expect(
      interpreter.interpret({
        evidence: [evidence],
        sourceRecords: records("//img.dlsite.jp/explicit.jpg"),
      })[0]?.sourceArtifacts[0]?.acquisitionReference,
    ).toBe("https://img.dlsite.jp/explicit.jpg");
    expect(
      interpreter.interpret({
        evidence: [evidence],
        sourceRecords: records(),
      })[0]?.sourceArtifacts[0],
    ).toMatchObject({
      acquisitionReference: "https://img.dlsite.jp/carousel.png",
      mediaType: "image/png",
      sourceRecordId: "html",
    });
  });

  it("leaves an absent primary cover as an optional candidate instead of failing interpretation", () => {
    const interpreter = new DlsiteSourceInterpreter();
    const json = {
      id: "json",
      sourceIdentity: "dlsite",
      nativeAddress: evidence.sourceAddress,
      mediaType: "application/json",
      acquiredAt: "2026-07-29T00:00:00.000Z",
      acquisition: {
        requestedAddress: "json",
        method: "GET" as const,
        authorized: false,
      },
      coverage: {
        id: "dlsite.product-json",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      digest: "digest",
      body: JSON.stringify({
        RJ01668691: {
          work_name: "Title",
          regist_date: "2026-07-17",
        },
      }),
    };
    const html = {
      ...json,
      id: "html",
      mediaType: "text/html",
      coverage: {
        id: "dlsite.product-html",
        completeness: "complete" as const,
        authority: "official" as const,
      },
      body: "<html></html>",
    };

    expect(
      interpreter.interpret({
        evidence: [evidence],
        sourceRecords: [json, html],
      })[0]?.sourceArtifacts,
    ).toEqual([]);
  });

  it("binds HTML-only circle and credit fallbacks to the HTML source record without normalising occurrences", () => {
    const interpreter = new DlsiteSourceInterpreter();
    const [batch] = interpreter.interpret({
      evidence: [evidence],
      sourceRecords: [
        {
          id: "json",
          sourceIdentity: "dlsite",
          nativeAddress: evidence.sourceAddress,
          mediaType: "application/json",
          acquiredAt: "2026-07-29T00:00:00.000Z",
          acquisition: {
            requestedAddress: "json",
            method: "GET" as const,
            authorized: false,
          },
          coverage: {
            id: "dlsite.product-json",
            completeness: "complete" as const,
            authority: "official" as const,
          },
          digest: "digest",
          body: JSON.stringify({
            RJ01668691: {
              work_name: "Title",
              regist_date: "2026-07-17",
              work_image: "//img.dlsite.jp/main.jpg",
              maker_id: "RG123",
            },
          }),
        },
        {
          id: "html",
          sourceIdentity: "dlsite",
          nativeAddress: evidence.sourceAddress,
          mediaType: "text/html",
          acquiredAt: "2026-07-29T00:00:00.000Z",
          acquisition: {
            requestedAddress: "html",
            method: "GET" as const,
            authorized: false,
          },
          coverage: {
            id: "dlsite.product-html",
            completeness: "complete" as const,
            authority: "official" as const,
          },
          digest: "digest-html",
          body: '<a href="maker_id/RG123.html"><span>Circle</span></a><table><tr><th>声優</th><td><a> A </a><a>A</a></td></tr></table>',
        },
      ],
    });
    assert.isDefined(batch);
    expect(
      batch.entities?.find(
        (entity) => entity.identityNamespace === "dlsite.circle",
      ),
    ).toMatchObject({
      sourceKey: "RG123",
      sourceRecordIds: ["html"],
    });
    expect(
      batch.entityMentions
        ?.filter((mention) => mention.field === "voice")
        .map((mention) => mention.label),
    ).toEqual([" A ", "A"]);
    expect(
      batch.entityMentions?.every(
        (mention) => mention.sourceRecordIds[0] === "html",
      ),
    ).toBe(true);
    expect(
      batch.relationships?.every(
        (relationship) => relationship.sourceRecordIds[0] === "html",
      ),
    ).toBe(true);
  });

  it("rejects a cover response whose content type or host does not match the candidate", async () => {
    const acquirer = new DlsiteArtifactAcquirer(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      arrayBuffer: async () => new TextEncoder().encode("not image").buffer,
    }));
    await expect(
      acquirer.acquire({
        id: "candidate",
        sourceRecordId: "record",
        role: "asset.primary-cover",
        acquisitionReference: "https://img.dlsite.jp/image.jpg",
        mediaType: "image/jpeg",
      }),
    ).rejects.toThrow("content type");
    expect(
      acquirer.canAcquire({
        id: "candidate",
        sourceRecordId: "record",
        role: "asset.primary-cover",
        acquisitionReference: "https://example.test/image.jpg",
        mediaType: "image/jpeg",
      }),
    ).toBe(false);
  });

  it("retries a transient official cover request before materializing bytes", async () => {
    let attempts = 0;
    const acquirer = new DlsiteArtifactAcquirer(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("temporary transport failure");
        return response("image", "image/jpeg");
      },
      async () => {},
    );

    const acquired = await acquirer.acquire({
      id: "candidate",
      sourceRecordId: "record",
      role: "asset.primary-cover",
      acquisitionReference: "https://img.dlsite.jp/image.jpg",
      mediaType: "image/jpeg",
    });

    expect(attempts).toBe(2);
    expect(acquired.bytes.byteLength).toBeGreaterThan(0);
  });
});
