import { describe, expect, it } from "vitest";

import {
  createObservedRootAuthorityIndex,
  decodeObservedRootSnapshot,
  freezeObservedRootSnapshot,
  hasCurrentObservedRootAuthority,
  isAutomationObservedRootAuthorizationCurrent,
  normalizeObservedRelativeScope,
  observedRootIdsDependingOn,
  resolveObservedRootAuthority,
  type ObservedRootRegistration,
} from "../src/index.ts";

function registration(
  id: string,
  allowedTargetRootIds: readonly string[] = [],
): ObservedRootRegistration {
  return {
    id,
    displayName: id,
    containerPath: `/observed/${id}`,
    canonicalPath: `/observed/${id}`,
    status: "active",
    configVersion: 1,
    readOnly: true,
    symlinkMode: "do-not-follow",
    allowedTargetRootIds,
  };
}

describe("Observed Root authority", () => {
  it("owns strict snapshot decoding and canonical relative-scope normalization", () => {
    const decoded = decodeObservedRootSnapshot({
      version: "observed-root-snapshot/1",
      id: "root-a",
      configVersion: 1,
      containerPath: "/observed/root-a",
      canonicalPath: "/observed/root-a",
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });

    expect(decoded).toMatchObject({ valid: true });
    expect(
      decodeObservedRootSnapshot({
        version: "observed-root-snapshot/1",
        id: "root-a",
        configVersion: 1,
        containerPath: "/observed/root-a",
        canonicalPath: "/observed/root-a",
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
        unexpected: true,
      }),
    ).toMatchObject({ valid: false });
    expect(normalizeObservedRelativeScope("season/../season-1")).toBe(
      "season-1",
    );
    expect(() => normalizeObservedRelativeScope("../outside")).toThrow(
      "文件位置范围不能越过登记根目录",
    );
  });

  it("freezes, compares, and reverses one transitive registered authority graph", () => {
    const rootA = registration("root-a", ["root-b"]);
    const rootB = registration("root-b", ["root-c"]);
    const rootC = registration("root-c");
    const index = createObservedRootAuthorityIndex([rootC, rootA, rootB]);
    const authority = resolveObservedRootAuthority(index, rootA.id);

    expect(authority).toMatchObject({
      status: "available",
      root: rootA,
      authorizedTargetRoots: [
        { id: "root-b", configVersion: 1 },
        { id: "root-c", configVersion: 1 },
      ],
    });
    if (authority.status !== "available") throw new Error("missing authority");
    const frozen = freezeObservedRootSnapshot(authority);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.authorizedTargetRoots)).toBe(true);
    expect(hasCurrentObservedRootAuthority(frozen, index)).toBe(true);
    expect(observedRootIdsDependingOn(index, rootC.id)).toEqual(
      new Set(["root-a", "root-b", "root-c"]),
    );

    const changed = createObservedRootAuthorityIndex([
      rootA,
      rootB,
      { ...rootC, configVersion: 2 },
    ]);
    expect(hasCurrentObservedRootAuthority(frozen, changed)).toBe(false);
  });

  it("uses the same closure to authorize an atomic Automation Intent write", () => {
    const rootA = registration("root-a", ["root-b"]);
    const rootB = registration("root-b");
    const index = createObservedRootAuthorityIndex([rootA, rootB]);
    // 周期计划属于库内目录：自动化范围必须自带库归属（observed-root-authority.ts:260
    // 的 `isObservedRootAutomationScope` 严校三字段），不再指向可自由选择的全局根。
    const assetLibraryId = "library-a";

    expect(
      isAutomationObservedRootAuthorizationCurrent({
        scope: {
          assetLibraryId,
          observedRootId: rootA.id,
          relativeScope: "season-1",
        },
        authorization: {
          observedRootId: rootA.id,
          configVersion: 1,
          authorizedTargetRoots: [{ id: rootB.id, configVersion: 1 }],
        },
        index,
      }),
    ).toBe(true);
    expect(
      isAutomationObservedRootAuthorizationCurrent({
        scope: {
          assetLibraryId,
          observedRootId: rootA.id,
          relativeScope: "../outside",
        },
        authorization: {
          observedRootId: rootA.id,
          configVersion: 1,
          authorizedTargetRoots: [{ id: rootB.id, configVersion: 1 }],
        },
        index,
      }),
    ).toBe(false);
  });
});
