import { describe, expect, it } from "vitest";

import {
  NbinetCollector,
  NbinetSourceAddressing,
  NbinetSourceAssociationInterpreter,
  NbinetExactIsbnRecognizer,
  NbinetSourceInterpreter,
} from "../src/index.ts";

const evidence = [
  {
    kind: "artifact-format-inspection",
    explanation: "本地格式检查发现有效 ISBN-13",
    producer: {
      capabilityId: "epub.publication-inspection",
      capabilityVersion: "2",
      contractVersion: "2",
      identity: "epub.publication-inspection",
      implementationVersion: "2",
      kind: "artifact-format-inspector",
      interpretationContractVersions: ["2"],
    },
    inspection: {
      identifiers: [
        {
          scheme: "isbn-13",
          value: "9789864738281",
          locators: ["epub:OPS/book.opf#/metadata/dc:identifier[1]"],
        },
      ],
      observedArtifactReference: "book.epub",
      revision: {
        digest: "a".repeat(64),
        mediaType: "application/epub+zip",
        byteLength: 1,
      },
      metadata: [
        {
          property: "asset.title",
          sourceSlot: "opf.title",
          value: "幼女战记(1)",
          locator: "epub:opf/dc:title[1]",
        },
      ],
      parts: [
        {
          role: "asset.material-image",
          locator: "epub:cover",
          mediaType: "image/jpeg",
        },
      ],
    },
  },
];

