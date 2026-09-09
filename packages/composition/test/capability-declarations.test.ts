import { applicationOwnedCapabilityDeclarations } from "@digital/application";
import {
  DlsiteCollector,
  DlsiteSourceAddressing,
  DlsiteSourceInterpreter,
} from "@digital/dlsite";
import {
  FanboxDateDirectoryInterpreter,
  FanboxSourceInterpreter,
  fanboxOfficialCollectionCapability,
} from "@digital/fanbox";
import { ReadOnlyFilesystemObserver } from "@digital/filesystem";
import { createKadokawaJapanSource } from "@digital/kadokawa-jp";
import {
  curatedInitialRecognitionPolicy,
  validateCapabilityDeclarations,
} from "@digital/product-application";
import { createTaiwanKadokawaSource } from "@digital/taiwan-kadokawa";
import { describe, expect, test } from "vitest";

describe("capability declarations", () => {
  test("fails composition before startup when a deployed declaration omits its stable identity", () => {
    expect(() =>
      validateCapabilityDeclarations([
        {
          implementationVersion: "1",
          kind: "source-collector",
          interpretationContractVersions: ["source-record/v1"],
        },
      ]),
    ).toThrow("stable identity");
  });

  test("fails composition when an implementation claims an undeclared interpretation contract", () => {
    expect(() =>
      validateCapabilityDeclarations([
        {
          identity: "source.collector",
          implementationVersion: "2",
          kind: "source-collector",
          interpretationContractVersions: ["source-record/v1"],
          capabilityId: "source.collector",
          capabilityVersion: "2",
          contractVersion: "source-record/v2",
        },
      ]),
    ).toThrow("incompatible interpretation contract");
  });

  test("fails composition when deployed capabilities reuse a stable identity", () => {
    const declaration = {
      identity: "source.collector",
      implementationVersion: "1",
      kind: "source-collector",
      interpretationContractVersions: ["source-record/v1"],
      capabilityId: "source.collector",
      capabilityVersion: "1",
      contractVersion: "source-record/v1",
    };

    expect(() =>
      validateCapabilityDeclarations([declaration, declaration]),
    ).toThrow("duplicate stable identity");
  });

  test("fails composition when a declaration omits its selected interpretation contract", () => {
    expect(() =>
      validateCapabilityDeclarations([
        {
          identity: "source.collector",
          implementationVersion: "1",
          kind: "source-collector",
          interpretationContractVersions: ["source-record/v1"],
          capabilityId: "source.collector",
          capabilityVersion: "1",
        },
      ]),
    ).toThrow("selected interpretation contract");
  });

  test("does not let a capability declaration grant its own Recognition Policy trust", () => {
    const selfDeclared = {
      identity: "untrusted.self-declaration",
      implementationVersion: "1",
      kind: "recognizer",
      interpretationContractVersions: ["recognition/v1"],
      capabilityId: "untrusted.self-declaration",
      capabilityVersion: "1",
      contractVersion: "recognition/v1",
      trustedRuleCoordinates: ["untrusted.self-declaration@1/self@1"],
    };
    validateCapabilityDeclarations([selfDeclared]);

    expect(
      curatedInitialRecognitionPolicy().accepts({
        capabilityId: "untrusted.self-declaration",
        capabilityVersion: "1",
        ruleId: "self",
        ruleVersion: "1",
        outcome: "satisfied",
        explanation: "the capability claims to be trusted",
        evidence: [],
      }),
    ).toBe(false);
  });

  test("accepts contrasting DLsite and FANBOX declarations without introducing a provider contract", () => {
    const declarations = [
      new DlsiteSourceAddressing().capability,
      new DlsiteCollector().capability,
      new DlsiteSourceInterpreter().capability,
      new FanboxDateDirectoryInterpreter("creator").capability,
      fanboxOfficialCollectionCapability,
      new FanboxSourceInterpreter().capability,
    ];

    expect(validateCapabilityDeclarations(declarations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: "dlsite.explicit-product-addressing",
          kind: "source-addressing",
        }),
        expect.objectContaining({
          identity: "dlsite.official-collection",
          kind: "source-collector",
        }),
        expect.objectContaining({
          identity: "fanbox.creator-date-directory",
          kind: "directory-interpreter",
        }),
      ]),
    );
  });

  test("statically declares the fixed Taiwan Kadokawa source bundle", () => {
    const source = createTaiwanKadokawaSource();

    expect(
      validateCapabilityDeclarations([
        source.sourceAddressing.capability,
        source.collector.capability,
        source.interpreter.capability,
        source.associationInterpreter.capability,
        source.artifactAcquirer.capability,
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: "taiwan-kadokawa.explicit-isbn-addressing",
          kind: "source-addressing",
        }),
        expect.objectContaining({
          identity: "taiwan-kadokawa.official-product-collection",
          kind: "source-collector",
        }),
      ]),
    );
  });

  test("statically declares the fixed KADOKAWA Japan source bundle", () => {
    const source = createKadokawaJapanSource();
    expect(
      validateCapabilityDeclarations([
        source.sourceAddressing.capability,
        source.collector.capability,
        source.interpreter.capability,
        source.associationInterpreter.capability,
        source.artifactAcquirer.capability,
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: "kadokawa-jp.explicit-isbn-addressing",
        }),
        expect.objectContaining({
          identity: "kadokawa-jp.official-collection",
        }),
      ]),
    );
  });

  test("validates the deployed filesystem observer and application-owned evidence declarations", () => {
    const observer = new ReadOnlyFilesystemObserver();

    expect(
      validateCapabilityDeclarations([
        ...applicationOwnedCapabilityDeclarations,
        observer.capability,
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: "filesystem.read-only-observer",
          kind: "filesystem-observer",
        }),
        expect.objectContaining({
          identity: "application.directed-recognition",
        }),
        expect.objectContaining({
          identity: "application.known-source-association",
        }),
      ]),
    );
  });
});
