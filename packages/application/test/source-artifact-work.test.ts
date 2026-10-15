import { assert, describe, expect, it } from "vitest";

import {
  CheckpointedSourceArtifactWork,
  projectManagedSourceArtifacts,
} from "../src/source-artifact-work.ts";

describe("checkpointed source-artifact work", () => {
  it("validates, acquires, stages, stores, and projects one provenance-bearing candidate", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const work = new CheckpointedSourceArtifactWork({
      acquirers: [
        {
          canAcquire: () => true,
          async acquire(candidate) {
            return {
              candidateId: candidate.id,
              sourceRecordId: candidate.sourceRecordId,
              bytes,
              mediaType: "image/jpeg",
            };
          },
        },
      ],
      managedStore: {
        async store() {
          throw new Error("checkpointed storage should be used");
        },
        async stage(content) {
          assert.isDefined(content.role);
          return {
            candidateId: content.candidateId,
            sourceRecordId: content.sourceRecordId,
            role: content.role,
            stagedReference: content.idempotencyKey,
            digest:
              "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            mediaType: content.mediaType,
          };
        },
        async storeStaged(checkpoint) {
          return {
            blob: {
              digest: checkpoint.digest,
              mediaType: checkpoint.mediaType,
              byteLength: bytes.byteLength,
            },
            location: { address: "/managed/cover.jpg" },
          };
        },
      },
    });
    const candidate = {
      id: "cover",
      sourceRecordId: "record",
      subjectId: "work",
      role: "asset.primary-cover",
      acquisitionReference: "opaque:cover",
      mediaType: "image/jpeg",
    };
    const proposal = {
      id: "proposal",
      boundaries: [],
      basis: {
        kind: "source-interpretation" as const,
        interpretation: {
          id: "interpretation",
          producer: {
            capabilityId: "interpreter",
            capabilityVersion: "1",
            contractVersion: "1",
          },
          sourceRecordIds: ["record"],
          sourceIdentity: "source",
          sourceAddress: "opaque:work",
          metadata: [],
          sourceArtifacts: [candidate],
        },
      },
      ruleResults: [],
    };
    const records = [
      {
        id: "record",
        sourceIdentity: "source",
        nativeAddress: "opaque:work",
        mediaType: "application/json",
        acquiredAt: "2026-07-30T00:00:00.000Z",
        acquisition: {
          requestedAddress: "https://source.example/work",
          method: "GET" as const,
          authorized: false,
        },
        coverage: {
          id: "complete",
          completeness: "complete" as const,
          authority: "official" as const,
        },
        digest: "record-digest",
        body: "{}",
      },
    ];

    const transitions: string[] = [];
    const [managed] = await work.complete({
      candidates: [candidate],
      proposal,
      sourceRecords: records,
      idempotencyKey: () => "execution:cover",
      requireCheckpointStore: true,
      onAcquired(checkpoints) {
        transitions.push(`acquired:${checkpoints[0]?.stagedReference}`);
      },
      onStored(checkpoints) {
        transitions.push(`stored:${checkpoints[0]?.location.address}`);
      },
    });
    if (managed === undefined) throw new Error("managed artifact missing");
    const projected = projectManagedSourceArtifacts([managed], "asset");

    expect(transitions).toEqual([
      "acquired:execution:cover",
      "stored:/managed/cover.jpg",
    ]);
    expect(managed).toMatchObject({
      candidateId: "cover",
      sourceRecordId: "record",
      subjectId: "work",
      role: "asset.primary-cover",
      location: { address: "/managed/cover.jpg" },
    });
    expect(projected.associations).toEqual([
      expect.objectContaining({
        target: { kind: "entity", entityId: "work" },
        role: "asset.primary-cover",
        sourceRecordIds: ["record"],
      }),
    ]);
    expect(projected.revisions[0]?.blobDigest).toBe(managed.blob.digest);
  });

  it("retains the complete semantic acquisition coordinate in durable checkpoints", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const candidate = {
      id: "cover",
      sourceRecordId: "record",
      subjectId: "work",
      role: "asset.primary-cover",
      acquisitionReference: "opaque:cover",
      mediaType: "image/jpeg",
    };
    const proposal = {
      id: "proposal",
      boundaries: [],
      basis: {
        kind: "source-interpretation" as const,
        interpretation: {
          id: "interpretation",
          producer: {
            capabilityId: "interpreter",
            capabilityVersion: "1",
            contractVersion: "1",
          },
          sourceRecordIds: ["record"],
          sourceIdentity: "source",
          sourceAddress: "opaque:work",
          metadata: [],
          sourceArtifacts: [candidate],
        },
      },
      ruleResults: [],
    };
    const work = new CheckpointedSourceArtifactWork({
      acquirers: [
        {
          canAcquire: () => true,
          async acquire() {
            return {
              candidateId: candidate.id,
              sourceRecordId: candidate.sourceRecordId,
              bytes,
              mediaType: candidate.mediaType,
            };
          },
        },
      ],
      managedStore: {
        async store() {
          throw new Error("not used");
        },
        async stage(content) {
          assert.isDefined(content.role);
          return {
            candidateId: content.candidateId,
            sourceRecordId: content.sourceRecordId,
            role: candidate.role,
            stagedReference: content.idempotencyKey,
            digest:
              "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            mediaType: candidate.mediaType,
          };
        },
      },
    });

    const { checkpoint } = await work.acquireAndStage({
      candidate,
      proposal,
      sourceRecords: [
        {
          id: "record",
          sourceIdentity: "source",
          nativeAddress: "opaque:work",
          mediaType: "application/json",
          acquiredAt: "2026-07-30T00:00:00.000Z",
          acquisition: {
            requestedAddress: "https://source.example/work",
            method: "GET" as const,
            authorized: false,
          },
          coverage: {
            id: "complete",
            completeness: "complete" as const,
            authority: "official" as const,
          },
          digest: "record-digest",
          body: "{}",
        },
      ],
      idempotencyKey: "execution:cover",
      requireCheckpointStore: true,
    });

    expect(checkpoint).toMatchObject({
      candidateId: candidate.id,
      sourceRecordId: candidate.sourceRecordId,
      subjectId: candidate.subjectId,
      role: candidate.role,
      acquisitionReference: candidate.acquisitionReference,
      mediaType: candidate.mediaType,
    });
  });

  it("does not derive one managed association from checkpoints with different acquisition coordinates", () => {
    const projected = projectManagedSourceArtifacts(
      [
        {
          candidateId: "cover",
          sourceRecordId: "record",
          subjectId: "work",
          role: "asset.primary-cover",
          acquisitionReference: "opaque:first-cover",
          blob: {
            digest: "same-bytes",
            mediaType: "image/jpeg",
            byteLength: 4,
          },
          location: { address: "/managed/same-bytes.jpg" },
        },
        {
          candidateId: "cover",
          sourceRecordId: "replacement-record",
          subjectId: "work",
          role: "asset.primary-cover",
          acquisitionReference: "opaque:first-cover",
          blob: {
            digest: "same-bytes",
            mediaType: "image/jpeg",
            byteLength: 4,
          },
          location: { address: "/managed/same-bytes.jpg" },
        },
        {
          candidateId: "cover",
          sourceRecordId: "record",
          subjectId: "work",
          role: "asset.primary-cover",
          acquisitionReference: "opaque:replacement-cover",
          blob: {
            digest: "same-bytes",
            mediaType: "image/jpeg",
            byteLength: 4,
          },
          location: { address: "/managed/same-bytes.jpg" },
        },
      ],
      "asset",
    );

    expect([
      ...new Set(projected.artifacts.map((artifact) => artifact.id)),
    ]).toHaveLength(3);
    expect([
      ...new Set(projected.associations.map((association) => association.id)),
    ]).toHaveLength(3);
  });

  it("refuses to resume storage from a legacy checkpoint without its complete acquisition coordinate", async () => {
    const work = new CheckpointedSourceArtifactWork({
      acquirers: [],
      managedStore: {
        async store() {
          throw new Error("not used");
        },
        async storeStaged(checkpoint) {
          return {
            blob: {
              digest: checkpoint.digest,
              mediaType: checkpoint.mediaType,
              byteLength: 4,
            },
            location: { address: "/managed/legacy-cover.jpg" },
          };
        },
      },
    });

    await expect(
      work.resumeStore({
        acquisitions: [
          {
            candidateId: "cover",
            sourceRecordId: "record",
            role: "asset.primary-cover",
            stagedReference: "staged:legacy-cover",
            digest:
              "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            mediaType: "image/jpeg",
          },
        ],
      }),
    ).rejects.toThrow("cannot safely resume");
  });
});
