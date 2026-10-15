import {
  InMemoryObservedFilesystemCapability,
  InMemoryObservedRootRegistrationStore,
} from "@digital/test-support";
import { assert, describe, expect, it } from "vitest";

import {
  ObservedRootConfigurationConflict,
  ObservedRootRegistrations,
  type ObservedRootRegistration,
  type ExecutionHost,
} from "../src/index.ts";

const localLibraryId = "library-local";

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

/**
 * 授权基底是一个真实有界资产库：只有它引用的登记根才取得 I/O 权威，未声明的目录一律
 * 不被授权。库的移除与重连沿生产因果推进授权版本，捷径绝不扩成默认全授权。
 */
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
        readonly operationSupervisor?: Pick<
          ExecutionHost,
          "invalidateObservedRoot" | "invalidateLibraryDirectory"
        >;
        readonly store?: InMemoryObservedRootRegistrationStore<ObservedRootRegistration>;
      } = {},
): {
  readonly registrations: ObservedRootRegistrations;
  readonly store: InMemoryObservedRootRegistrationStore<ObservedRootRegistration>;
} {
  const options = Array.isArray(input) ? { cleanupFailures: input } : input;
  const store =
    options.store ??
    new InMemoryObservedRootRegistrationStore<ObservedRootRegistration>(
      [registeredRoot()],
      {
        libraries: [
          {
            id: localLibraryId,
            status: "active",
            rootIds: ["registered-root"],
          },
        ],
      },
    );
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
  return {
    store,
    registrations: new ObservedRootRegistrations({
      commands: store.commands,
      queries: store.queries,
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
    }),
  };
}

