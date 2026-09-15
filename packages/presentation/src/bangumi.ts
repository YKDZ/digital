import type { AssetViewFacts } from "./index";

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
};

export type BangumiWorkViewModel = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly date?: string;
  readonly cover?: string;
  readonly officialPage?: string;
  readonly episodes: readonly BangumiEpisodeViewModel[];
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
  readonly works: readonly BangumiWorkViewModel[];
  readonly episodes: readonly BangumiEpisodeViewModel[];
};

type WorkState = {
  readonly id: string;
  label: string;
  sourceKey?: string;
  readonly metadata: Array<AssetViewFacts["metadata"][number]>;
  readonly facts: AssetViewFacts[];
};

type SequelEdge = {
  readonly predecessorId: string;
  readonly sequelId: string;
};

function metadata(
  values: readonly AssetViewFacts["metadata"][number][],
  property: string,
): string | undefined {
  return values.find((item) => item.property === property)?.value;
}

function numberMetadata(
  values: readonly AssetViewFacts["metadata"][number][],
  property: string,
): number | undefined {
  const value = Number(metadata(values, property));
  return Number.isFinite(value) ? value : undefined;
}

function managedArtwork(
  facts: readonly AssetViewFacts[],
  subjectId: string,
): string | undefined {
  for (const fact of facts) {
    const coverArtifactIds = [
      ...new Set(
        fact.artifactAssociations.flatMap((association) =>
          association.target.kind === "entity" &&
          association.target.entityId === subjectId &&
          association.role === "asset.primary-cover"
            ? [association.artifactId]
            : [],
        ),
      ),
    ];
    if (coverArtifactIds.length !== 1) continue;
    const location = fact.locations.find(
      (item) =>
        item.artifactId === coverArtifactIds[0] && item.kind === "managed",
    );
    if (location !== undefined) return location.address;
  }
  return undefined;
}

function episodeFrom(
  fact: AssetViewFacts,
  workId: string,
): BangumiEpisodeViewModel | undefined {
  const localPosition = numberMetadata(
    fact.metadata,
    "bangumi.episode.season-position",
  );
  const continuousPosition = numberMetadata(
    fact.metadata,
    "bangumi.episode.continuous-position",
  );
  if (localPosition === undefined || continuousPosition === undefined)
    return undefined;
  const title =
    metadata(fact.metadata, "asset.title.zh-hans") ??
    metadata(fact.metadata, "asset.title") ??
    `第 ${localPosition} 集`;
  const summary =
    metadata(fact.metadata, "asset.description") ??
    metadata(fact.metadata, "asset.summary");
  const date = metadata(fact.metadata, "asset.release-date");
  const artwork = managedArtwork([fact], fact.id);
  return {
    assetId: fact.id,
    workId,
    title,
    ...(summary === undefined ? {} : { summary }),
    ...(date === undefined ? {} : { date }),
    localPosition,
    continuousPosition,
    available: fact.locations.some((item) => item.kind === "observed"),
    ...(artwork === undefined ? {} : { artwork }),
    officialPage: fact.sourceAssociation!.nativeAddress,
    actionTarget: { subjectId: fact.id },
  };
}

/**
 * 将完整已接受目录投影为有限的 Bangumi 浏览根。读取关系图只为选择显式作品链；
 * 发出的子项是展示节点，绝不会成为领域包含关系。
 */
export function projectBangumiCatalogue(
  facts: readonly AssetViewFacts[],
): readonly BangumiSeriesViewModel[] {
  const accepted = facts.filter(
    (fact) => fact.sourceAssociation?.sourceIdentity === "bangumi",
  );
  const works = new Map<string, WorkState>();
  for (const fact of accepted) {
    for (const entity of fact.currentRelatedEntities ?? []) {
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
      work.metadata.push(
        ...fact.metadata.filter((item) => item.subjectId === entity.id),
      );
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
      const cover = managedArtwork(work.facts, work.id);
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
          const episode = episodeFrom(fact, work.id);
          return episode === undefined ? [] : [episode];
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
        ...(cover === undefined ? {} : { cover }),
        ...(work.sourceKey === undefined
          ? {}
          : { officialPage: `https://bgm.tv/subject/${work.sourceKey}` }),
        episodes,
      };
    });
    const first = projectedWorks[0];
    if (first === undefined) return [];
    return [
      {
        id: `bangumi-series:${workOrder[0]}`,
        component: "bangumi",
        title: first.title,
        ...(first.summary === undefined ? {} : { summary: first.summary }),
        ...(first.date === undefined ? {} : { date: first.date }),
        ...(first.cover === undefined ? {} : { cover: first.cover }),
        works: projectedWorks,
        episodes: projectedWorks.flatMap((work) => work.episodes),
      },
    ];
  });
}
