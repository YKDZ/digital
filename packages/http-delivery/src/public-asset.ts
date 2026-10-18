import type { EffectiveSubjectRead } from "@digital/application";
import type { ProductApplication } from "@digital/product-application";

/** 将应用资料投影收窄为公共资产合同，不泄露内部关系支持坐标。 */
export function publicAsset(
  application: ProductApplication,
  asset: EffectiveSubjectRead,
  assetLibraryId?: string,
) {
  const libraryQuery =
    assetLibraryId === undefined
      ? ""
      : `?assetLibraryId=${encodeURIComponent(assetLibraryId)}`;
  return {
    id: asset.id,
    sourceAssociations: asset.sourceAssociations,
    ...(asset.recognitionSourceAssociation === undefined
      ? {}
      : { recognitionSourceAssociation: asset.recognitionSourceAssociation }),
    descriptions: asset.descriptions.map((description) => ({
      ...description,
      artifactRoles: description.artifactRoles.map((role) => {
        if (role.address === undefined || role.locationId === undefined)
          return role;
        const location = asset.locations.find(
          (candidate) => candidate.id === role.locationId,
        );
        if (location?.kind === "managed") {
          const managed = application.managedArtifactReference(
            location.address,
          );
          if (managed !== undefined)
            return {
              ...role,
              address: `/api/v1/media/managed-artifacts/${managed.digest}`,
            };
        }
        if (
          location?.kind === "observed" &&
          ["asset.primary-cover", "asset.material-image"].includes(role.role)
        )
          return {
            ...role,
            address: `/api/v1/media/observed-artwork/${encodeURIComponent(asset.id)}/${encodeURIComponent(location.id)}${libraryQuery}`,
          };
        const { address: _address, ...withoutAddress } = role;
        return withoutAddress;
      }),
    })),
    relatedEntities: asset.relatedEntities,
    relationships: asset.relationships.map((relationship) => ({
      id: relationship.id,
      type: relationship.type,
      participants: relationship.participants.map((participant) => ({
        entityId: participant.entityId,
        role: participant.role,
        ...(participant.mentionIds === undefined
          ? {}
          : { mentionIds: participant.mentionIds }),
      })),
      sourceRecordIds: relationship.sourceRecordIds,
      ...(relationship.qualifiers === undefined
        ? {}
        : { qualifiers: relationship.qualifiers }),
    })),
    locations: asset.locations,
    ...(asset.informationReadiness === undefined
      ? {}
      : { informationReadiness: asset.informationReadiness }),
    ...(asset.sourceArtifacts === undefined
      ? {}
      : { sourceArtifacts: asset.sourceArtifacts }),
  };
}