describe("Observed Root Registrations", () => {
  it("在成功撤销返回前失效该登记的活动短操作", async () => {
    const invalidated: unknown[] = [];
    const { registrations, store } = registrationsFor(
      new InMemoryObservedFilesystemCapability(),
      {
        operationSupervisor: {
          invalidateLibraryDirectory() {
            throw new Error("撤销登记不应失效库目录");
          },
          invalidateObservedRoot(input) {
            invalidated.push(input);
          },
        },
      },
    );
    // 生产不允许撤销仍被活动资产库引用的物理根，因此先按公开账本把目录从库里脱钩。
    store.authorization.removeDirectory({
      libraryId: localLibraryId,
      observedRootId: "registered-root",
    });

    await registrations.deactivate({
      id: "registered-root",
      expectedVersion: 1,
    });

    expect(invalidated).toEqual([{ registrationId: "registered-root" }]);
  });
  it("observes the exact current registered scope through its bound capability", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const { registrations } = registrationsFor(filesystem);
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
    const { registrations } = registrationsFor(filesystem);
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
    const { registrations } = registrationsFor(filesystem);
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
    const { registrations } = registrationsFor(filesystem);
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
    const { registrations } = registrationsFor(filesystem);

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
    const { registrations } = registrationsFor(filesystem);
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
    const { registrations } = registrationsFor(filesystem, cleanupFailures);

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
    const { registrations } = registrationsFor(filesystem, cleanupFailures);

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
    const { registrations } = registrationsFor(filesystem, {
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
    const { registrations } = registrationsFor(filesystem, {
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
    const { registrations } = registrationsFor(filesystem, {
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
    const { registrations } = registrationsFor(filesystem);

    const { source } = await registrations.openActiveByteSource({
      registrationId: "registered-root",
      relativePath: "track.flac",
    });

    expect(sourceCloseCalls).toBe(0);
    await source.close();
    expect(sourceCloseCalls).toBe(1);
  });

  it("binds a scope through the library that grants the directory and freezes its authority generation", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const { registrations } = registrationsFor(filesystem);

    const resolved = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: "season-1",
      assetLibraryId: localLibraryId,
    });

    expect(resolved.directoryAuthorityVersion).toBe(1);
    try {
      await expect(
        registrations.observeBoundScope(resolved.scope),
      ).resolves.toMatchObject({ root: "/observed/registered-root/season-1" });
    } finally {
      await registrations.closeBoundScope(resolved.scope);
    }
  });

  it("refuses a directory that the named library never granted, with or without library context", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const { registrations } = registrationsFor(filesystem, {
      store:
        new InMemoryObservedRootRegistrationStore<ObservedRootRegistration>(
          [registeredRoot(), registeredRoot("unselected-root")],
          {
            libraries: [
              {
                id: localLibraryId,
                status: "active",
                rootIds: ["registered-root"],
              },
            ],
          },
        ),
    });

    await expect(
      registrations.resolveActiveScope({
        registrationId: "unselected-root",
        relativeScope: ".",
        assetLibraryId: localLibraryId,
      }),
    ).rejects.toThrow("此目录已不属于该资产库");
    // 省略库语境也不构成放行：全局已授权清单同样只认活动库引用的目录。
    await expect(
      registrations.resolveActiveScope({
        registrationId: "unselected-root",
        relativeScope: ".",
      }),
    ).rejects.toThrow("文件位置当前缺失、不可读或范围越界");
  });

  it("refuses to revoke a physical root that an active asset library still references", async () => {
    const { registrations, store } = registrationsFor(
      new InMemoryObservedFilesystemCapability(),
    );

    await expect(
      registrations.deactivate({ id: "registered-root", expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ObservedRootConfigurationConflict);
    expect(
      (await store.queries.getObservedRootRegistration("registered-root"))
        ?.status,
    ).toBe("active");

    // 合法前置的另一半：目录先脱离本库账本，撤销登记才取得因果上的许可。
    store.authorization.removeDirectory({
      libraryId: localLibraryId,
      observedRootId: "registered-root",
    });
    await expect(
      registrations.deactivate({ id: "registered-root", expectedVersion: 1 }),
    ).resolves.toMatchObject({ status: "revoked", configVersion: 2 });
  });

  it("advances the library directory generation when a saved link range changes, and rejects the older frozen authority", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const { registrations, store } = registrationsFor(filesystem);
    const before = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: ".",
      assetLibraryId: localLibraryId,
    });
    expect(before.directoryAuthorityVersion).toBe(1);
    const configVersion =
      store.libraryLedger.read(localLibraryId)?.configVersion;
    assert.isDefined(configVersion);
    const receipt = store.authorization.saveLibrary({
      libraryId: localLibraryId,
      expectedConfigVersion: configVersion,
      directories: [
        {
          observedRootId: "registered-root",
          symlinkMode: "follow-file-links",
        },
      ],
    });

    expect(receipt).toEqual({
      configVersion: (configVersion ?? 0) + 1,
      invalidations: [
        {
          assetLibraryId: localLibraryId,
          observedRootId: "registered-root",
          keepVersion: 2,
        },
      ],
    });
    const after = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: ".",
      assetLibraryId: localLibraryId,
    });
    expect(after.directoryAuthorityVersion).toBe(2);
    // 两道诚实拒绝各自成立：旧冻结权威在权威闭包核对处就被拒（版本已变更），而一份当前
    // 根快照若仍声称旧目录授权代次，则在账本核对处被判为撤销/重连，绝不以「今日仍活动」续权。
    await expect(
      registrations.assertFrozenRootsCurrent([before.root], {
        assetLibraryId: localLibraryId,
        directoryAuthorizations: [
          { observedRootId: "registered-root", authorityVersion: 1 },
        ],
      }),
    ).rejects.toThrow("刷新记录的冻结文件位置当前不可用或版本已变更");
    await expect(
      registrations.assertFrozenRootsCurrent([after.root], {
        assetLibraryId: localLibraryId,
        directoryAuthorizations: [
          { observedRootId: "registered-root", authorityVersion: 1 },
        ],
      }),
    ).rejects.toThrow("此目录已从资产库移除或重新连接，本次工作不能继续");
    await registrations.assertFrozenRootsCurrent([after.root], {
      assetLibraryId: localLibraryId,
      directoryAuthorizations: [
        { observedRootId: "registered-root", authorityVersion: 2 },
      ],
    });
    await registrations.closeBoundScope(before.scope);
    await registrations.closeBoundScope(after.scope);
  });

  it("目标目录策略变化后，同库依赖范围的旧观察失效而另一库仍可观察", async () => {
    const roots = ["source-root", "target-root"];
    const store = new InMemoryObservedRootRegistrationStore(
      roots.map((id) => registeredRoot(id)),
      {
        libraries: [
          {
            id: localLibraryId,
            status: "active",
            rootIds: roots,
            directoryLinks: [
              {
                observedRootId: "source-root",
                symlinkMode: "follow-file-links",
                targetObservedRootIds: ["target-root"],
              },
            ],
          },
          { id: "other-library", status: "active", rootIds: roots },
        ],
      },
    );
    const { registrations } = registrationsFor(
      new InMemoryObservedFilesystemCapability(),
      { store },
    );
    const before = await registrations.resolveActiveScope({
      registrationId: "source-root",
      relativeScope: ".",
      assetLibraryId: localLibraryId,
    });
    const other = await registrations.resolveActiveScope({
      registrationId: "source-root",
      relativeScope: ".",
      assetLibraryId: "other-library",
    });
    const scopes = [before.scope, other.scope];
    try {
      await registrations.observeBoundScope(before.scope);
      store.authorization.saveLibrary({
        libraryId: localLibraryId,
        expectedConfigVersion: 1,
        directories: [
          {
            observedRootId: "source-root",
            symlinkMode: "follow-file-links",
            targetObservedRootIds: ["target-root"],
          },
          {
            observedRootId: "target-root",
            symlinkMode: "follow-file-links",
          },
        ],
      });
      await expect(
        registrations.observeBoundScope(before.scope),
      ).rejects.toThrow("此目录已从资产库移除或重新连接，本次工作不能继续");
      await expect(
        registrations.assertFrozenRootsCurrent([before.root], {
          assetLibraryId: localLibraryId,
          directoryAuthorizations: [
            { observedRootId: "source-root", authorityVersion: 1 },
          ],
        }),
      ).rejects.toThrow("此目录已从资产库移除或重新连接，本次工作不能继续");
      const after = await registrations.resolveActiveScope({
        registrationId: "source-root",
        relativeScope: ".",
        assetLibraryId: localLibraryId,
      });
      scopes.push(after.scope);
      expect(after.directoryAuthorityVersion).toBe(2);
      await registrations.observeBoundScope(after.scope);
      await expect(
        registrations.observeBoundScope(other.scope),
      ).resolves.toMatchObject({ root: "/observed/source-root" });
    } finally {
      for (const scope of scopes) await registrations.closeBoundScope(scope);
    }
  });

  it("leaves the authorization ledger untouched when a saved library config loses its version race", async () => {
    const roots = ["registered-root", "retained-root"];
    const { registrations, store } = registrationsFor(
      new InMemoryObservedFilesystemCapability(),
      {
        store: new InMemoryObservedRootRegistrationStore(
          roots.map((id) => registeredRoot(id)),
          {
            libraries: [
              { id: localLibraryId, status: "active", rootIds: roots },
            ],
          },
        ),
      },
    );
    const current = store.libraryLedger.read(localLibraryId);
    assert.isDefined(current);

    expect(
      store.authorization.saveLibrary({
        libraryId: localLibraryId,
        expectedConfigVersion: (current.configVersion ?? 0) + 5,
        directories: [
          {
            observedRootId: "registered-root",
            symlinkMode: "follow-file-links",
          },
        ],
      }),
    ).toBeUndefined();
    expect(store.libraryLedger.read(localLibraryId)).toEqual(current);
    const resolved = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: ".",
      assetLibraryId: localLibraryId,
    });
    expect(resolved.directoryAuthorityVersion).toBe(1);
    await registrations.closeBoundScope(resolved.scope);

    store.authorization.removeDirectory({
      libraryId: localLibraryId,
      observedRootId: "registered-root",
    });
    const removed = store.libraryLedger.read(localLibraryId);
    assert.isDefined(removed);
    expect(
      store.authorization.saveLibrary({
        libraryId: localLibraryId,
        expectedConfigVersion: current.configVersion,
        directories: [
          { observedRootId: "retained-root", symlinkMode: "follow-file-links" },
        ],
      }),
    ).toBeUndefined();
    expect(store.libraryLedger.read(localLibraryId)).toEqual(removed);
    const retained = await registrations.resolveActiveScope({
      registrationId: "retained-root",
      relativeScope: ".",
      assetLibraryId: localLibraryId,
    });
    try {
      expect(retained.root.symlinkMode).toBe("do-not-follow");
      await registrations.observeBoundScope(retained.scope);
    } finally {
      await registrations.closeBoundScope(retained.scope);
    }
  });

  it("detaches a directory that a saved library config no longer selects", async () => {
    const { registrations, store } = registrationsFor(
      new InMemoryObservedFilesystemCapability(),
    );
    const current = store.libraryLedger.read(localLibraryId);
    assert.isDefined(current);

    expect(
      store.authorization.saveLibrary({
        libraryId: localLibraryId,
        expectedConfigVersion: current.configVersion,
        directories: [],
      }),
    ).toEqual({
      configVersion: (current.configVersion ?? 0) + 1,
      invalidations: [
        { assetLibraryId: localLibraryId, observedRootId: "registered-root" },
      ],
    });
    await expect(
      registrations.resolveActiveScope({
        registrationId: "registered-root",
        relativeScope: ".",
        assetLibraryId: localLibraryId,
      }),
    ).rejects.toThrow("此目录已不属于该资产库");
  });

  it("rejects a frozen library scope whose authority generation a reconnect replaced, and issues the new generation to fresh work", async () => {
    const filesystem = new InMemoryObservedFilesystemCapability();
    const { registrations, store } = registrationsFor(filesystem);
    const resolved = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: "season-1",
      assetLibraryId: localLibraryId,
    });
    const frozen = {
      assetLibraryId: localLibraryId,
      directoryAuthorizations: [
        { observedRootId: "registered-root", authorityVersion: 1 },
      ],
    };

    // 合法前置：同一份冻结权威在当前代次下诚实通过。
    await registrations.assertFrozenRootsCurrent([resolved.root], frozen);

    store.authorization.removeDirectory({
      libraryId: localLibraryId,
      observedRootId: "registered-root",
    });
    // 普通保存不能代替点名重连，也不能让原绑定范围沿旧授权重新取得访问。
    const removed = store.libraryLedger.read(localLibraryId);
    assert.isDefined(removed);
    expect(() =>
      store.authorization.saveLibrary({
        libraryId: localLibraryId,
        expectedConfigVersion: removed.configVersion,
        directories: [
          {
            observedRootId: "registered-root",
            symlinkMode: "do-not-follow",
          },
        ],
      }),
    ).toThrow("该目录此前已从本资产库移除，请使用重新连接而不是重复添加");
    expect(store.libraryLedger.read(localLibraryId)).toEqual(removed);
    await expect(
      registrations.observeBoundScope(resolved.scope),
    ).rejects.toThrow("冻结文件位置当前不可用");
    // 点名重连走与生产相同的 CAS：只有 removed 行与预期代次匹配才推进新权威。
    expect(
      store.authorization.reconnectDirectory({
        libraryId: localLibraryId,
        observedRootId: "registered-root",
        expectedAuthorityVersion: 1,
      }),
    ).toBe(false);
    expect(
      store.authorization.reconnectDirectory({
        libraryId: localLibraryId,
        observedRootId: "registered-root",
        expectedAuthorityVersion: 2,
      }),
    ).toBe(true);

    await expect(
      registrations.assertFrozenRootsCurrent([resolved.root], frozen),
    ).rejects.toThrow("此目录已从资产库移除或重新连接，本次工作不能继续");
    const rebound = await registrations.resolveActiveScope({
      registrationId: "registered-root",
      relativeScope: "season-1",
      assetLibraryId: localLibraryId,
    });
    expect(rebound.directoryAuthorityVersion).toBe(3);
    await registrations.closeBoundScope(rebound.scope);
  });
});
