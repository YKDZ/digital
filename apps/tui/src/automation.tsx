import {
  PublicApiClientError,
  PublicExecutionClientError,
} from "@digital/public-api";
import type {
  PublicApiClient,
  PublicAssetLibrary,
  PublicAutomationIntent,
  PublicExecutionInspection,
  WorkflowHistoryPage,
} from "@digital/public-api";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

type AutomationClient = Pick<
  PublicApiClient,
  | "listAutomationIntents"
  | "enableAutomationIntent"
  | "disableAutomationIntent"
  | "triggerAutomationIntent"
  | "listWorkflowHistory"
  | "inspectExecution"
  | "cancelExecution"
>;

type AutomationPanelProps = {
  readonly client: AutomationClient;
  readonly library: PublicAssetLibrary;
  readonly onExit: () => void;
};

const intervalOptions = [
  { milliseconds: 3_600_000, label: "1 小时" },
  { milliseconds: 21_600_000, label: "6 小时" },
  { milliseconds: 86_400_000, label: "24 小时" },
] as const;

export function AutomationPanel({
  client,
  library,
  onExit,
}: AutomationPanelProps) {
  const [intents, setIntents] = useState<readonly PublicAutomationIntent[]>([]);
  const [history, setHistory] = useState<WorkflowHistoryPage>({ items: [] });
  const [selected, setSelected] = useState(0);
  const [intervalOverride, setIntervalOverride] = useState<number>();
  const [acceptTrustedOverride, setAcceptTrustedOverride] = useState<boolean>();
  const [relativeScopeOverride, setRelativeScopeOverride] = useState<string>();
  const [scopeEditing, setScopeEditing] = useState(false);
  const [scopeInput, setScopeInput] = useState("");
  const [message, setMessage] = useState("正在读取自动刷新设置…");
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [activeExecutionId, setActiveExecutionId] = useState<string>();
  const [activeExecution, setActiveExecution] =
    useState<PublicExecutionInspection>();

  const directories = library.directories;
  const activeDirectory = directories[selected];
  const libraryIntents = useMemo(
    () => intents.filter(({ scope }) => scope.assetLibraryId === library.id),
    [intents, library.id],
  );
  const selectedIntents = libraryIntents.filter(
    ({ scope }) => scope.directoryId === activeDirectory?.id,
  );
  const enabledIntent = selectedIntents.findLast(({ enabled }) => enabled);
  const latestSelectedIntent = enabledIntent ?? selectedIntents.at(-1);
  const configuredIntervalIndex = Math.max(
    0,
    intervalOptions.findIndex(
      ({ milliseconds }) =>
        milliseconds === latestSelectedIntent?.intervalMilliseconds,
    ),
  );
  const intervalIndex = intervalOverride ?? configuredIntervalIndex;
  const acceptTrusted =
    acceptTrustedOverride ?? latestSelectedIntent?.acceptTrusted ?? true;
  const relativeScope =
    relativeScopeOverride ?? latestSelectedIntent?.scope.relativeScope ?? ".";
  useEffect(() => {
    let active = true;
    void Promise.all([
      client.listAutomationIntents(),
      client.listWorkflowHistory({ limit: 100 }),
    ])
      .then(([result, workflowHistory]) => {
        if (!active) return;
        setIntents(result.items);
        setHistory(workflowHistory);
        const intentIds = new Set(
          result.items
            .filter(({ scope }) => scope.assetLibraryId === library.id)
            .map(({ id }) => id),
        );
        const runningExecution = workflowHistory.items.find(
          ({ execution }) =>
            execution.status === "running" &&
            execution.automationIntentId !== undefined &&
            intentIds.has(execution.automationIntentId),
        );
        if (runningExecution !== undefined)
          setActiveExecutionId(runningExecution.execution.id);
        setReadFailed(false);
        setMessage("");
      })
      .catch(() => {
        if (!active) return;
        setReadFailed(true);
        setMessage("暂时无法读取自动刷新状态，请按 r 重试");
      });
    return () => {
      active = false;
    };
  }, [client, library.id, reloadVersion]);

  useEffect(() => {
    if (activeExecutionId === undefined) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inspect = async () => {
      try {
        const result = await client.inspectExecution(activeExecutionId);
        if (!active) return;
        setActiveExecution(result);
        if (executionStatus(result) === "进行中") {
          timer = setTimeout(() => void inspect(), 500);
        } else {
          setMessage(`自动刷新${executionStatus(result)}`);
          setReloadVersion((version) => version + 1);
        }
      } catch {
        if (!active) return;
        setMessage("暂时无法读取自动刷新进度");
        timer = setTimeout(() => void inspect(), 1_500);
      }
    };
    void inspect();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [activeExecutionId, client]);

  const refresh = () => setReloadVersion((version) => version + 1);

  const enable = async () => {
    if (activeDirectory === undefined) {
      setMessage("此资产库没有可配置目录");
      return;
    }
    if (activeDirectory.status !== "active" || !activeDirectory.reachable) {
      setMessage("所选目录当前不可用，请检查资产库设置");
      return;
    }
    if (enabledIntent !== undefined) {
      setMessage("此目录已有启用设置；停用后可重新配置");
      return;
    }
    setBusy(true);
    setMessage("正在保存自动刷新设置并执行首次扫描…");
    try {
      const interval = intervalOptions[intervalIndex];
      if (interval === undefined) throw new Error("自动刷新间隔无效");
      const result = await client.enableAutomationIntent({
        assetLibraryId: library.id,
        directoryId: activeDirectory.id,
        relativeScope,
        intervalMilliseconds: interval.milliseconds,
        acceptTrusted,
      });
      if (result.initial?.status === "started") {
        setActiveExecutionId(result.initial.executionId);
      } else if (result.initial?.status === "skipped") {
        setMessage(`设置已启用；首次刷新未启动：${result.initial.reason}`);
      } else if (result.initial?.status === "disabled") {
        setMessage(`设置已保存，但自动刷新已停用：${result.initial.reason}`);
      } else setMessage("自动刷新设置已启用");
      refresh();
    } catch (error) {
      setMessage(operationFailureMessage(error, "启用"));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (enabledIntent === undefined) {
      setMessage("所选目录没有启用中的自动刷新设置");
      return;
    }
    setBusy(true);
    try {
      await client.disableAutomationIntent(enabledIntent.id);
      setMessage("自动刷新已停用；正在运行的执行会按执行状态结束");
      refresh();
    } catch (error) {
      setMessage(operationFailureMessage(error, "停用"));
    } finally {
      setBusy(false);
    }
  };

  const trigger = async () => {
    const intent = latestSelectedIntent;
    if (intent === undefined) {
      setMessage("请先为所选目录启用自动刷新");
      return;
    }
    setBusy(true);
    setMessage("正在提交立即扫描…");
    try {
      const result = await client.triggerAutomationIntent(intent.id);
      if (result.status === "started") {
        setActiveExecutionId(result.executionId);
        setActiveExecution(undefined);
        setMessage("立即扫描已提交，正在查询实际执行状态");
      } else if (result.status === "disabled") {
        setMessage("自动刷新设置已停用");
      } else {
        setMessage("已有自动刷新正在执行，本次未重复启动");
      }
      refresh();
    } catch (error) {
      setMessage(operationFailureMessage(error, "立即扫描"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (activeExecutionId === undefined) return;
    setBusy(true);
    try {
      const result = await client.cancelExecution(activeExecutionId);
      setActiveExecution(result.inspection);
      setMessage(
        result.requestStatus === "requested"
          ? "取消请求已提交，仍在等待实际结局"
          : `执行${executionStatus(result.inspection)}`,
      );
    } catch (error) {
      setMessage(operationFailureMessage(error, "取消"));
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (scopeEditing) {
      if (key.escape) {
        setScopeEditing(false);
        return;
      }
      if (key.return) {
        const value = scopeInput.trim();
        if (value.length === 0) {
          setMessage("请输入目录下的相对范围，例如 . 或 子目录");
          return;
        }
        setRelativeScopeOverride(value);
        setScopeEditing(false);
        setMessage("扫描范围已更新");
        return;
      }
      if (key.ctrl && input.toLowerCase() === "u") {
        setScopeInput("");
        return;
      }
      if (key.backspace || key.delete) {
        setScopeInput((value) => Array.from(value).slice(0, -1).join(""));
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta)
        setScopeInput((value) => value + input);
      return;
    }
    if (input === "q" || key.escape) {
      onExit();
      return;
    }
    if (busy) return;
    if (input === "r") {
      setMessage("正在重新读取自动刷新状态…");
      refresh();
      return;
    }
    if (input === "i") {
      setIntervalOverride(
        (index) =>
          ((index ?? configuredIntervalIndex) + 1) % intervalOptions.length,
      );
      return;
    }
    if (input === "t") {
      setAcceptTrustedOverride(
        (value) => !(value ?? latestSelectedIntent?.acceptTrusted ?? true),
      );
      return;
    }
    if (input === "f") {
      setScopeInput(relativeScope);
      setScopeEditing(true);
      setMessage("输入资产库目录下的相对范围，Enter 保存，Esc 取消");
      return;
    }
    if ((key.downArrow || input === "j") && selected < directories.length - 1) {
      setSelected((index) => index + 1);
      setIntervalOverride(undefined);
      setAcceptTrustedOverride(undefined);
      setRelativeScopeOverride(undefined);
    } else if ((key.upArrow || input === "k") && selected > 0) {
      setSelected((index) => index - 1);
      setIntervalOverride(undefined);
      setAcceptTrustedOverride(undefined);
      setRelativeScopeOverride(undefined);
    } else if (input === "e") void enable();
    else if (input === "d") void disable();
    else if (input === "s") void trigger();
    else if (input === "c") void cancel();
  });

  const interval = intervalOptions[intervalIndex];
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        自动刷新：{library.displayName}
      </Text>
      <Text dimColor>目录仅显示名称；产品服务按已保存设置独立运行。</Text>
      {directories.map((directory, index) => {
        const directoryIntents = libraryIntents.filter(
          ({ scope }) => scope.directoryId === directory.id,
        );
        const enabled = directoryIntents.find(({ enabled: value }) => value);
        const latest = directoryIntents.at(-1);
        const current = enabled ?? latest;
        const latestRun =
          current === undefined
            ? undefined
            : history.items.find(
                ({ execution }) => execution.automationIntentId === current.id,
              )?.execution;
        const availability =
          directory.status !== "active"
            ? "目录已移除"
            : !directory.reachable
              ? "目录不可用"
              : "未设置";
        const rowStatus =
          current === undefined
            ? availability
            : `${current.enabled ? "已启用" : disabledReasonLabel(current.disabledReason)} · ${intervalLabel(current.intervalMilliseconds)} · ${current.acceptTrusted ? "信任结果可自动应用" : "信任结果需审阅"}`;
        return (
          <Box key={directory.id} flexDirection="column">
            <Text {...(index === selected ? { color: "green" } : {})}>
              {index === selected ? "› " : "  "}
              {directory.displayName}　{rowStatus}
            </Text>
            {latestRun !== undefined ? (
              <Text dimColor>
                {index === selected ? "  " : "  "}最近执行：
                {executionHistoryStatus(latestRun.status, latestRun.outcome)}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {directories.length === 0 ? (
        <Text dimColor>此资产库没有目录设置</Text>
      ) : null}
      <Text>
        扫描范围（相对目录）：
        {scopeEditing ? `编辑中：${scopeInput}` : relativeScope}
      </Text>
      <Text>
        新设置：{interval?.label ?? "未知"}　信任结果：
        {acceptTrusted ? "自动应用" : "需审阅"}
      </Text>
      {activeExecution !== undefined ? (
        <Text
          color={executionStatus(activeExecution) === "失败" ? "red" : "cyan"}
        >
          当前执行：{executionStatus(activeExecution)}
          {executionProgress(activeExecution)}
        </Text>
      ) : null}
      {message.length > 0 ? (
        <Text color={readFailed ? "red" : "gray"}>{message}</Text>
      ) : null}
      <Text dimColor>
        {scopeEditing
          ? "输入范围　Enter 保存　Esc 取消　Ctrl+U 清空"
          : "↑↓/j k 选择　f 编辑范围　i 间隔　t 信任策略　e 启用　d 停用　s 立即扫描　c 请求取消　r 重读　q 返回"}
      </Text>
    </Box>
  );
}

function disabledReasonLabel(
  reason: PublicAutomationIntent["disabledReason"],
): string {
  switch (reason) {
    case "observed-root-revoked":
      return "目录授权已撤销";
    case "observed-root-unavailable":
      return "目录当前不可用";
    case "prerequisite-unavailable":
      return "所需配置不可用";
    case "invalid-configuration":
      return "设置需要检查";
    default:
      return "已停用";
  }
}

function intervalLabel(milliseconds: number): string {
  const hours = milliseconds / 3_600_000;
  return Number.isInteger(hours) ? `${hours} 小时` : "自定义间隔";
}

function executionStatus(execution: PublicExecutionInspection): string {
  const status = execution.status;
  const outcome = execution.outcome;
  if (status === "running") return "进行中";
  return executionHistoryStatus(status, outcome);
}

function executionHistoryStatus(
  status: "running" | "completed" | "failed",
  outcome: string | undefined,
): string {
  if (status === "running") return "进行中";
  if (status === "failed" || outcome === "failed") return "失败";
  if (outcome === "cancelled") return "已取消";
  if (outcome === "interrupted") return "已中断";
  if (outcome === "partially-succeeded") return "部分完成";
  if (outcome === "no-change") return "无变更";
  if (outcome === "accepted") return "已识别";
  if (outcome === "unresolved") return "未识别";
  if (outcome === "proposal") return "待确认";
  return "已完成";
}

function executionProgress(execution: PublicExecutionInspection): string {
  if (execution.kind !== "asset-library-scan") return "";
  const completed = execution.children.filter(
    (child) =>
      child.status === "available" && child.execution.status !== "running",
  ).length;
  return `（${completed}/${execution.children.length} 个目录项结束）`;
}

function operationFailureMessage(error: unknown, action: string): string {
  if (error instanceof PublicApiClientError) {
    switch (error.kind) {
      case "invalid-request":
        return `自动刷新${action}失败：设置无效`;
      case "conflict":
        return `自动刷新${action}失败：资产库或目录设置已变化，请重新读取`;
      case "not-found":
        return `自动刷新${action}失败：设置不存在或已移除`;
      case "not-ready":
        return `自动刷新${action}失败：目录当前不可用`;
      default:
        return `自动刷新${action}失败：产品服务暂时不可用`;
    }
  }
  if (error instanceof PublicExecutionClientError) {
    if (error.kind === "not-found") return "执行记录不存在或已移除";
    if (error.kind === "conflict") return "执行状态已变化，请重新查询";
  }
  return `自动刷新${action}失败，请稍后重试`;
}
