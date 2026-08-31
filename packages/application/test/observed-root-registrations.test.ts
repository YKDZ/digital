import { InMemoryObservedFilesystemCapability } from "@digital/test-support";
import { describe, expect, it } from "vitest";

import {
  ObservedRootRegistrations,
  type ObservedRootRegistration,
} from "../src/index.ts";

function registeredRoot(id = "registered-root"): ObservedRootRegistration {
  return {
    id,
    displayName: id,
    containerPath: `/observed/${id}`,
    canonicalPath: `/observed/${id}`,
    status: "active",
    configVersion: 1,
    readOnly: true,
    symlinkMode: "do-not-follow",
    allowedTargetRootIds: [],
  };
}

function registrationsFor(
  filesystem: InMemoryObservedFilesystemCapability,
  input:
    | unknown[]
    | {
        readonly cleanupFailures?: unknown[];
        readonly reportingFailures?: unknown[];
        readonly reportCleanupFailure?: (
          value: unknown,
        ) => void | Promise<void>;
        readonly reportCleanupReportingFailure?: (
          value: unknown,
        ) => void | Promise<void>;
        readonly operationSupervisor?: {
          invalidateObservedRoot(input: {
            readonly registrationId: string;
            readonly keepVersion?: number;
          }): void;
        };
      } = {},
): ObservedRootRegistrations {
  const roots = new Map([["registered-root", registeredRoot()]]);
  const options = Array.isArray(input) ? { cleanupFailures: input } : input;
  const reportCleanupFailure =
    options.reportCleanupFailure ??
    ((value: unknown) => {
      options.cleanupFailures?.push(value);
    });
  const reportCleanupReportingFailure =
    options.reportCleanupReportingFailure ??
    ((value: unknown) => {
      options.reportingFailures?.push(value);
    });
  return new ObservedRootRegistrations({
    commands: {
      async createObservedRootRegistration(registration) {
        roots.set(registration.id, registration);
      },
      async replaceObservedRootRegistration({ registration }) {
        roots.set(registration.id, registration);
        return true;
      },
      async revokeObservedRootRegistration({ registration }) {
        roots.set(registration.id, registration);
        return true;
      },
    },
    queries: {
      async getObservedRootRegistration(id) {
        return roots.get(id);
      },
      async listObservedRootRegistrations() {
        return [...roots.values()];
      },
    },
    filesystem,
    productDataDirectory: "/product-data",
    managedArtifactDirectory: "/product-data/managed-artifacts",
    cleanupFailureReporter: {
      reportCleanupFailure,
    },
    cleanupFailureFallback: {
      reportCleanupReportingFailure,
    },
    ...(options.operationSupervisor === undefined
      ? {}
      : { operationSupervisor: options.operationSupervisor }),
  });
}

