import {
  BellDot,
  CircleGauge,
  FolderInput,
  FolderSync,
  LibraryBig,
  Settings2,
  TimerReset,
  Waypoints,
} from "@lucide/vue";

export type PrototypeScreen =
  | "overview"
  | "assets"
  | "asset"
  | "drop"
  | "inspection"
  | "attention"
  | "automation"
  | "export"
  | "settings";

export interface PrototypeState {
  attentionResolved: boolean;
  automaticRecognition: boolean;
  automationEnabled: boolean;
  exportApplied: boolean;
  exportPlanned: boolean;
  previewMode: "applied" | "proposed";
  refreshRunning: boolean;
}

export const prototypeScreens = [
  { id: "overview", label: "总览", icon: CircleGauge },
  { id: "assets", label: "浏览", icon: LibraryBig },
  { id: "asset", label: "葬送的芙莉莲", icon: LibraryBig },
  { id: "drop", label: "添加内容", icon: FolderInput },
  { id: "inspection", label: "刷新记录", icon: FolderSync },
  { id: "attention", label: "需要处理", icon: BellDot },
  { id: "automation", label: "自动刷新", icon: TimerReset },
  { id: "export", label: "整理与导出", icon: Waypoints },
  { id: "settings", label: "设置", icon: Settings2 },
] as const satisfies ReadonlyArray<{
  id: PrototypeScreen;
  label: string;
  icon: typeof CircleGauge;
}>;

export const assets = [
  {
    id: "frieren",
    title: "葬送的芙莉莲",
    subtitle: "葬送のフリーレン",
    year: "2023–2026",
    summary: "38 集 · 两季",
    availability: "全部可用",
    tone: "from-violet-950 via-violet-800 to-fuchsia-500",
  },
  {
    id: "terror-live",
    title: "恐怖直播",
    subtitle: "더 테러 라이브",
    year: "2013",
    summary: "97 分钟",
    availability: "本地可用",
    tone: "from-red-950 via-red-800 to-orange-500",
  },
  {
    id: "imouto-life",
    title: "妹妹人生〈上〉",
    subtitle: "いもーとらいふ",
    year: "2017",
    summary: "入间人间",
    availability: "本地可用",
    tone: "from-sky-950 via-sky-700 to-cyan-400",
  },
  {
    id: "sekai-album",
    title: "SEKAI ALBUM vol.3",
    subtitle: "プロジェクトセカイ",
    year: "2025",
    summary: "12 首曲目",
    availability: "全部可用",
    tone: "from-cyan-950 via-cyan-700 to-teal-300",
  },
  {
    id: "creator-post",
    title: "今年も一年ありがとうございました。",
    subtitle: "customudon · 2020-12-29",
    year: "2020",
    summary: "正文与附件",
    availability: "部分内容不可用",
    tone: "from-pink-950 via-pink-700 to-rose-300",
  },
  {
    id: "audio-work",
    title: "しあわせおうちでーと・新海天",
    subtitle: "VJ014635",
    year: "2021",
    summary: "正篇与赠品",
    availability: "本地可用",
    tone: "from-amber-950 via-amber-700 to-yellow-300",
  },
  {
    id: "visual-fanbook",
    title: "世界计划官方视觉粉丝书 Vol.3",
    subtitle: "332 页",
    year: "—",
    summary: "图片浏览",
    availability: "本地可用",
    tone: "from-emerald-950 via-emerald-700 to-lime-300",
  },
  {
    id: "collector-film",
    title: "怒火救援",
    subtitle: "Man on Fire",
    year: "2004",
    summary: "蓝光收藏内容",
    availability: "本地可用",
    tone: "from-orange-950 via-orange-700 to-amber-300",
  },
] as const;

export const attentionItems = [
  {
    id: "identity",
    title: "两个匹配规则给出了不同结果",
    scope: "Boku no Risou no Isekai Seikatsu - 04",
    reason: "文件名和目录可以匹配两个不同条目，需要确认正确结果。",
    action: "比较刮削结果",
    severity: "无法自动继续",
  },
  {
    id: "entitlement",
    title: "部分在线内容暂时无法获取",
    scope: "customudon · 2024-03-07",
    reason: "帖子和附件已经找到，但当前登录状态无法读取受限正文。",
    action: "查看可用内容",
    severity: "部分完成",
  },
  {
    id: "export",
    title: "无法确定相关册的顺序",
    scope: "世界计划官方视觉粉丝书 Vol.3",
    reason: "正常浏览不受影响，但当前目录结构需要明确的系列顺序。",
    action: "更改导出设置",
    severity: "无法导出",
  },
] as const;

export const refreshWorkItems = [
  {
    title: "检查文件",
    detail: "正在确认新增、更新和已经移除的文件",
    state: "已完成",
    outcome: "没有异常",
  },
  {
    title: "刮削新内容",
    detail: "根据文件名、目录和可用编号查找匹配结果",
    state: "已完成",
    outcome: "新增 7 项",
  },
  {
    title: "刷新元数据",
    detail: "更新当前内容已经关联的在线资料",
    state: "进行中",
    outcome: "9 / 13",
  },
  {
    title: "获取图片",
    detail: "保存当前页面需要的封面与背景图",
    state: "等待中",
    outcome: "等待刷新完成",
  },
] as const;
