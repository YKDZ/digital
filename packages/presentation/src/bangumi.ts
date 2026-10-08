import type { SelectedMetadataRead } from "@digital/application";

import {
  type ArtifactFileView,
  type AssetViewFacts,
  factProblems,
  observedArtifactFiles,
  subjectMetadata,
  targetArtwork,
} from "./index.ts";

export type BangumiEpisodeViewModel = {
  readonly assetId: string;
  readonly workId: string;
  readonly title: string;
  readonly summary?: string;
  readonly date?: string;
  readonly localPosition: number;
  readonly continuousPosition: number;
  readonly available: boolean;
  readonly artwork?: string;
  readonly officialPage: string;
  readonly actionTarget: { readonly subjectId: string };
  /** 该单集已交付的全部材料：同集多技术视频与各自字幕，顺序无关。 */
  readonly materials: readonly ArtifactFileView[];
  readonly factProblems?: ReturnType<typeof factProblems>;
  readonly informationReadiness?: AssetViewFacts["informationReadiness"];
};

export type BangumiWorkViewModel = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly date?: string;
  readonly cover?: string;
  readonly officialPage?: string;
  readonly episodes: readonly BangumiEpisodeViewModel[];
  readonly factProblems?: ReturnType<typeof factProblems>;
};

export type BangumiSeriesViewModel = {
  readonly id: string;
  readonly component: "bangumi";
  readonly title: string;
  readonly summary?: string;
  readonly date?: string;
  readonly cover?: string;
  /** 合成分组节点绝不拥有应用层动作。 */
  readonly actionTarget?: never;
  readonly factProblems?: ReturnType<typeof factProblems>;
  readonly works: readonly BangumiWorkViewModel[];
  readonly episodes: readonly BangumiEpisodeViewModel[];
};

type WorkState = {
  readonly id: string;
  label: string;
  sourceKey?: string;
  readonly metadata: SelectedMetadataRead[];
  readonly facts: AssetViewFacts[];
};

type SequelEdge = {
  readonly predecessorId: string;
  readonly sequelId: string;
};