describe("NBINet exact ISBN source", () => {
  it("declares and normalizes explicit ISBN input without EPUB evidence", () => {
    const addressing = new NbinetSourceAddressing();

    expect(addressing.inputRequirement).toEqual({
      sourceIdentity: "nbinet",
      displayName: "国家图书馆书目",
      fields: [
        expect.objectContaining({
          key: "isbn",
          required: true,
          acceptedInput: "ISBN-13 编号或国家图书馆完整书目地址",
        }),
      ],
    });
    const normalized = addressing.normalize({ isbn: "ISBN 978-986-473-828-1" });
    expect(normalized.status).toBe("accepted");
    if (normalized.status !== "accepted") throw new Error(normalized.reason);
    expect(normalized.evidence).toMatchObject({
      kind: "directed-source-address",
      sourceIdentity: "nbinet",
      sourceAddress: expect.stringContaining("isbn%2Cexact%2C9789864738281"),
    });
    expect(
      addressing.normalize({
        isbn: normalized.evidence.sourceAddress,
      }),
    ).toMatchObject({
      status: "accepted",
      normalizedInput: { isbn: "9789864738281" },
      evidence: { sourceAddress: normalized.evidence.sourceAddress },
    });
    expect(
      addressing.normalize({ isbn: "https://example.com/9789864738281" }),
    ).toEqual({ status: "invalid", reason: expect.any(String) });
    expect(addressing.normalize({})).toEqual({
      status: "invalid",
      reason: expect.any(String),
    });
  });

  it("requests only one unique valid ISBN and does not request conflicts", async () => {
    const requested: string[] = [];
    const collector = new NbinetCollector(async (address) => {
      requested.push(address);
      return response({ docs: [] });
    });
    const conflict = {
      ...evidence[0],
      inspection: {
        ...evidence[0].inspection,
        identifiers: [
          {
            scheme: "isbn-13",
            value: "9789864738281",
            locators: ["epub:OPS/book.opf#/metadata/dc:identifier[1]"],
          },
          {
            scheme: "isbn-13",
            value: "9786264151726",
            locators: ["epub:OPS/book.opf#/metadata/dc:identifier[2]"],
          },
        ],
      },
    };

    expect(collector.canCollect(evidence[0])).toBe(true);
    expect(collector.canCollect(conflict)).toBe(false);
    await expect(collector.collect(conflict)).resolves.toMatchObject({
      records: [],
      failures: [{ reason: expect.stringContaining("唯一有效 ISBN") }],
    });
    expect(requested).toEqual([]);
    await collector.collect(evidence[0]);
    expect(requested).toEqual([
      expect.stringMatching(
        /^https:\/\/nbinet\.primo\.exlibrisgroup\.com\/primaws\/rest\/pub\/pnxs\?.*q=isbn%2Cexact%2C9789864738281/u,
      ),
    ]);
  });

  it("rejects explicit enrichment when the accepted subject carries a different ISBN", () => {
    const addressing = new NbinetSourceAddressing().normalize({
      isbn: "9789864738281",
    });
    if (addressing.status !== "accepted") throw new Error(addressing.reason);
    const association = new NbinetSourceAssociationInterpreter();
    const interpretation = {
      id: "interpretation",
      producer: new NbinetSourceInterpreter().capability,
      sourceRecordIds: ["record"],
      sourceIdentity: "nbinet",
      sourceAddress: addressing.evidence.sourceAddress,
      metadata: [],
      sourceArtifacts: [],
    };
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
          value: "9786264151726",
          sourceRecordIds: ["local-record"],
        },
      ],
    };

    expect(
      association.interpret({
        subject,
        evidence: addressing.evidence,
        interpretation,
      }),
    ).toEqual({
      status: "contradicted",
      explanation: expect.stringContaining("矛盾"),
    });
    expect(
      association.interpret({
        subject: { ...subject, metadata: [] },
        evidence: addressing.evidence,
        interpretation,
      }),
    ).toMatchObject({ status: "accepted" });
  });

  it("keeps a matching identifier boundary separate from another local inspection", () => {
    const recognizer = new NbinetExactIsbnRecognizer();
    const proposal = recognizer.recognize({
      evidence: [
        evidence[0],
        {
          ...evidence[0],
          inspection: {
            ...evidence[0].inspection,
            identifiers: [
              {
                scheme: "isbn-13",
                value: "9786264151726",
                locators: ["epub:OPS/book.opf#/metadata/dc:identifier[1]"],
              },
            ],
            observedArtifactReference: "other.epub",
          },
        },
      ],
      basis: {
        kind: "source-interpretation",
        interpretation: {
          id: "interpretation",
          producer: new NbinetSourceInterpreter().capability,
          sourceRecordIds: [],
          sourceIdentity: "nbinet",
          sourceAddress:
            "https://nbinet.primo.exlibrisgroup.com/discovery/search?q=isbn%2Cexact%2C9789864738281",
          metadata: [],
          sourceArtifacts: [],
        },
      },
    });
    expect(proposal.ruleResults[0].evidence).toEqual([evidence[0]]);
  });

  it("accepts only an official record that explicitly contains the EPUB ISBN", async () => {
    const collector = new NbinetCollector(async () =>
      response({
        docs: [
          {
            pnx: {
              display: {
                title: ["幼女戰記"],
                creator: ["東條チカ"],
                publisher: ["臺灣角川"],
                creationdate: ["2017"],
                language: ["chi"],
              },
              addata: { isbn: ["9789864738281", "9786264151726"] },
            },
          },
        ],
        info: { total: 1 },
      }),
    );
    const official = await collector.collect(evidence[0]);
    const interpreter = new NbinetSourceInterpreter();
    const [batch] = interpreter.interpret({
      evidence,
      sourceRecords: official.records,
    });
    const proposal = new NbinetExactIsbnRecognizer().recognize({
      evidence,
      basis: { kind: "source-interpretation", interpretation: batch },
    });

    expect(batch.sourceAddress).toContain("9789864738281");
    expect(batch.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "東條チカ",
          identityNamespace: "nbinet.contributor.occurrence-local",
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
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "book.isbn-13",
          value: "9789864738281",
        }),
        expect.objectContaining({
          property: "asset.title",
          value: "幼女戰記",
        }),
        expect.objectContaining({
          property: "book.contributor",
          value: "東條チカ",
        }),
        expect.objectContaining({
          property: "book.publisher",
          value: "臺灣角川",
        }),
        expect.objectContaining({
          property: "book.publication-date",
          value: "2017",
        }),
        expect.objectContaining({
          property: "asset.declared-language",
          value: "chi",
        }),
      ]),
    );
    expect(proposal.ruleResults[0]).toMatchObject({ outcome: "satisfied" });
    expect(Object.keys(proposal).toSorted()).toEqual(["id", "ruleResults"]);
    expect(batch.sourceArtifacts).toEqual([]);
    expect(
      batch.metadata.every(
        (item) => item.sourceRecordIds[0] === official.records[0].id,
      ),
    ).toBe(true);
  });

  it("interprets the contributor display contract without leaking its authority control form", async () => {
    const collector = new NbinetCollector(async () =>
      response({
        docs: [
          {
            pnx: {
              display: {
                title: ["妹妹人生 上"],
                creator: ["入间人间、入間人間$$Q入間人間"],
              },
              addata: { isbn: ["9789578531222"] },
            },
          },
        ],
        info: { total: 1 },
      }),
    );
    const isbnEvidence = {
      ...evidence[0],
      inspection: {
        ...evidence[0].inspection,
        identifiers: [
          {
            ...evidence[0].inspection.identifiers[0],
            value: "9789578531222",
          },
        ],
      },
    };
    const [record] = (await collector.collect(isbnEvidence)).records;
    const [batch] = new NbinetSourceInterpreter().interpret({
      evidence: [isbnEvidence],
      sourceRecords: [record],
    });

    expect(
      batch.metadata
        .filter(({ property }) => property === "book.contributor")
        .map(({ value }) => value),
    ).toEqual(["入间人间", "入間人間"]);
  });

  it("fails closed when more than one official response record can match", () => {
    const duplicate = sourceRecord({
      docs: [{ pnx: { addata: { isbn: ["9789864738281"] } } }],
    });
    expect(() =>
      new NbinetSourceInterpreter().interpret({
        evidence,
        sourceRecords: [duplicate, { ...duplicate, id: "official-2" }],
      }),
    ).toThrow(/unique|唯一|恰有/u);
  });

  it("fails closed for zero or multiple body matches and an address conflict", () => {
    const interpreter = new NbinetSourceInterpreter();
    for (const docs of [
      [{ pnx: { addata: { isbn: ["9786264151726"] } } }],
      [{ pnx: { addata: { isbn: ["junk9789864738281tail"] } } }],
      [
        { pnx: { addata: { isbn: ["9789864738281"] } } },
        { pnx: { addata: { isbn: ["9789864738281"] } } },
      ],
    ]) {
      expect(() =>
        interpreter.interpret({
          evidence,
          sourceRecords: [sourceRecord({ docs })],
        }),
      ).toThrow(/唯一/u);
    }
    expect(() =>
      interpreter.interpret({
        evidence,
        sourceRecords: [
          {
            ...sourceRecord({
              docs: [{ pnx: { addata: { isbn: ["9789864738281"] } } }],
            }),
            nativeAddress: sourceRecord({}).nativeAddress.replace(
              "9789864738281",
              "9786264151726",
            ),
          },
        ],
      }),
    ).toThrow(/disagree|address/u);
  });

  it("rejects incomplete or forged producer coordinates at every NBINet trust boundary", () => {
    const collector = new NbinetCollector(async () => response({ docs: [] }));
    const {
      implementationVersion: _missingImplementation,
      ...missingImplementation
    } = evidence[0].producer;
    expect(
      collector.canCollect({
        ...evidence[0],
        producer: { ...evidence[0].producer, capabilityId: "forged.epub" },
      }),
    ).toBe(false);
    expect(
      collector.canCollect({ ...evidence[0], producer: missingImplementation }),
    ).toBe(false);

    const interpreter = new NbinetSourceInterpreter();
    const record = sourceRecord({
      docs: [{ pnx: { addata: { isbn: ["9789864738281"] } } }],
    });
    const forgedRecord = {
      ...record,
      producer: { ...record.producer, contractVersion: "forged" },
    };
    const {
      interpretationContractVersions: _missingInterpretationContract,
      ...missingInterpretationContract
    } = evidence[0].producer;
    expect(
      interpreter.canInterpret({
        evidence,
        sourceRecords: [forgedRecord],
      }),
    ).toBe(false);
    expect(() =>
      interpreter.interpret({ evidence, sourceRecords: [forgedRecord] }),
    ).toThrow(/producer|coordinate/u);
    expect(
      interpreter.canInterpret({
        evidence: [{ ...evidence[0], producer: missingInterpretationContract }],
        sourceRecords: [record],
      }),
    ).toBe(false);

    const [batch] = interpreter.interpret({
      evidence,
      sourceRecords: [record],
    });
    const recognizer = new NbinetExactIsbnRecognizer();
    const forgedInterpretation = {
      ...batch,
      producer: { ...batch.producer, capabilityVersion: "forged" },
    };
    const input = {
      evidence,
      basis: {
        kind: "source-interpretation" as const,
        interpretation: forgedInterpretation,
      },
    };
    expect(recognizer.canRecognize(input)).toBe(false);
    expect(() => recognizer.recognize(input)).toThrow(/producer|coordinate/u);
  });
});

