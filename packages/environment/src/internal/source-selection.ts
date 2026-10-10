import path from "node:path";

import {
  supportedSourceModes,
  type JsonValue,
  type SupportedSourceMode,
} from "./record.ts";

/**
 * 环境只传递有界的来源装配选择：模式、受控清单的绝对路径与内容身份。
 * 清单内容与响应字节由可执行根自己读取，环境不认识来源、作品或响应格式。
 */
export const sourceModeVariable = "DIGITAL_SOURCE_IO_MODE";
export const sourceConfigVariable = "DIGITAL_SOURCE_IO_CONFIG";
export const sourceIdentityVariable = "DIGITAL_SOURCE_IO_IDENTITY";

export const sourceSelectionConfigKey = "sourceIo";

export type SourceSelection =
  | { readonly mode: "offline" }
  | { readonly mode: "real" }
  | {
      readonly mode: "controlled";
      readonly manifestPath: string;
      readonly contentIdentity: string;
    };

const identityPattern = /^sha256:[a-f0-9]{64}$/u;

function asSupportedMode(value: string): SupportedSourceMode | undefined {
  return (supportedSourceModes as readonly string[]).includes(value)
    ? (value as SupportedSourceMode)
    : undefined;
}

/**
 * 核验选择的完整性与归属，返回问题文本或经核验的选择。受控模式必须给出调用方选择的
 * 清单绝对路径与内容身份；不默认寻找任何私人目录。
 */
export function validateSourceSelection(input: {
  readonly sourceMode: string;
  readonly config: { readonly [key: string]: JsonValue };
  readonly workspacePath: string;
}): { readonly reason: string } | SourceSelection {
  const mode = asSupportedMode(input.sourceMode);
  if (mode === undefined)
    return {
      reason: `未知来源模式：${input.sourceMode}，只支持 ${supportedSourceModes.join("、")}`,
    };
  const declared = input.config[sourceSelectionConfigKey];
  if (mode !== "controlled") {
    if (declared !== undefined)
      return { reason: `来源模式 ${mode} 不接受受控清单选择` };
    return mode === "real" ? { mode: "real" } : { mode: "offline" };
  }
  if (
    declared === null ||
    typeof declared !== "object" ||
    Array.isArray(declared)
  )
    return { reason: "受控来源模式必须在运行配置中给出 sourceIo 清单选择" };
  const selection = declared as Record<string, unknown>;
  const unknownKey = Object.keys(selection).find(
    (key) => key !== "manifestPath" && key !== "contentIdentity",
  );
  if (unknownKey !== undefined)
    return { reason: `受控清单选择包含未知字段 ${unknownKey}` };
  const manifestPath = selection.manifestPath;
  const contentIdentity = selection.contentIdentity;
  if (
    typeof manifestPath !== "string" ||
    manifestPath.length === 0 ||
    !path.isAbsolute(manifestPath)
  )
    return { reason: "受控清单路径必须是非空绝对路径" };
  if (
    typeof contentIdentity !== "string" ||
    !identityPattern.test(contentIdentity)
  )
    return { reason: "受控清单必须给出 sha256 内容身份" };
  // 素材与响应属于仓库资料目录，不属于 environment 包的实现。
  const environmentPackage = path.resolve(
    input.workspacePath,
    "packages",
    "environment",
  );
  const resolvedManifest = path.resolve(manifestPath);
  if (
    resolvedManifest === environmentPackage ||
    resolvedManifest.startsWith(`${environmentPackage}${path.sep}`)
  )
    return { reason: "受控清单不得位于 environment 包内" };
  return {
    mode: "controlled",
    manifestPath: resolvedManifest,
    contentIdentity,
  };
}

/** 构造子进程的来源装配 env。托管世代的每一种选择都必须显式声明，`offline` 也带上判别值，
 * 否则可执行根会把没有选择当成未管理，落回真实来源装配。 */
export function sourceSelectionEnvironment(selection: SourceSelection): {
  readonly [key: string]: string;
} {
  if (selection.mode === "offline") return { [sourceModeVariable]: "offline" };
  if (selection.mode === "real") return { [sourceModeVariable]: "real" };
  return {
    [sourceModeVariable]: "controlled",
    [sourceConfigVariable]: selection.manifestPath,
    [sourceIdentityVariable]: selection.contentIdentity,
  };
}

/**
 * 从已经过请求核验的记录派生子进程来源 env。走到这里仍无效属于代码缺陷，
 * 明确抛出而不是退回默认装配。
 */
export function requireSourceSelectionEnvironment(input: {
  readonly sourceMode: string;
  readonly config: { readonly [key: string]: JsonValue };
  readonly workspacePath: string;
}): { readonly [key: string]: string } {
  const selection = validateSourceSelection(input);
  if ("reason" in selection)
    throw new Error(`已核验的来源选择在操作中失效：${selection.reason}`);
  return sourceSelectionEnvironment(selection);
}
