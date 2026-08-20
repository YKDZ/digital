import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prerequisiteUnavailableFailure } from "@digital/application";

import {
  OmdbArtifactAcquirer,
  OmdbCollector,
  OmdbSourceAssociationCandidateInterpreter,
  OmdbSourceAssociationInterpreter,
  OmdbSourceInterpreter,
} from "../src/index.ts";

const response = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  arrayBuffer: async () =>
    new TextEncoder().encode(JSON.stringify(body)).buffer,
});

const input = {
  subjectId: "asset-1",
  recognitionSourceAssociation: {
    id: "tmdb-association",
    subjectId: "asset-1",
    sourceIdentity: "catalogue-a",
    nativeAddress: "https://catalogue-a.example/work/1",
    proposalId: "proposal-1",
  },
  recognitionDecisionId: "decision-1",
  sourceAssociations: [
    {
      id: "tmdb-association",
      subjectId: "asset-1",
      sourceIdentity: "catalogue-a",
      nativeAddress: "https://catalogue-a.example/work/1",
      proposalId: "proposal-1",
    },
  ],
  metadataSourceRecords: [
    { id: "catalogue-a-record", sourceIdentity: "catalogue-a" },
  ],
  metadata: [
    {
      property: "external.imdb-id",
      sourceSlot: "catalogue-a.imdb-id",
      value: "tt1234567",
      sourceRecordIds: ["catalogue-a-record"],
    },
    {
      property: "asset.title",
      sourceSlot: "catalogue-a.title",
      value: "Example Film",
      sourceRecordIds: ["catalogue-a-record"],
    },
    {
      property: "asset.release-date",
      sourceSlot: "catalogue-a.release-date",
      value: "2004-01-01",
      sourceRecordIds: ["catalogue-a-record"],
    },
  ],
  informationRequirement: {
    metadataUsageContext: "asset.ordinary",
    metadata: [{ property: "asset.awards", necessity: "optional" }],
    artifactRoles: [],
    relationshipTypes: [],
  },
} as const;

async function associationOutcome(
  expectedTitle: string,
  responseTitle: string,
) {
  const subject = {
    ...input,
    metadata: input.metadata.map((assertion) =>
      assertion.property === "asset.title"
        ? { ...assertion, value: expectedTitle }
        : assertion,
    ),
  };
  const evidence = new OmdbSourceAssociationCandidateInterpreter().interpret(
    subject,
  )!;
  const collection = await new OmdbCollector({
    apiKey: "private-key",
    request: async () =>
      response({
        Response: "True",
        imdbID: "tt1234567",
        Title: responseTitle,
        Year: "2004",
        Released: "01 Jan 2004",
      }),
  }).collect(evidence);
  const interpretation = new OmdbSourceInterpreter().interpret({
    evidence: [evidence],
    sourceRecords: collection.records,
  });
  return new OmdbSourceAssociationInterpreter().interpret({
    subject,
    evidence,
    interpretation,
  });
}