function metadata(
  values: readonly SelectedMetadataRead[],
  property: string,
): string | undefined {
  const candidates = [
    ...new Set(
      values
        .filter((item) => item.property === property)
        .map((item) => item.value),
    ),
  ];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function numberQualifier(
  relationship: AssetViewFacts["relationships"][number],
  key: string,
): number | undefined {
  const declared = relationship.qualifiers?.filter(
    (qualifier) => qualifier.key === key,
  );
  if (declared?.length !== 1 || declared[0]!.value.trim() === "")
    return undefined;
  const value = Number(declared[0]!.value);
  return Number.isFinite(value) ? value : undefined;
}

function episodeFrom(
  fact: AssetViewFacts,
  workId: string,
  relationship: AssetViewFacts["relationships"][number],
): BangumiEpisodeViewModel | undefined {
  const localPosition = numberQualifier(
    relationship,
    "bangumi.episode.season-position",
  );
  const continuousPosition = numberQualifier(
    relationship,
    "bangumi.episode.continuous-position",
  );
  if (localPosition === undefined || continuousPosition === undefined)
    return undefined;
  const title =
    metadata(subjectMetadata(fact), "asset.title.zh-hans") ??
    metadata(subjectMetadata(fact), "asset.title") ??
    `第 ${localPosition} 集`;
  const summary =
    metadata(subjectMetadata(fact), "asset.description") ??
    metadata(subjectMetadata(fact), "asset.summary");
  const date = metadata(subjectMetadata(fact), "asset.release-date");
  const artwork = targetArtwork([fact], fact.id);
  return {
    assetId: fact.id,
    workId,
    title,
    ...(summary === undefined ? {} : { summary }),
    ...(date === undefined ? {} : { date }),
    localPosition,
    continuousPosition,
    available: fact.locations.some((item) => item.kind === "observed"),
    ...(artwork.address === undefined ? {} : { artwork: artwork.address }),
    officialPage: fact.sourceAssociations.find(
      (association) => association.sourceIdentity === "bangumi",
    )!.nativeAddress,
    actionTarget: { subjectId: fact.id },
    materials: observedArtifactFiles(fact),
    factProblems: factProblems(fact),
    ...(fact.informationReadiness === undefined
      ? {}
      : { informationReadiness: fact.informationReadiness }),
  };
}

/**
 * 将完整已接受目录投影为有限的 Bangumi 浏览根。读取关系图只为选择显式作品链；
 * 发出的子项是展示节点，绝不会成为领域包含关系。
 */
export function projectBangumiCatalogue(
  facts: readonly AssetViewFacts[],
): readonly BangumiSeriesViewModel[] {
  const accepted = facts.filter((fact) =>
    fact.sourceAssociations.some(
      (association) => association.sourceIdentity === "bangumi",
    ),
  );
  const works = new Map<string, WorkState>();
  for (const fact of accepted) {
    for (const entity of fact.relatedEntities) {
      if (
        entity.sourceIdentity !== "bangumi" ||
        entity.identityNamespace !== "bangumi.subject"
      )
        continue;
      const work: WorkState = works.get(entity.id) ?? {
        id: entity.id,
        label: entity.label,
        ...(entity.sourceKey === undefined
          ? {}
          : { sourceKey: entity.sourceKey }),
        metadata: [],
        facts: [],
      };
      work.label = entity.label;
      if (entity.sourceKey === undefined) delete work.sourceKey;
      else work.sourceKey = entity.sourceKey;
      work.facts.push(fact);
      work.metadata.push(...subjectMetadata(fact, entity.id));
      works.set(entity.id, work);
    }
  }
  const sequelEdges = new Map<string, SequelEdge>();
  for (const fact of accepted) {
    for (const relationship of fact.relationships ?? []) {
      if (
        relationship.type !== "bangumi.subject.related" ||
        !relationship.participants.some(
          (participant) => participant.role === "bangumi.subject.sequel",
        )
      )
        continue;
      const predecessorId = relationship.participants.find(
        (participant) => participant.role === "bangumi.subject.predecessor",
      )?.entityId;
      const sequelId = relationship.participants.find(
        (participant) => participant.role === "bangumi.subject.sequel",
      )?.entityId;
      if (
        predecessorId === undefined ||
        sequelId === undefined ||
        !works.has(predecessorId) ||
        !works.has(sequelId)
      )
        continue;
      const edge = {
        predecessorId,
        sequelId,
      };
      sequelEdges.set(`${edge.predecessorId}\u0000${edge.sequelId}`, edge);
    }
  }
  const edges = [...sequelEdges.values()].toSorted(
    (left, right) =>
      left.predecessorId.localeCompare(right.predecessorId) ||
      left.sequelId.localeCompare(right.sequelId),
  );
  const neighbours = new Map<string, Set<string>>();
  for (const id of works.keys()) neighbours.set(id, new Set());
  for (const edge of edges) {
    neighbours.get(edge.predecessorId)!.add(edge.sequelId);
    neighbours.get(edge.sequelId)!.add(edge.predecessorId);
  }
  const components: string[][] = [];
  const assigned = new Set<string>();
  for (const start of [...works.keys()].toSorted()) {
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const pending = [start];
    assigned.add(start);
    while (pending.length > 0) {
      const id = pending.shift()!;
      component.push(id);
      for (const neighbour of [...neighbours.get(id)!].toSorted()) {
        if (assigned.has(neighbour)) continue;
        assigned.add(neighbour);
        pending.push(neighbour);
      }
    }
    components.push(component.toSorted());
  }
  return components.flatMap((component) => {
    const members = new Set(component);
    const componentEdges = edges.filter(
      (edge) => members.has(edge.predecessorId) && members.has(edge.sequelId),
    );
    const incoming = new Map(component.map((id) => [id, 0]));
    const outgoing = new Map(component.map((id) => [id, new Set<string>()]));
    for (const edge of componentEdges) {
      if (outgoing.get(edge.predecessorId)!.has(edge.sequelId)) continue;
      outgoing.get(edge.predecessorId)!.add(edge.sequelId);
      incoming.set(edge.sequelId, incoming.get(edge.sequelId)! + 1);
    }
    const workOrder: string[] = [];
    const ready = component.filter((id) => incoming.get(id) === 0).toSorted();
    while (ready.length > 0) {
      const id = ready.shift()!;
      workOrder.push(id);
      for (const sequelId of [...outgoing.get(id)!].toSorted()) {
        incoming.set(sequelId, incoming.get(sequelId)! - 1);
        if (incoming.get(sequelId) === 0) {
          ready.push(sequelId);
          ready.sort();
        }
      }
    }
    workOrder.push(
      ...component.filter((id) => !workOrder.includes(id)).toSorted(),
    );
    const projectedWorks = workOrder.map((workId): BangumiWorkViewModel => {
      const work = works.get(workId)!;
      const title =
        metadata(work.metadata, "bangumi.subject.name.zh-hans") ??
        metadata(work.metadata, "bangumi.subject.name") ??
        work.label;
      const summary = metadata(work.metadata, "bangumi.subject.description");
      const date = metadata(work.metadata, "bangumi.subject.date");
      const artwork = targetArtwork(work.facts, work.id);
      const episodes = accepted
        .filter((fact) =>
          fact.relationships?.some(
            (relationship) =>
              relationship.participants.some(
                (participant) => participant.entityId === fact.id,
              ) &&
              relationship.participants.some(
                (participant) => participant.entityId === work.id,
              ) &&
              relationship.type === "asset.membership" &&
              relationship.participants.some(
                (participant) =>
                  participant.role === "bangumi.subject.ordinary-episode",
              ),
          ),
        )
        .flatMap((fact) => {
          const memberships = fact.relationships.filter(
            (relationship) =>
              relationship.type === "asset.membership" &&
              relationship.participants.some(
                (participant) =>
                  participant.entityId === fact.id &&
                  participant.role === "asset",
              ) &&
              relationship.participants.some(
                (participant) =>
                  participant.entityId === work.id &&
                  participant.role === "bangumi.subject.ordinary-episode",
              ),
          );
          return memberships.flatMap((relationship) => {
            const episode = episodeFrom(fact, work.id, relationship);
            return episode === undefined ? [] : [episode];
          });
        })
        .toSorted(
          (left, right) =>
            left.localPosition - right.localPosition ||
            left.continuousPosition - right.continuousPosition ||
            left.assetId.localeCompare(right.assetId),
        );
      return {
        id: work.id,
        title,
        ...(summary === undefined ? {} : { summary }),
        ...(date === undefined ? {} : { date }),
        ...(artwork.address === undefined ? {} : { cover: artwork.address }),
        ...(work.sourceKey === undefined
          ? {}
          : { officialPage: `https://bgm.tv/subject/${work.sourceKey}` }),
        episodes,
        factProblems: [
          ...work.facts.flatMap(factProblems),
          ...(artwork.problem === undefined ? [] : [artwork.problem]),
        ],
      };
    });
    const first = projectedWorks[0];
    if (
      first === undefined ||
      projectedWorks.every((work) => work.episodes.length === 0)
    )
      return [];
    return [
      {
        id: `bangumi-series:${workOrder[0]}`,
        component: "bangumi",
        title: first.title,
        ...(first.summary === undefined ? {} : { summary: first.summary }),
        ...(first.date === undefined ? {} : { date: first.date }),
        ...(first.cover === undefined ? {} : { cover: first.cover }),
        works: projectedWorks,
        factProblems: projectedWorks.flatMap((work) => work.factProblems ?? []),
        episodes: projectedWorks.flatMap((work) => work.episodes),
      },
    ];
  });
}
