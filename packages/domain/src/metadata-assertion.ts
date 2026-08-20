import type { CapabilityCoordinate } from "./index.js";

export type MetadataAssertion = {
  /**
   * A source-resolved Entity in the same proposal that this assertion
   * describes. Omission deliberately means the accepted Digital Asset.
   */
  readonly subjectId?: string;
  readonly property: string;
  /** Stable source-contract slot; property equality alone never implies lineage. */
  readonly sourceSlot: string;
  readonly value: string;
  readonly sourceRecordIds: readonly string[];
  /** The interpreter coordinate that established this assertion. */
  readonly producer?: CapabilityCoordinate;
  /** Open, source-contract-defined semantics such as rating unit and scale. */
  readonly qualifiers?: readonly {
    readonly key: string;
    readonly value: string;
  }[];
  /**
   * Container-derived facts retain the exact observed revision and entry that
   * supplied them. They are deliberately not attributed to an external
   * Source Record merely because that record established recognition.
   */
  readonly observedArtifactPart?: {
    readonly artifactId: string;
    readonly revisionId: string;
    readonly locator: string;
  };
};