describe("OMDb film source enrichment", () => {
  it("classifies a missing private credential as a typed prerequisite failure", async () => {
    const evidence = new OmdbSourceAssociationCandidateInterpreter().interpret(
      input,
    )!;

    const result = await new OmdbCollector().collect(evidence);

    expect(result).toMatchObject({
      records: [],
      failures: [
        expect.objectContaining({
          failureClassification: prerequisiteUnavailableFailure,
        }),
      ],
    });
  });

  it("keeps exact-address planning and association validation as separate narrow capabilities", async () => {
    const candidateInterpreter =
      new OmdbSourceAssociationCandidateInterpreter();
    const associationInterpreter = new OmdbSourceAssociationInterpreter();
    const evidence = candidateInterpreter.interpret(input);

    expect(evidence).toMatchObject({
      sourceIdentity: "omdb",
      sourceAddress: "omdb:imdb:tt1234567",
    });
    const collection = await new OmdbCollector({
      apiKey: "private-key",
      request: async () =>
        response({
          Response: "True",
          imdbID: "tt1234567",
          Title: "example film",
          Year: "2004",
          Released: "06 Aug 2004",
        }),
    }).collect(evidence!);
    const interpretation = new OmdbSourceInterpreter().interpret({
      evidence: [evidence!],
      sourceRecords: collection.records,
    });

    expect(
      associationInterpreter.interpret({
        subject: input,
        evidence: evidence!,
        interpretation,
      }),
    ).toEqual({
      status: "accepted",
      explanation: "OMDb 响应与已接受身份的标识、年份和标题完全一致",
    });
  });

  it("does not derive identity evidence from another source's assertions", () => {
    const interpreter = new OmdbSourceAssociationCandidateInterpreter();

    expect(
      interpreter.interpret({
        ...input,
        metadata: input.metadata.map((assertion) => ({
          ...assertion,
          sourceRecordIds: ["unrelated-record"],
        })),
        metadataSourceRecords: [
          { id: "unrelated-record", sourceIdentity: "another-source" },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not fan out when the Information Requirement asks for no OMDb capability", () => {
    const interpreter = new OmdbSourceAssociationCandidateInterpreter();

    expect(
      interpreter.interpret({
        ...input,
        informationRequirement: {
          ...input.informationRequirement,
          metadata: [{ property: "unrelated.property", necessity: "optional" }],
        },
      }),
    ).toBeUndefined();
  });

  it("creates independently sourced assertions only after exact identifier, year, and title confirmation", async () => {
    const evidence = new OmdbSourceAssociationCandidateInterpreter().interpret(
      input,
    )!;
    const collector = new OmdbCollector({
      apiKey: "private-key",
      request: async (address) => {
        expect(new URL(address).searchParams.get("i")).toBe("tt1234567");
        return response({
          Response: "True",
          imdbID: "tt1234567",
          Title: "example film",
          Year: "2004",
          Plot: "Second source overview",
          Released: "06 Aug 2004",
          Runtime: "146 min",
          Awards: "Won 1 Oscar.",
          BoxOffice: "$77,911,774",
          Poster: "https://m.media-amazon.com/images/M/example-poster.jpg",
          imdbVotes: "202,345",
          Ratings: [
            { Source: "Internet Movie Database", Value: "7.7/10" },
            { Source: "Rotten Tomatoes", Value: "39%" },
            { Source: "Metacritic", Value: "47/100" },
          ],
        });
      },
    });

    const result = await collector.collect(evidence);
    const interpretation = new OmdbSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: result.records,
    });

    expect(result.failures).toEqual([]);
    expect(evidence).toMatchObject({
      sourceIdentity: "omdb",
      sourceAddress: "omdb:imdb:tt1234567",
    });
    expect(
      new OmdbSourceAssociationInterpreter().interpret({
        subject: input,
        evidence,
        interpretation,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(interpretation.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "example film",
        }),
        expect.objectContaining({
          property: "asset.introduction",
          value: "Second source overview",
        }),
        expect.objectContaining({
          property: "asset.release-date",
          value: "2004-08-06",
        }),
        expect.objectContaining({
          property: "asset.awards",
          value: "Won 1 Oscar.",
        }),
        expect.objectContaining({
          property: "asset.box-office",
          value: "$77,911,774",
        }),
        expect.objectContaining({
          property: "rating.imdb",
          value: "7.7/10",
          qualifiers: [
            { key: "rating.source-label", value: "Internet Movie Database" },
            { key: "rating.unit", value: "score" },
            { key: "rating.scale", value: "10" },
            { key: "rating.population", value: "202,345" },
          ],
        }),
        expect.objectContaining({
          property: "rating.rotten-tomatoes",
          value: "39%",
          qualifiers: [
            { key: "rating.source-label", value: "Rotten Tomatoes" },
            { key: "rating.unit", value: "percent" },
            { key: "rating.scale", value: "100" },
          ],
        }),
        expect.objectContaining({
          property: "rating.metacritic",
          value: "47/100",
          qualifiers: [
            { key: "rating.source-label", value: "Metacritic" },
            { key: "rating.unit", value: "score" },
            { key: "rating.scale", value: "100" },
          ],
        }),
      ]),
    );
    expect(interpretation.sourceArtifacts).toEqual([
      {
        id: "omdb.primary-poster",
        sourceRecordId: result.records[0]?.id,
        role: "asset.primary-cover",
        acquisitionReference:
          "https://m.media-amazon.com/images/M/example-poster.jpg",
        mediaType: "image/jpeg",
      },
    ]);
  });

  it("retains the source response but creates neither association nor facts when exact identity contradicts", async () => {
    const evidence = new OmdbSourceAssociationCandidateInterpreter().interpret(
      input,
    )!;
    const collector = new OmdbCollector({
      apiKey: "private-key",
      request: async () =>
        response({
          Response: "True",
          imdbID: "tt1234567",
          Title: "Different Film",
          Year: "2004",
        }),
    });

    const result = await collector.collect(evidence);
    const interpretation = new OmdbSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: result.records,
    });

    expect(result.records).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(
      new OmdbSourceAssociationInterpreter().interpret({
        subject: input,
        evidence,
        interpretation,
      }),
    ).toMatchObject({ status: "contradicted" });
  });

  it("accepts canonically equivalent NFC and decomposed titles without broadening title identity", async () => {
    expect(await associationOutcome("Caf\u00e9", "Cafe\u0301")).toMatchObject({
      status: "accepted",
    });
  });

  it("rejects a title with only punctuation changed", async () => {
    expect(
      await associationOutcome("The Terror Live", "The Terror, Live"),
    ).toMatchObject({ status: "contradicted" });
  });

  it("does not copy an API-key-bearing request failure into its public collection result", async () => {
    const evidence = new OmdbSourceAssociationCandidateInterpreter().interpret(
      input,
    )!;
    const result = await new OmdbCollector({
      apiKey: "omdb-error-key",
      request: async () => {
        throw new Error(
          "request failed at https://www.omdbapi.com/?apikey=omdb-error-key",
        );
      },
    }).collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ reason: "OMDb 官方来源请求未完成" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("omdb-error-key");
  });

  it("redacts an exact reflected API key before retaining an OMDb source record", async () => {
    const apiKey = "omdb-reflected-private-key";
    const reflectedResponse = (body: unknown) => ({
      ...response(body),
      headers: {
        get: () => `application/json; private=${apiKey}`,
      },
    });
    const evidence = new OmdbSourceAssociationCandidateInterpreter().interpret(
      input,
    )!;
    const result = await new OmdbCollector({
      apiKey,
      request: async () =>
        reflectedResponse({
          Response: "True",
          imdbID: "tt1234567",
          Title: "Example Film",
          Year: "2004",
          reflectedApiKey: apiKey,
        }),
    }).collect(evidence);

    expect(result.failures).toEqual([]);
    expect(result.records).toHaveLength(1);
    const record = result.records[0];
    expect(record.body).toContain("[REDACTED]");
    expect(record.body).not.toContain(apiKey);
    expect(record.mediaType).toBe("application/json");
    expect(record.digest).toBe(
      createHash("sha256").update(record.body).digest("hex"),
    );
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("treats an OMDb negative response envelope as a sanitized failed collection instead of a source record", async () => {
    const apiKey = "omdb-negative-envelope-private-key";
    const evidence = new OmdbSourceAssociationCandidateInterpreter().interpret(
      input,
    )!;
    const result = await new OmdbCollector({
      apiKey,
      request: async () =>
        response({
          Response: "False",
          Error: `Invalid API key at https://www.omdbapi.com/?apikey=${apiKey}`,
        }),
    }).collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        reason: "OMDb 官方来源未返回可用作品",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain("Invalid API key");
    expect(JSON.stringify(result)).not.toContain("www.omdbapi.com");
  });

  it("keeps a non-success OMDb response body outside the collection failure", async () => {
    const apiKey = "omdb-http-failure-private-key";
    const evidence = new OmdbSourceAssociationCandidateInterpreter().interpret(
      input,
    )!;
    const result = await new OmdbCollector({
      apiKey,
      request: async () => ({
        ok: false,
        status: 401,
        headers: { get: () => "application/json" },
        arrayBuffer: async () =>
          new TextEncoder().encode(
            `{"Error":"https://www.omdbapi.com/?apikey=${apiKey}"}`,
          ).buffer,
      }),
    }).collect(evidence);

    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ reason: "OMDb 官方来源请求失败：HTTP 401" }),
    ]);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain("www.omdbapi.com");
  });

  it("refreshes only the already-associated OMDb source address without reopening identity recognition", async () => {
    const collector = new OmdbCollector({
      apiKey: "private-key",
      request: async (address) => {
        expect(new URL(address).searchParams.get("i")).toBe("tt1234567");
        return response({
          Response: "True",
          imdbID: "tt1234567",
          Title: "Example Film",
          Year: "2004",
          Awards: "Won 1 Oscar.",
        });
      },
    });
    const evidence = {
      kind: "source-association" as const,
      sourceIdentity: "omdb",
      sourceAddress: "omdb:imdb:tt1234567",
      explanation: "refresh",
      producer: {
        capabilityId: "application.known-source-association",
        capabilityVersion: "1",
        contractVersion: "1",
      },
    };

    const collected = await collector.collect(evidence);
    const interpretation = new OmdbSourceInterpreter().interpret({
      evidence: [evidence],
      sourceRecords: collected.records,
    });

    expect(collected.failures).toEqual([]);
    expect(interpretation).toMatchObject({
      sourceIdentity: "omdb",
      sourceAddress: "omdb:imdb:tt1234567",
    });
    expect(interpretation.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.awards",
          value: "Won 1 Oscar.",
        }),
      ]),
    );
  });

  it("acquires only a valid OMDb poster candidate as bounded image bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const acquirer = new OmdbArtifactAcquirer(async (address) => {
      expect(address).toBe(
        "https://m.media-amazon.com/images/M/example-poster.jpg",
      );
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => bytes.buffer,
      };
    });
    const candidate = {
      id: "omdb.primary-poster",
      sourceRecordId: "omdb-record",
      role: "asset.primary-cover",
      acquisitionReference:
        "https://m.media-amazon.com/images/M/example-poster.jpg",
      mediaType: "image/jpeg",
    };

    await expect(acquirer.acquire(candidate)).resolves.toEqual({
      candidateId: candidate.id,
      sourceRecordId: candidate.sourceRecordId,
      bytes,
      mediaType: "image/jpeg",
    });
    expect(
      acquirer.canAcquire({
        ...candidate,
        role: "asset.background",
      }),
    ).toBe(false);
    expect(
      acquirer.canAcquire({
        ...candidate,
        acquisitionReference: "http://example.test/poster.jpg",
      }),
    ).toBe(false);
  });
});
