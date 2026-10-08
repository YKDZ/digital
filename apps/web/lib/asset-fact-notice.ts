import type { AssetViewModel } from "@digital/web-delivery/client";

/**
 * 卡片行、详情通知共同消费的最小事实视图。正式首页投影（libraryAsset）与详情视图
 * （AssetViewModel）都结构满足它，因此两处复用同一分类，不再各写一份判断。
 */
export type AssetFactNoticeInput = Pick<AssetViewModel, "id"> &
  Partial<
    Pick<
      AssetViewModel,
      | "factProblems"
      | "missingFacts"
      | "informationReadiness"
      | "sources"
      | "officialPage"
    >
  >;

/** 展示坐标只映射为友好名称；未知坐标统一归入泛化说法，公共文案绝不显示坐标本身。 */
const COORDINATE_LABELS: Readonly<Record<string, string>> = {
  "asset.title": "标题",
  "asset.introduction": "简介",
  "asset.summary": "概览",
  "asset.body": "正文",
  "asset.release-date": "发布日期",
  "asset.publication-datetime": "发布时间",
  "asset.declared-language": "语言",
  "asset.content-classification": "分级",
  "asset.primary-cover": "封面",
  "asset.material-image": "图片",
  "book.isbn-13": "ISBN",
  "book.publisher": "出版社",
  "book.publication-date": "出版日期",
};
export function friendlyCoordinate(coordinate: string): string {
  return COORDINATE_LABELS[coordinate] ?? "部分资料";
}

const CONFLICT_REASONS: Readonly<Record<string, string>> = {
  "metadata-value-conflict": "同一项资料存在多个不同的值，尚未确定采用哪一个。",
  "policy-conflict":
    "不同来源之间的资料优先级暂时无法比较，尚未确定采用哪一个。",
  "artifact-association-conflict":
    "存在多张同等合适的图片，尚未确定使用哪一张。",
};

/**
 * 把生效读取的三个正交维度分别归类：描述缺失、描述冲突、获取履行状态。
 * 已归为缺失或冲突的必需坐标不再重复计入“暂无来源”，避免同一问题双重表达。
 */
export type AssetFactNotice = {
  readonly hasProblem: boolean;
  readonly missingLabels: readonly string[];
  readonly conflictReasons: readonly string[];
  readonly conflictFields: readonly string[];
  readonly problemReasons: readonly string[];
  readonly fulfillmentReasons: readonly string[];
  readonly evidence: {
    readonly correctionHref: string;
    readonly sourcePages: readonly {
      readonly label: string;
      readonly url: string;
    }[];
    readonly refreshHrefs: readonly string[];
  };
};

export function assetFactNotice(asset: AssetFactNoticeInput): AssetFactNotice {
  const problems = asset.factProblems ?? [];
  const conflicts = problems.flatMap((problem) => problem.conflicts);
  const conflictedCoordinates = new Set(
    conflicts
      .map((conflict) => conflict.property ?? conflict.role)
      .filter((coordinate): coordinate is string => coordinate !== undefined),
  );
  const conflictReasons = [
    ...new Set(
      conflicts
        .map((conflict) => CONFLICT_REASONS[conflict.kind])
        .filter((reason): reason is string => reason !== undefined),
    ),
  ];
  const conflictFields = [...conflictedCoordinates].map(friendlyCoordinate);

  // 没有可比冲突的问题（如图片可用性）仍带友好说明，不能只靠 conflicts 归类而丢失消息。
  const problemReasons = [
    ...new Set(
      problems
        .filter((problem) => problem.conflicts.length === 0)
        .map((problem) => problem.message)
        .filter((message) => message.trim().length > 0),
    ),
  ];

  const missingLabels = [
    ...new Set((asset.missingFacts ?? []).map(friendlyCoordinate)),
  ];
  const missingCoordinates = new Set(asset.missingFacts ?? []);

  const inputs = asset.informationReadiness?.inputs ?? [];
  const fulfillment = new Set<string>();
  const refreshExecutions = new Set<string>();
  for (const input of inputs) {
    for (const reference of input.executionReferences ?? [])
      refreshExecutions.add(
        `/inspection?record=${encodeURIComponent(reference.workflowExecutionId)}`,
      );
    if (input.necessity !== "required") continue;
    if (input.status === "pending") fulfillment.add("部分资料仍在自动获取中。");
    else if (input.status === "blocked")
      fulfillment.add("部分资料的获取当前已被暂停。");
    else if (
      input.status === "unavailable" &&
      !missingCoordinates.has(input.coordinate) &&
      !conflictedCoordinates.has(input.coordinate)
    )
      fulfillment.add("部分资料暂时没有可用的来源可以获取。");
  }

  const sourcePages = new Map<string, string>();
  for (const source of [
    ...(asset.sources ?? []),
    ...(asset.officialPage === undefined
      ? []
      : [{ officialPage: asset.officialPage }]),
  ]) {
    if (source.officialPage === undefined) continue;
    if (!sourcePages.has(source.officialPage))
      sourcePages.set(
        source.officialPage,
        "label" in source && source.label !== undefined ? source.label : "来源",
      );
  }

  const missingLabelsOnly = missingLabels.length > 0;
  return {
    hasProblem:
      missingLabelsOnly ||
      conflictReasons.length > 0 ||
      problemReasons.length > 0 ||
      fulfillment.size > 0,
    missingLabels,
    conflictReasons,
    conflictFields,
    problemReasons,
    fulfillmentReasons: [...fulfillment],
    evidence: {
      correctionHref: `/intake/enrich?asset=${encodeURIComponent(asset.id)}`,
      sourcePages: [...sourcePages].map(([url, label]) => ({ label, url })),
      refreshHrefs: [...refreshExecutions],
    },
  };
}
