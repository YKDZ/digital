import { describe, expect, it, vi } from "vitest";

import {
  atPublicWorkflowBoundary,
  decodeAssetRefreshWorkflowInput,
  decodeObservedMaterialAssociationCheckpoint,
  decodeWorkflowExecutionInput,
  notifyWorkflowCheckpoint,
  WorkflowLifecycleInterruption,
} from "../src/index.ts";

const fulfillmentInput = {
  version: "asset-refresh-input/1",
  trigger: "information-fulfillment",
  initiatedBy: "information-fulfillment",
  acceptTrusted: false,
  configurationReferences: [],
  operation: {
    version: "information-fulfillment-operation/1",
    kind: "source-artifact-acquisition",
    subjectId: "subject",
    sourceIdentity: "source",
    sourceAssociationId: "association",
  },
} as const;

describe("Workflow Invocation Lifecycle", () => {
  it.each([
    "source-records-retained",
    "artifact-acquired",
    "artifact-stored",
    "change-impact-retained",
  ])(
    "preserves the caller error identity at the %s durable checkpoint",
    async (stage) => {
      const cause = new Error(`stop at ${stage}`);
      const hostCheckpoint = vi.fn();
      const operation = atPublicWorkflowBoundary(async () => {
        notifyWorkflowCheckpoint(
          {
            onCheckpoint: () => {
              throw cause;
            },
            onHostCheckpoint: hostCheckpoint,
          },
          { stage },
        );
      });

      await expect(operation).rejects.toBe(cause);
      expect(hostCheckpoint).not.toHaveBeenCalled();
    },
  );

  it("notifies caller before Host exactly once", () => {
    const events: string[] = [];

    notifyWorkflowCheckpoint(
      {
        onCheckpoint: () => events.push("caller"),
        onHostCheckpoint: () => events.push("host"),
      },
      { stage: "retained" },
    );

    expect(events).toEqual(["caller", "host"]);
  });

  it("marks a Host callback failure as lifecycle interruption", () => {
    const cause = new Error("Host is closing");

    expect(() =>
      notifyWorkflowCheckpoint(
        {
          onHostCheckpoint: () => {
            throw cause;
          },
        },
        { stage: "retained" },
      ),
    ).toThrow(WorkflowLifecycleInterruption);
  });
});

describe("Observed material association durable decoding", () => {
  const input = {
    version: "observed-material-association-input/1",
    trigger: "interactive",
    initiatedBy: "operator",
    acceptTrusted: false,
    configurationReferences: [],
    targetAssetId: "asset",
    registrationId: "registration",
    relativeScope: ".",
    relativePaths: ["document.pdf"],
  } as const;

  it("decodes only the exact observed-material input union member", () => {
    expect(decodeWorkflowExecutionInput(input)).toEqual({ valid: true, input });
    expect(
      decodeWorkflowExecutionInput({ ...input, undocumented: true }),
    ).toMatchObject({ valid: false });
    expect(
      decodeWorkflowExecutionInput({ ...input, relativePaths: [] }),
    ).toMatchObject({ valid: false });
  });

  it("keeps an early interrupted checkpoint inspectable but rejects extra fields", () => {
    const checkpoint = {
      version: "observed-material-association-checkpoint/1",
      state: "interrupted",
      input: {
        targetAssetId: "asset",
        registrationId: "registration",
        relativeScope: ".",
        relativePaths: ["document.pdf"],
        initiatedBy: "operator",
      },
    } as const;
    expect(
      decodeObservedMaterialAssociationCheckpoint(checkpoint),
    ).toMatchObject({
      valid: true,
    });
    expect(
      decodeObservedMaterialAssociationCheckpoint({
        ...checkpoint,
        secret: true,
      }),
    ).toMatchObject({ valid: false });
  });

  it("rejects awaiting-confirmation without its complete inspected state", () => {
    expect(
      decodeObservedMaterialAssociationCheckpoint({
        version: "observed-material-association-checkpoint/1",
        state: "awaiting-confirmation",
        input: {
          targetAssetId: "asset",
          registrationId: "registration",
          registrationVersion: 1,
          relativeScope: ".",
          relativePaths: ["document.pdf"],
          initiatedBy: "operator",
        },
        identityBaseline: "identity",
        materialBaseline: "material",
      }),
    ).toMatchObject({ valid: false });
  });

  it("rejects a structurally fake nested filesystem snapshot", () => {
    expect(
      decodeObservedMaterialAssociationCheckpoint({
        version: "observed-material-association-checkpoint/1",
        state: "inspecting",
        input: {
          targetAssetId: "asset",
          registrationId: "registration",
          registrationVersion: 1,
          relativeScope: ".",
          relativePaths: ["document.pdf"],
          initiatedBy: "operator",
        },
        identityBaseline: "identity",
        materialBaseline: "material",
        snapshot: { attackerControlled: "not-a-snapshot" },
      }),
    ).toMatchObject({ valid: false });
  });
});

describe("Information Fulfillment restart input", () => {
  it("decodes the explicit structured operation coordinate", () => {
    expect(decodeAssetRefreshWorkflowInput(fulfillmentInput)).toEqual({
      valid: true,
      input: fulfillmentInput,
    });
  });

  it.each([
    {
      name: "missing operation",
      input: { ...fulfillmentInput, operation: undefined },
    },
    {
      name: "unknown operation version",
      input: {
        ...fulfillmentInput,
        operation: { ...fulfillmentInput.operation, version: "unknown/9" },
      },
    },
    {
      name: "tampered operation field",
      input: {
        ...fulfillmentInput,
        operation: { ...fulfillmentInput.operation, providerSecret: "nope" },
      },
    },
  ])("fails closed for $name", ({ input }) => {
    expect(decodeAssetRefreshWorkflowInput(input)).toMatchObject({
      valid: false,
    });
  });

  it("rejects a nonempty frozen target closure that lacks its registered spelling", () => {
    expect(
      decodeAssetRefreshWorkflowInput({
        version: "asset-refresh-input/1",
        trigger: "interactive",
        initiatedBy: "user",
        acceptTrusted: false,
        configurationReferences: [],
        observedRoots: [
          {
            version: "observed-root-snapshot/1",
            id: "source",
            configVersion: 1,
            containerPath: "/observed/source",
            canonicalPath: "/canonical/source",
            readOnly: true,
            symlinkMode: "follow-file-links",
            allowedTargetRootIds: ["target"],
            authorizedTargetRoots: [
              {
                id: "target",
                configVersion: 1,
                canonicalPath: "/canonical/target",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason: "刷新版本化输入文件位置快照无效",
    });
  });
});