describe("Observed Root Registrations", () => {
  it("在成功撤销返回前失效该登记的活动短操作", async () => {
    const invalidated: unknown[] = [];
    const registrations = registrationsFor(
      new InMemoryObservedFilesystemCapability(),
      {
        operationSupervisor: {
          invalidateObservedRoot(input) {
            invalidated.push(input);
          },
        },
      },
    );

    await registrations.deactivate({
      id: "registered-root",
      expectedVersion: 1,
    });

    expect(invalidated).toEqual([{ registrationId: "registered-root" }]);
  });
  it("observes the exact current registered scope through its bound capability", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const registrations = registrationsFor(filesystem);
    const resolved = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: "season-1",
    });

    try {
      await expect(
        registrations.observeBoundScope(resolved.scope),
      ).resolves.toMatchObject({
        root: "/observed/registered-root/season-1",
      });
    } finally {
      await registrations.closeBoundScope(resolved.scope);
    }
  });

  it("maps a post-bind adapter observation failure to the neutral unavailable-root boundary", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability({
      observe: () => {
        throw new Error("adapter-specific mount diagnostic");
      },
    });
    const registrations = registrationsFor(filesystem);
    const resolved = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: ".",
    });

    try {
      await expect(
        registrations.observeBoundScope(resolved.scope),
      ).rejects.toThrow("文件位置当前缺失、不可读或范围越界");
    } finally {
      await registrations.closeBoundScope(resolved.scope);
    }
  });

  it("refuses a scope that its registration service did not bind", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const registrations = registrationsFor(filesystem);
    const resolved = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: ".",
    });
    const foreign = await filesystem.bindScope({
      root: resolved.root,
      relativeScope: ".",
    });

    try {
      await expect(registrations.observeBoundScope(foreign)).rejects.toThrow(
        "不属于当前文件位置登记",
      );
      await expect(
        registrations.openBoundByteSource({
          scope: foreign,
          relativePath: "track.flac",
        }),
      ).rejects.toThrow("不属于当前文件位置登记");
    } finally {
      await filesystem.closeScope(foreign);
      await registrations.closeBoundScope(resolved.scope);
    }
  });

  it("revokes observation and byte delivery after closing its bound scope", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const registrations = registrationsFor(filesystem);
    const resolved = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: ".",
    });

    await registrations.closeBoundScope(resolved.scope);

    await expect(
      registrations.observeBoundScope(resolved.scope),
    ).rejects.toThrow("不属于当前文件位置登记");
    await expect(
      registrations.openBoundByteSource({
        scope: resolved.scope,
        relativePath: "track.flac",
      }),
    ).rejects.toThrow("不属于当前文件位置登记");
  });

  it("rejects a parent-escaping relative scope before the filesystem capability binds it", async () => {
    let binds = 0;
    const filesystem = new InMemoryObservedFilesystemCapability({
      onBind: () => {
        binds += 1;
      },
    });
    const registrations = registrationsFor(filesystem);

    await expect(
      registrations.resolveActiveScope({
        registrationId: "registered-root",
        relativeScope: "../outside",
      }),
    ).rejects.toThrow("范围不能越过登记根目录");
    expect(binds).toBe(0);
  });

  it("rejects a capability snapshot whose root differs from its frozen bound scope", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability({
      observe: () => ({
        id: "spoofed-snapshot",
        root: "/outside/registered-root",
        complete: true,
        files: [],
        excluded: [],
        observedAt: "2026-08-12T00:00:00.000Z",
      }),
    });
    const registrations = registrationsFor(filesystem);
    const resolved = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: "season-1",
    });

    try {
      await expect(
        registrations.observeBoundScope(resolved.scope),
      ).rejects.toThrow("观察结果超出已登记范围");
    } finally {
      await registrations.closeBoundScope(resolved.scope);
    }
  });

  it("closes an opened byte source when its active scope cannot close", async () => {
    const scopeCloseFailure = new Error("scope close failed");
    let sourceCloseCalls = 0;
    const filesystem = new InMemoryObservedFilesystemCapability({
      onClose: () => {
        throw scopeCloseFailure;
      },
      onByteSourceClose: () => {
        sourceCloseCalls += 1;
      },
    });
    const cleanupFailures: unknown[] = [];
    const registrations = registrationsFor(filesystem, cleanupFailures);

    await expect(
      registrations.openActiveByteSource({
        registrationId: "registered-root",
        relativePath: "track.flac",
      }),
    ).rejects.toBe(scopeCloseFailure);

    expect(sourceCloseCalls).toBe(1);
    expect(cleanupFailures).toEqual([
      expect.objectContaining({
        operation: "open-active-byte-source",
        cleanup: "close-bound-scope",
        rootId: "registered-root",
        relativeScope: ".",
        error: scopeCloseFailure,
      }),
    ]);
  });

  it("retains the scope-close failure and audits a second byte-source close failure", async () => {
    const scopeCloseFailure = new Error("scope close failed");
    const sourceCloseFailure = new Error("byte source close failed");
    let sourceCloseCalls = 0;
    const filesystem = new InMemoryObservedFilesystemCapability({
      onClose: () => {
        throw scopeCloseFailure;
      },
      onByteSourceClose: () => {
        sourceCloseCalls += 1;
        throw sourceCloseFailure;
      },
    });
    const cleanupFailures: unknown[] = [];
    const registrations = registrationsFor(filesystem, cleanupFailures);

    await expect(
      registrations.openActiveByteSource({
        registrationId: "registered-root",
        relativePath: "track.flac",
      }),
    ).rejects.toBe(scopeCloseFailure);

    expect(sourceCloseCalls).toBe(1);
    expect(cleanupFailures).toEqual([
      expect.objectContaining({
        operation: "open-active-byte-source",
        cleanup: "close-bound-scope",
        error: scopeCloseFailure,
      }),
      expect.objectContaining({
        operation: "open-active-byte-source",
        cleanup: "close-byte-source",
        error: sourceCloseFailure,
        primaryError: scopeCloseFailure,
      }),
    ]);
  });

  it("closes an opened byte source before a failed cleanup reporter can return", async () => {
    const scopeCloseFailure = new Error("scope close failed");
    const reporterFailure = new Error("cleanup audit failed");
    let sourceCloseCalls = 0;
    let reportCalls = 0;
    const events: string[] = [];
    const filesystem = new InMemoryObservedFilesystemCapability({
      onClose: () => {
        events.push("scope-close");
        throw scopeCloseFailure;
      },
      onByteSourceClose: () => {
        sourceCloseCalls += 1;
        events.push("byte-source-close");
      },
    });
    const registrations = registrationsFor(filesystem, {
      async reportCleanupFailure() {
        reportCalls += 1;
        events.push("report");
        throw reporterFailure;
      },
    });

    await expect(
      registrations.openActiveByteSource({
        registrationId: "registered-root",
        relativePath: "track.flac",
      }),
    ).rejects.toBe(scopeCloseFailure);

    expect(sourceCloseCalls).toBe(1);
    expect(reportCalls).toBe(1);
    expect(events).toEqual(["scope-close", "byte-source-close", "report"]);
  });

  it("records a failed cleanup reporter through its separate fallback without changing the scope-close primary", async () => {
    const scopeCloseFailure = new Error("scope close failed");
    const reporterFailure = new Error("cleanup audit failed");
    const reportingFailures: unknown[] = [];
    const filesystem = new InMemoryObservedFilesystemCapability({
      onClose: () => {
        throw scopeCloseFailure;
      },
    });
    const registrations = registrationsFor(filesystem, {
      reportingFailures,
      async reportCleanupFailure() {
        throw reporterFailure;
      },
    });

    await expect(
      registrations.openActiveByteSource({
        registrationId: "registered-root",
        relativePath: "track.flac",
      }),
    ).rejects.toBe(scopeCloseFailure);

    expect(reportingFailures).toEqual([
      expect.objectContaining({
        cleanupFailure: expect.objectContaining({
          cleanup: "close-bound-scope",
          error: scopeCloseFailure,
        }),
        reporterError: reporterFailure,
      }),
    ]);
  });

  it("keeps scope-close primary when scope, byte-source cleanup, and reporting all fail", async () => {
    const scopeCloseFailure = new Error("scope close failed");
    const sourceCloseFailure = new Error("byte source close failed");
    const reporterFailure = new Error("cleanup audit failed");
    let sourceCloseCalls = 0;
    let reportCalls = 0;
    let fallbackCalls = 0;
    const filesystem = new InMemoryObservedFilesystemCapability({
      onClose: () => {
        throw scopeCloseFailure;
      },
      onByteSourceClose: () => {
        sourceCloseCalls += 1;
        throw sourceCloseFailure;
      },
    });
    const registrations = registrationsFor(filesystem, {
      async reportCleanupFailure() {
        reportCalls += 1;
        throw reporterFailure;
      },
      async reportCleanupReportingFailure() {
        fallbackCalls += 1;
        throw new Error("cleanup fallback failed");
      },
    });

    await expect(
      registrations.openActiveByteSource({
        registrationId: "registered-root",
        relativePath: "track.flac",
      }),
    ).rejects.toBe(scopeCloseFailure);

    expect(sourceCloseCalls).toBe(1);
    expect(reportCalls).toBe(2);
    expect(fallbackCalls).toBe(2);
  });

  it("returns a successfully opened byte source to its caller still owned by that caller", async () => {
    let sourceCloseCalls = 0;
    const filesystem = new InMemoryObservedFilesystemCapability({
      onByteSourceClose: () => {
        sourceCloseCalls += 1;
      },
    });
    const registrations = registrationsFor(filesystem);

    const source = await registrations.openActiveByteSource({
      registrationId: "registered-root",
      relativePath: "track.flac",
    });

    expect(sourceCloseCalls).toBe(0);
    await source.close();
    expect(sourceCloseCalls).toBe(1);
  });
});