function sourceRecord(body: unknown) {
  return {
    id: "official-1",
    sourceIdentity: "nbinet",
    nativeAddress:
      "https://nbinet.primo.exlibrisgroup.com/discovery/search?inst=886NCL_NBINET&vid=886NCL_NBINET%3ANBINET&lang=zh-tw&q=isbn%2Cexact%2C9789864738281&scope=MyInstitution&tab=NBINET&skipDelivery=Y",
    mediaType: "application/json",
    acquiredAt: "2026-08-30T00:00:00.000Z",
    acquisition: {
      requestedAddress:
        "https://nbinet.primo.exlibrisgroup.com/primaws/rest/pub/pnxs",
      method: "GET" as const,
      authorized: false,
    },
    coverage: {
      id: "nbinet.exact-isbn",
      completeness: "complete" as const,
      authority: "official" as const,
    },
    digest: "b".repeat(64),
    body: JSON.stringify(body),
    producer: {
      capabilityId: "nbinet.exact-isbn-collection",
      capabilityVersion: "1",
      contractVersion: "1",
      identity: "nbinet.exact-isbn-collection",
      implementationVersion: "1",
      kind: "source-collector",
      interpretationContractVersions: ["1"],
    },
  };
}

function response(body: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    arrayBuffer: async () => bytes.buffer,
  };
}
