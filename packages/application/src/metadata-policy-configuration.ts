import type { AcceptedRecognition, MetadataPolicy } from "@digital/domain";

export type MetadataPolicyDefinition = Omit<MetadataPolicy, "subjectIds">;

/**
 * Composition supplies definitions and the product mapping from an accepted
 * interpretation to explicit policy enrollment. Application coordinates and
 * persists only those opaque identifiers.
 */
export type MetadataPolicyConfiguration = {
  readonly version: string;
  readonly policies: readonly MetadataPolicyDefinition[];
  enroll(accepted: AcceptedRecognition): readonly string[];
};
