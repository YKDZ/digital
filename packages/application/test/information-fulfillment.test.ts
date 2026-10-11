import { describe, expect, it } from "vitest";

import {
  InformationFulfillment,
  type InformationRequirement,
} from "../src/index.ts";

const titleRequirement: InformationRequirement = {
  metadataUsageContext: "asset.ordinary",
  metadata: [{ property: "asset.title", necessity: "required" }],
  artifactRoles: [],
  relationshipTypes: [],
};

describe("Information Fulfillment", () => {
  it("reports available, pending, unavailable, and blocked inputs through one neutral requirement", async () => {
    const starts: unknown[] = [];
    const fulfillment = new InformationFulfillment({
      async readSubjects({ subjectIds }) {
        return subjectIds.flatMap((subjectId) => {
          if (subjectId === "available") {
            return [
              {
                subjectId,
                metadata: [{ property: "asset.title" }],
                relationships: [],
                artifactAssociations: [],
                sourceAssociations: [],
              },
            ];
          }
          if (subjectId === "pending") {
            return [
              {
                subjectId,
                metadata: [],
                relationships: [],
                artifactAssociations: [],
                sourceAssociations: [{ sourceIdentity: "source-a" }],
              },
            ];
          }
          if (subjectId === "blocked") {
            return [
              {
                subjectId,
                metadata: [],
                relationships: [],
                artifactAssociations: [],
                sourceAssociations: [{ sourceIdentity: "source-b" }],
              },
            ];
          }
          return [
            {
              subjectId,
              metadata: [],
              relationships: [],
              artifactAssociations: [],
              sourceAssociations: [{ sourceIdentity: "source-c" }],
            },
          ];
        });
      },
      capabilities: [
        {
          declaration: {
            identity: "source-a.refresh",
            implementationVersion: "1",
            kind: "source-refresh",
            interpretationContractVersions: ["1"],
          },
          operation: "source-refresh",
          sourceIdentities: ["source-a"],
          metadataProperties: ["asset.title"],
          cost: "low",
          availability: "available",
        },
        {
          declaration: {
            identity: "source-b.refresh",
            implementationVersion: "1",
            kind: "source-refresh",
            interpretationContractVersions: ["1"],
          },
          operation: "source-refresh",
          sourceIdentities: ["source-b"],
          metadataProperties: ["asset.title"],
          cost: "low",
          availability: "blocked",
          reason: "Authorization: Bearer private-token",
        },
      ],
      async start(plan) {
        starts.push(plan);
        return { status: "pending", workflowExecutionId: "execution_pending" };
      },
    });

    const readiness = await fulfillment.fulfill({
      selection: {
        subjectIds: ["available", "pending", "unavailable", "blocked"],
      },
      requirement: titleRequirement,
    });

    expect(starts).toEqual([
      expect.objectContaining({
        subjectId: "pending",
        sourceIdentity: "source-a",
        operation: "source-refresh",
        requirement: titleRequirement,
      }),
    ]);
    expect(readiness.subjects).toEqual([
      expect.objectContaining({ subjectId: "available", status: "available" }),
      expect.objectContaining({
        subjectId: "pending",
        status: "pending",
        inputs: [
          expect.objectContaining({
            status: "pending",
            executionReferences: [{ workflowExecutionId: "execution_pending" }],
          }),
        ],
      }),
      expect.objectContaining({
        subjectId: "unavailable",
        status: "unavailable",
      }),
      expect.objectContaining({
        subjectId: "blocked",
        status: "blocked",
        inputs: [
          expect.objectContaining({
            status: "blocked",
            reason: "Authorization: [redacted]",
          }),
        ],
      }),
    ]);
  });

  it("uses an explicitly permitted enrichment instead of fanning out to every declared source", async () => {
    const starts: unknown[] = [];
    const fulfillment = new InformationFulfillment({
      async readSubjects() {
        return [
          {
            subjectId: "asset",
            metadata: [],
            relationships: [],
            artifactAssociations: [],
            sourceAssociations: [{ sourceIdentity: "known-source" }],
          },
        ];
      },
      capabilities: [
        {
          declaration: {
            identity: "permitted.enrichment",
            implementationVersion: "1",
            kind: "source-enrichment",
            interpretationContractVersions: ["1"],
          },
          operation: "source-enrichment",
          sourceIdentities: ["permitted-source"],
          metadataProperties: ["asset.introduction"],
          cost: "low",
          availability: "available",
        },
        {
          declaration: {
            identity: "unrelated.enrichment",
            implementationVersion: "1",
            kind: "source-enrichment",
            interpretationContractVersions: ["1"],
          },
          operation: "source-enrichment",
          sourceIdentities: ["unrelated-source"],
          metadataProperties: ["asset.introduction"],
          cost: "low",
          availability: "available",
        },
      ],
      policy: {
        permittedSourceEnrichments({ subjectId, coordinate }) {
          expect(subjectId).toBe("asset");
          expect(coordinate).toBe("asset.introduction");
          return [{ sourceIdentity: "permitted-source" }];
        },
      },
      async start(plan) {
        starts.push(plan);
        return { status: "pending", workflowExecutionId: "enrichment-1" };
      },
    });

    const readiness = await fulfillment.fulfill({
      selection: { subjectIds: ["asset"] },
      requirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [{ property: "asset.introduction", necessity: "optional" }],
        artifactRoles: [],
        relationshipTypes: [],
      },
    });

    expect(starts).toEqual([
      expect.objectContaining({
        subjectId: "asset",
        sourceIdentity: "permitted-source",
        operation: "source-enrichment",
      }),
    ]);
    expect(readiness.subjects[0]).toMatchObject({ status: "available" });
    expect(readiness.subjects[0]?.inputs).toEqual([
      expect.objectContaining({
        status: "pending",
        executionReferences: [{ workflowExecutionId: "enrichment-1" }],
      }),
    ]);
  });

  it("keeps the first initiated child when background fulfillment asks for the same work", async () => {
    const starts: unknown[] = [];
    const fulfillment = new InformationFulfillment({
      async readSubjects() {
        return [
          {
            subjectId: "asset",
            metadata: [],
            relationships: [],
            artifactAssociations: [],
            sourceAssociations: [{ sourceIdentity: "source" }],
          },
        ];
      },
      capabilities: [
        {
          declaration: {
            identity: "source.refresh",
            implementationVersion: "1",
            kind: "source-refresh",
            interpretationContractVersions: ["1"],
          },
          operation: "source-refresh",
          sourceIdentities: ["source"],
          metadataProperties: ["asset.title"],
          cost: "low",
          availability: "available",
        },
      ],
      async start(plan, initiation) {
        starts.push({ plan, initiation });
        return {
          status: "pending" as const,
          workflowExecutionId: `shared-execution-${starts.length}`,
        };
      },
    });
    const request = {
      selection: { subjectIds: ["asset"] },
      requirement: titleRequirement,
    } as const;

    const automatic = await fulfillment.fulfill({
      ...request,
      initiation: {
        version: "information-fulfillment-initiation/1",
        parentExecutionId: "automatic-parent",
      },
    });
    const background = await fulfillment.fulfill(request);

    // 在途复用按发起父隔离（information-fulfillment.ts:576-577 与 pendingKey :782-797）：
    // 自动化父的耐久子登记必须原样保留，后台轮询既不命中它也不改写它的发起归属。
    expect(starts).toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({
          subjectId: "asset",
          sourceIdentity: "source",
          operation: "source-refresh",
        }),
        initiation: {
          version: "information-fulfillment-initiation/1",
          parentExecutionId: "automatic-parent",
        },
      }),
      expect.objectContaining({
        initiation: undefined,
      }),
    ]);
    expect(automatic.subjects[0]?.inputs[0]).toMatchObject({
      status: "pending",
      executionReferences: [{ workflowExecutionId: "shared-execution-1" }],
    });
    expect(background.subjects[0]?.inputs[0]).toMatchObject({
      status: "pending",
      executionReferences: [{ workflowExecutionId: "shared-execution-2" }],
    });

    // 同一发起者（这里都是无父的后台轮询）的重复请求仍复用那一份在途工作，不产生第二份效果。
    const repeated = await fulfillment.fulfill(request);
    expect(starts).toHaveLength(2);
    expect(repeated).toEqual(background);
  });

  it("deduplicates concurrent callers before the durable execution reference is returned", async () => {
    let starts = 0;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fulfillment = new InformationFulfillment({
      async readSubjects() {
        return [
          {
            subjectId: "asset",
            metadata: [],
            relationships: [],
            artifactAssociations: [],
            sourceAssociations: [{ sourceIdentity: "source" }],
          },
        ];
      },
      capabilities: [
        {
          declaration: {
            identity: "source.refresh",
            implementationVersion: "1",
            kind: "source-refresh",
            interpretationContractVersions: ["1"],
          },
          operation: "source-refresh",
          sourceIdentities: ["source"],
          metadataProperties: ["asset.title"],
          cost: "low",
          availability: "available",
        },
      ],
      async start() {
        starts += 1;
        await started;
        return { status: "pending", workflowExecutionId: "shared-execution" };
      },
    });
    const request = {
      selection: { subjectIds: ["asset"] },
      requirement: titleRequirement,
    } as const;

    const interactive = fulfillment.fulfill(request);
    const automated = fulfillment.fulfill(request);
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toBe(1);
    release?.();

    await expect(Promise.all([interactive, automated])).resolves.toEqual([
      expect.any(Object),
      expect.any(Object),
    ]);
  });

  it("reconciles a cached pending execution after its durable source work is terminal", async () => {
    let starts = 0;
    let reconciliations = 0;
    const fulfillment = new InformationFulfillment({
      async readSubjects() {
        return [
          {
            subjectId: "asset",
            metadata: [],
            relationships: [],
            artifactAssociations: [],
            sourceAssociations: [{ sourceIdentity: "source" }],
          },
        ];
      },
      capabilities: [
        {
          declaration: {
            identity: "source.refresh",
            implementationVersion: "1",
            kind: "source-refresh",
            interpretationContractVersions: ["1"],
          },
          operation: "source-refresh",
          sourceIdentities: ["source"],
          metadataProperties: ["asset.title"],
          cost: "low",
          availability: "available",
        },
      ],
      async start() {
        starts += 1;
        return { status: "pending", workflowExecutionId: "execution-1" };
      },
      async reconcilePending({ plan, workflowExecutionId }) {
        reconciliations += 1;
        expect(plan).toMatchObject({
          subjectId: "asset",
          sourceIdentity: "source",
          operation: "source-refresh",
        });
        expect(workflowExecutionId).toBe("execution-1");
        return {
          status: "unavailable",
          reason: "Source Refresh Run 已终态且没有所需事实",
        };
      },
    });
    const request = {
      selection: { subjectIds: ["asset"] },
      requirement: titleRequirement,
    } as const;

    await expect(fulfillment.fulfill(request)).resolves.toMatchObject({
      subjects: [
        {
          status: "pending",
          inputs: [
            expect.objectContaining({
              executionReferences: [{ workflowExecutionId: "execution-1" }],
            }),
          ],
        },
      ],
    });
    await expect(fulfillment.fulfill(request)).resolves.toMatchObject({
      subjects: [
        {
          status: "unavailable",
          inputs: [
            expect.objectContaining({
              status: "unavailable",
              reason: "Source Refresh Run 已终态且没有所需事实",
              executionReferences: [{ workflowExecutionId: "execution-1" }],
            }),
          ],
        },
      ],
    });
    expect(starts).toBe(1);
    expect(reconciliations).toBe(1);
  });

  it("keeps the durable terminal execution reference while optional source outcomes remain unavailable", async () => {
    const terminalOutcomes = [
      ["no-image", "unavailable" as const],
      ["approved-without-fact", "unavailable" as const],
      ["rejected", "blocked" as const],
      ["cancelled", "blocked" as const],
      ["stale", "blocked" as const],
      ["acquirer-failed", "blocked" as const],
    ] as const;

    for (const [outcome, terminalStatus] of terminalOutcomes) {
      const executionId = `execution-${outcome}`;
      const fulfillment = new InformationFulfillment({
        async readSubjects() {
          return [
            {
              subjectId: "asset",
              metadata: [],
              relationships: [],
              artifactAssociations: [],
              sourceAssociations: [{ sourceIdentity: "source" }],
            },
          ];
        },
        capabilities: [
          {
            declaration: {
              identity: "source.artifact",
              implementationVersion: "1",
              kind: "source-artifact-acquirer",
              interpretationContractVersions: ["1"],
            },
            operation: "source-artifact-acquisition",
            sourceIdentities: ["source"],
            artifactRoles: ["asset.primary-cover"],
            cost: "low",
            availability: "available",
          },
        ],
        async start() {
          return { status: "pending", workflowExecutionId: executionId };
        },
        async reconcilePending() {
          return {
            status: terminalStatus,
            reason: `${outcome} terminal outcome`,
          };
        },
      });
      const request = {
        selection: { subjectIds: ["asset"] },
        requirement: {
          metadataUsageContext: "asset.ordinary",
          metadata: [],
          relationshipTypes: [],
          artifactRoles: [
            {
              role: "asset.primary-cover",
              necessity: "optional" as const,
              maximum: 1,
            },
          ],
        },
      } as const;

      await fulfillment.fulfill(request);
      await expect(fulfillment.fulfill(request)).resolves.toMatchObject({
        subjects: [
          {
            // 可选终态工作仍然可见，但不能阻塞主体；调用方仍可检查精确的持久尝试。
            status: "available",
            inputs: [
              {
                status: "unavailable",
                executionReferences: [{ workflowExecutionId: executionId }],
              },
            ],
          },
        ],
      });
    }
  });

  it("preserves the selected current Source Association identity in its work plan", async () => {
    const starts: unknown[] = [];
    const fulfillment = new InformationFulfillment({
      async readSubjects() {
        return [
          {
            subjectId: "asset",
            metadata: [],
            relationships: [],
            artifactAssociations: [],
            sourceAssociations: [
              {
                sourceIdentity: "source",
                sourceAssociationId: "current-source-association",
              },
            ],
          },
        ];
      },
      capabilities: [
        {
          declaration: {
            identity: "source.refresh",
            implementationVersion: "1",
            kind: "source-refresh",
            interpretationContractVersions: ["1"],
          },
          operation: "source-refresh",
          sourceIdentities: ["source"],
          metadataProperties: ["asset.title"],
          cost: "low",
          availability: "available",
        },
      ],
      async start(plan) {
        starts.push(plan);
        return { status: "pending", workflowExecutionId: "execution-1" };
      },
    });

    await fulfillment.fulfill({
      selection: { subjectIds: ["asset"] },
      requirement: titleRequirement,
    });

    expect(starts).toEqual([
      expect.objectContaining({
        subjectId: "asset",
        sourceIdentity: "source",
        sourceAssociationId: "current-source-association",
      }),
    ]);
  });
});
