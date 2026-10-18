import type {
  SourceConnectionPrivateStatePort,
  SourceCollector,
} from "@digital/application";
import type { CapabilityCoordinate } from "@digital/domain";
import { expect, it } from "vitest";

import {
  ProductFanboxSourceConnections,
  SourceConnectionVersionConflict,
  type ProductSourceConnectionAdapters,
} from "../src/source-connections.ts";

it.each(["configure", "replace"] as const)(
  "验证等待期间撤销后不提交旧的 FANBOX %s 结果",
  async (operation) => {
    const records = new Map<string, unknown>();
    const privateState = createPrivateState(records);
    let validateCredential = async () => "verified-private-configuration";
    const connections = new ProductFanboxSourceConnections({
      privateState,
      adapter: {
        ...fanboxAdapter,
        validatedBrowserCredential: async () => await validateCredential(),
      },
    });

    if (operation === "replace") {
      await connections.importBrowserCredentials({
        creatorId: "customudon",
        browserCredential: { session: "synthetic-existing-session" },
      });
    }

    let releaseValidation!: () => void;
    let markValidationStarted!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    validateCredential = async () => {
      markValidationStarted();
      await validationGate;
      return "synthetic-stale-private-configuration";
    };

    const expectedVersion = operation === "configure" ? 0 : 1;
    const pending =
      operation === "configure"
        ? connections.importBrowserCredentials({
            creatorId: "customudon",
            browserCredential: { session: "synthetic-stale-session" },
          })
        : connections.replaceBrowserCredentials({
            creatorId: "customudon",
            expectedVersion,
            browserCredential: { session: "synthetic-stale-session" },
          });
    await validationStarted;

    const revoked = connections.revoke({
      creatorId: "customudon",
      expectedVersion,
    });
    expect(revoked).toMatchObject({
      version: expectedVersion + 1,
      credentialStatus: "revoked",
    });

    releaseValidation();
    await expect(pending).rejects.toBeInstanceOf(
      SourceConnectionVersionConflict,
    );
    expect(connections.inspect("customudon")).toMatchObject({
      version: expectedVersion + 1,
      credentialStatus: "revoked",
    });
    expect(JSON.stringify(records.get("fanbox--customudon"))).not.toContain(
      "synthetic-stale-private-configuration",
    );
  },
);

const connectionCapability: CapabilityCoordinate = {
  capabilityId: "fanbox.source-connection",
  capabilityVersion: "1",
  contractVersion: "1",
  identity: "fanbox",
  implementationVersion: "controlled-test",
  kind: "source-connection",
};
const collectorCapability: CapabilityCoordinate = {
  capabilityId: "fanbox.collector",
  capabilityVersion: "1",
  contractVersion: "1",
  identity: "fanbox",
  implementationVersion: "controlled-test",
  kind: "source-collector",
};
const fanboxAdapter: ProductSourceConnectionAdapters["fanbox"] = {
  connectionCapability,
  collectorCapability,
  creatorIdFromEvidence: () => undefined,
  validatedBrowserCredential: async () => "verified-private-configuration",
  verifyStoredCredential: async () => {},
  createCollector(): SourceCollector {
    return {
      capability: collectorCapability,
      canCollect: () => false,
      collect: async () => ({ records: [], failures: [] }),
    };
  },
};

function createPrivateState(
  records: Map<string, unknown>,
): SourceConnectionPrivateStatePort {
  return {
    read(key) {
      const value = records.get(key);
      return value === undefined
        ? { status: "missing" }
        : { status: "usable", value };
    },
    write({ key, value }) {
      records.set(key, value);
    },
    list() {
      return { status: "usable", keys: [...records.keys()] };
    },
    lease() {
      throw new Error("此连接用例不使用来源租约");
    },
  };
}
