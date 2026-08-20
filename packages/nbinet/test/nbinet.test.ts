import { describe, expect, it } from "vitest";

import {
  NbinetCollector,
  NbinetExactIsbnRecognizer,
  NbinetSourceInterpreter,
} from "../src/index.js";

const evidence = [
  {
    kind: "artifact-format-inspection",
    explanation: "本地格式检查发现有效 ISBN-13",
    producer: {
      capabilityId: "epub.publication-inspection",
      capabilityVersion: "1",
      contractVersion: "1",
    },
    inspection: {
      identifiers: [{ scheme: "isbn-13", value: "9789864738281" }],
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
          role: "asset.primary-cover",
          locator: "epub:cover",
          mediaType: "image/jpeg",
        },
      ],
    },
  },
];

describe("NBINet exact ISBN source", () => {
  it("keeps a matching identifier boundary separate from another local inspection", () => {
    const recognizer = new NbinetExactIsbnRecognizer();
    const proposal = recognizer.recognize({
      evidence: [
        evidence[0],
        {
          ...evidence[0],
          inspection: {
            ...evidence[0].inspection,
            identifiers: [{ scheme: "isbn-13", value: "9786264151726" }],
            observedArtifactReference: "other.epub",
          },
        },
      ],
      interpretation: {
        id: "interpretation",
        producer: recognizer.capability,
        sourceRecordIds: [],
        sourceIdentity: "nbinet",
        sourceAddress:
          "https://nbinet.primo.exlibrisgroup.com/discovery/search?q=isbn%2Cexact%2C9789864738281",
        metadata: [],
        sourceArtifacts: [],
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
    const batch = interpreter.interpret({
      evidence,
      sourceRecords: official.records,
    });
    const proposal = new NbinetExactIsbnRecognizer().recognize({
      evidence,
      interpretation: batch,
    });

    expect(batch.sourceAddress).toContain("9789864738281");
    expect(batch.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "book.isbn-13",
          value: "9789864738281",
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
});

function response(body: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    arrayBuffer: async () => bytes.buffer,
  };
}
