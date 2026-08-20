import { InMemoryObservedFilesystemCapability } from "@digital/test-support";
import { describe, expect, it } from "vitest";

import {
  ObservedRootExecution,
  type ObservedRootRegistrations,
  type ObservedRootSnapshot,
  WorkflowLifecycleInterruption,
} from "../src/index.ts";

function root(id = "registered-root"): ObservedRootSnapshot {
  return {
    version: "observed-root-snapshot/1",
    id,
    configVersion: 1,
    containerPath: `/observed/${id}`,
    canonicalPath: `/observed/${id}`,
    readOnly: true,
    symlinkMode: "do-not-follow",
    allowedTargetRootIds: [],
  };
}

describe("Observed Root Execution", () => {
  it("owns registered resolution, frozen selection, invocation, and descriptor cleanup", async () => {
    const events: string[] = [];
    const filesystem = new InMemoryObservedFilesystemCapability({
      onBind: () => events.push("bind"),
      onClose: () => events.push("close"),
    });
    const registrations: Pick<
      ObservedRootRegistrations,
      "resolveActiveScope" | "closeBoundScope" | "reportCleanupFailure"
    > = {
      async resolveActiveScope({ registrationId, relativeScope }) {
        events.push("resolve");
        const observedRoot = root(registrationId);
        return {
          scope: await filesystem.bindScope({
            root: observedRoot,
            relativeScope,
          }),
          root: observedRoot,
          relativeScope,
        };
      },
      async closeBoundScope(scope) {
        events.push("release");
        await filesystem.closeScope(scope);
      },
      async reportCleanupFailure() {
        throw new Error("unexpected cleanup failure audit");
      },
    };

    const execution = new ObservedRootExecution(registrations);
    await expect(
      execution.invoke(
        {
          registrationId: "registered-root",
          relativeScope: "season-1",
          subjects: [
            {
              subjectId: "asset-1",
              explanations: [{ path: ["test"] }],
            },
          ],
        },
        async (input) => {
          events.push("invoke");
          expect(input.requestedSelection).toMatchObject({
            filesystemScopes: [
              {
                observedRoot: { id: "registered-root" },
                relativeScope: "season-1",
              },
            ],
          });
          expect(input.resolvedSelection).toEqual(input.requestedSelection);
          throw new Error("invocation failed");
        },
      ),
    ).rejects.toThrow("invocation failed");
    expect(events).toEqual(["resolve", "bind", "invoke", "release", "close"]);
  });

  it("closes its descriptor when the invocation fails", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    let closed = 0;
    const registrations: Pick<
      ObservedRootRegistrations,
      "resolveActiveScope" | "closeBoundScope" | "reportCleanupFailure"
    > = {
      async resolveActiveScope({ registrationId, relativeScope }) {
        const observedRoot = root(registrationId);
        return {
          scope: await filesystem.bindScope({
            root: observedRoot,
            relativeScope,
          }),
          root: observedRoot,
          relativeScope,
        };
      },
      async closeBoundScope(scope) {
        closed += 1;
        await filesystem.closeScope(scope);
      },
      async reportCleanupFailure() {
        throw new Error("unexpected cleanup failure audit");
      },
    };
    const execution = new ObservedRootExecution(registrations);

    await expect(
      execution.invoke(
        {
          registrationId: "registered-root",
          relativeScope: ".",
          subjects: [],
        },
        async () => {
          throw new Error("must not reach raw work");
        },
      ),
    ).rejects.toThrow("must not reach raw work");
    expect(closed).toBe(1);
  });

  it("derives durable location evidence from the frozen root, not an adapter location string", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const registrations: Pick<
      ObservedRootRegistrations,
      "resolveActiveScope" | "closeBoundScope" | "reportCleanupFailure"
    > = {
      async resolveActiveScope({ registrationId, relativeScope }) {
        const observedRoot = root(registrationId);
        const scope = await filesystem.bindScope({
          root: observedRoot,
          relativeScope,
        });
        Object.defineProperty(scope, "logicalLocation", {
          value: "/untrusted-adapter-location",
        });
        return { scope, root: observedRoot, relativeScope };
      },
      async closeBoundScope(scope) {
        await filesystem.closeScope(scope);
      },
      async reportCleanupFailure() {
        throw new Error("unexpected cleanup failure audit");
      },
    };

    const execution = new ObservedRootExecution(registrations);
    await execution.invoke(
      {
        registrationId: "registered-root",
        relativeScope: "season-1",
      },
      async ({ resolvedSelection }) => {
        expect(resolvedSelection.filesystemScopes).toEqual([
          expect.objectContaining({
            root: "/observed/registered-root/season-1",
            observedRoot: expect.objectContaining({ id: "registered-root" }),
            relativeScope: "season-1",
          }),
        ]);
      },
    );
  });

  it.each([
    {
      name: "returns work when work and descriptor close succeed",
      workFailure: undefined,
      closeFailure: undefined,
      expected: "completed",
      reportsCleanup: false,
    },
    {
      name: "throws descriptor close failure after successful work",
      workFailure: undefined,
      closeFailure: new Error("descriptor close failed"),
      expected: "descriptor close failed",
      reportsCleanup: true,
    },
    {
      name: "keeps work failure when descriptor close succeeds",
      workFailure: new Error("work failed"),
      closeFailure: undefined,
      expected: "work failed",
      reportsCleanup: false,
    },
    {
      name: "keeps work failure and audits descriptor close failure",
      workFailure: new Error("work failed"),
      closeFailure: new Error("descriptor close failed"),
      expected: "work failed",
      reportsCleanup: true,
    },
  ])(
    "$name",
    async ({ workFailure, closeFailure, expected, reportsCleanup }) => {
      const filesystem = new InMemoryObservedFilesystemCapability();
      const cleanupFailures: unknown[] = [];
      const closedScopes: unknown[] = [];
      const registrations = {
        async resolveActiveScope({
          registrationId,
          relativeScope,
        }: {
          readonly registrationId: string;
          readonly relativeScope: string;
        }) {
          const observedRoot = root(registrationId);
          return {
            scope: await filesystem.bindScope({
              root: observedRoot,
              relativeScope,
            }),
            root: observedRoot,
            relativeScope,
          };
        },
        async closeBoundScope(
          scope: Parameters<typeof filesystem.closeScope>[0],
        ) {
          closedScopes.push(scope);
          if (closeFailure !== undefined) throw closeFailure;
          await filesystem.closeScope(scope);
        },
        async reportCleanupFailure(input: unknown) {
          cleanupFailures.push(input);
        },
      } as unknown as Pick<
        ObservedRootRegistrations,
        "resolveActiveScope" | "closeBoundScope" | "reportCleanupFailure"
      >;
      const execution = new ObservedRootExecution(registrations);

      const operation = execution.invoke(
        {
          registrationId: "registered-root",
          relativeScope: "season-1",
        },
        async () => {
          if (workFailure !== undefined) throw workFailure;
          return "completed";
        },
      );

      if (workFailure === undefined && closeFailure === undefined) {
        await expect(operation).resolves.toBe(expected);
      } else {
        await expect(operation).rejects.toBe(workFailure ?? closeFailure);
      }
      expect(closedScopes).toHaveLength(1);
      if (!reportsCleanup) {
        expect(cleanupFailures).toEqual([]);
        return;
      }
      expect(cleanupFailures).toEqual([
        expect.objectContaining({
          operation: "observed-root-execution",
          cleanup: "close-bound-scope",
          rootId: "registered-root",
          relativeScope: "season-1",
          error: closeFailure,
          ...(workFailure === undefined ? {} : { primaryError: workFailure }),
        }),
      ]);
    },
  );

  it.each([
    {
      name: "keeps work failure when descriptor close and its audit reporter both fail",
      workFailure: new Error("work failed"),
    },
    {
      name: "keeps descriptor close failure when its audit reporter fails",
      workFailure: undefined,
    },
  ])("$name", async ({ workFailure }) => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const closeFailure = new Error("descriptor close failed");
    const reporterFailure = new Error("cleanup audit failed");
    const registrations = {
      async resolveActiveScope({
        registrationId,
        relativeScope,
      }: {
        readonly registrationId: string;
        readonly relativeScope: string;
      }) {
        const observedRoot = root(registrationId);
        return {
          scope: await filesystem.bindScope({
            root: observedRoot,
            relativeScope,
          }),
          root: observedRoot,
          relativeScope,
        };
      },
      async closeBoundScope() {
        throw closeFailure;
      },
      async reportCleanupFailure() {
        throw reporterFailure;
      },
    } as unknown as Pick<
      ObservedRootRegistrations,
      "resolveActiveScope" | "closeBoundScope" | "reportCleanupFailure"
    >;
    const execution = new ObservedRootExecution(registrations);

    await expect(
      execution.invoke(
        { registrationId: "registered-root", relativeScope: "." },
        async () => {
          if (workFailure !== undefined) throw workFailure;
          return "completed";
        },
      ),
    ).rejects.toBe(workFailure ?? closeFailure);
  });

  it("maps lifecycle interruptions once while preserving the caller's Chinese error", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const registrations: Pick<
      ObservedRootRegistrations,
      "resolveActiveScope" | "closeBoundScope" | "reportCleanupFailure"
    > = {
      async resolveActiveScope({ registrationId, relativeScope }) {
        const observedRoot = root(registrationId);
        return {
          scope: await filesystem.bindScope({
            root: observedRoot,
            relativeScope,
          }),
          root: observedRoot,
          relativeScope,
        };
      },
      async closeBoundScope(scope) {
        await filesystem.closeScope(scope);
      },
      async reportCleanupFailure() {
        throw new Error("unexpected cleanup failure audit");
      },
    };
    const execution = new ObservedRootExecution(registrations);
    const callerError = new Error("调用方中文检查点失败");

    await expect(
      execution.invoke(
        {
          registrationId: "registered-root",
          relativeScope: ".",
        },
        async () => {
          throw new WorkflowLifecycleInterruption(callerError);
        },
      ),
    ).rejects.toBe(callerError);
  });
});
