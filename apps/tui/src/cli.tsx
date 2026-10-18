#!/usr/bin/env node
import {
  createPublicApiClient,
  PublicApiClientError,
  PublicExecutionClientError,
} from "@digital/public-api";
import type {
  PublicExecutionInspection,
  PublicAssetLibrary,
  PublicAssetLibraryOptions,
  PublicAssetLibraryScan,
  PublicCurrentAsset,
  PublicPage,
  PublicUnrecognizedMaterial,
} from "@digital/public-api";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";

import { AssetInspectionPanel, WorkItemsPanel } from "./asset-inspection.tsx";
import { AutomationPanel } from "./automation.tsx";
import { SourceConnectionsPanel } from "./source-connections.tsx";
type RefreshKind = "library-scan" | "rescrape" | "metadata-refresh" | "unknown";

type Mode =
  | "libraries"
  | "assets"
  | "unrecognized"
  | "scan"
  | "inspection"
  | "attention"
  | "history"
  | "connections"
  | "automation";
type Row = PublicAssetLibrary | PublicCurrentAsset | PublicUnrecognizedMaterial;
type EditorStage = "name" | "directories" | "profiles" | "sources";
type LibraryEditor = {
  readonly id?: string | undefined;
  readonly expectedVersion?: number | undefined;
  readonly stage: EditorStage;
  readonly displayName: string;
  readonly directories: readonly string[];
  readonly recognitionProfileIds: readonly string[];
  readonly sourceIdentities: readonly string[];
  readonly input: string;
  readonly selectedChoice: number;
  readonly error?: string | undefined;
};

function argumentValue(
  arguments_: readonly string[],
  name: string,
): string | undefined {
  const index = arguments_.findIndex((argument) => argument === name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function argumentUrl(arguments_: readonly string[]): string {
  const value = argumentValue(arguments_, "--url");
  if (value !== undefined) return value;
  if (arguments_.includes("--url"))
    throw new Error("请在 --url 后提供服务地址");
  return process.env.DIGITAL_PRODUCT_URL ?? "http://127.0.0.1:3000";
}

function App({
  baseUrl,
  initialExecutionId,
}: {
  readonly baseUrl: string;
  readonly initialExecutionId?: string | undefined;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const sourceConnectionClient = useMemo(
    () => createPublicApiClient({ baseUrl }),
    [baseUrl],
  );
  const [mode, setMode] = useState<Mode>(
    initialExecutionId === undefined ? "libraries" : "scan",
  );
  const inspectionClient = useMemo(
    () => createPublicApiClient({ baseUrl }),
    [baseUrl],
  );
  const [page, setPage] = useState<PublicPage<Row>>({ items: [] });
  const [libraryId, setLibraryId] = useState<string>();
  const [libraryName, setLibraryName] = useState<string>();
  const [automationLibrary, setAutomationLibrary] =
    useState<PublicAssetLibrary>();
  const [cursor, setCursor] = useState<string>();
  const [previousCursors, setPreviousCursors] = useState<
    readonly (string | undefined)[]
  >([]);
  const [selected, setSelected] = useState(0);
  const [filterText, setFilterText] = useState("");
  const [filterEditing, setFilterEditing] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [message, setMessage] = useState("正在读取…");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [editor, setEditor] = useState<LibraryEditor>();
  const [editorLoading, setEditorLoading] = useState(false);
  const [libraryOptions, setLibraryOptions] =
    useState<PublicAssetLibraryOptions>();
  const [pendingRemoval, setPendingRemoval] = useState<PublicAssetLibrary>();
  const [scanExecutionId, setScanExecutionId] = useState<string | undefined>(
    initialExecutionId,
  );
  const [scanResult, setScanResult] = useState<PublicAssetLibraryScan>();
  const [executionInspection, setExecutionInspection] =
    useState<PublicExecutionInspection>();
  const [refreshKind, setRefreshKind] = useState<RefreshKind>("unknown");
  const [cancelRequestStatus, setCancelRequestStatus] = useState<
    "requested" | "already-finished"
  >();
  const [scanError, setScanError] = useState<string>();
  const [scanReloadVersion, setScanReloadVersion] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [inspectionAssetId, setInspectionAssetId] = useState<string>();
  const [inspectionReturnMode, setInspectionReturnMode] =
    useState<Mode>("assets");
  const [workItemsReturnMode, setWorkItemsReturnMode] =
    useState<Mode>("libraries");
  const [terminalSize, setTerminalSize] = useState({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });

  useEffect(() => {
    const updateSize = () =>
      setTerminalSize({
        columns: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      });
    stdout.on("resize", updateSize);
    updateSize();
    return () => {
      stdout.off("resize", updateSize);
    };
  }, [stdout]);

  useEffect(() => {
    let active = true;
    const client = createPublicApiClient({ baseUrl });
    if (
      mode === "scan" ||
      isInspectionMode(mode) ||
      mode === "connections" ||
      mode === "automation"
    )
      return;
    void (async () => {
      try {
        const input = {
          ...(libraryId === undefined ? {} : { assetLibraryId: libraryId }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: 20,
        };
        const result =
          mode === "libraries"
            ? await client.listAssetLibraries(input)
            : mode === "assets"
              ? await client.listAssets(input)
              : await client.listUnrecognizedMaterials(input);
        if (active) {
          setPage(result);
          setReadFailed(false);
          setMessage(
            result.items.length === 0
              ? mode === "libraries"
                ? "还没有资产库"
                : "此页没有内容"
              : "",
          );
        }
      } catch (error) {
        if (!active) return;
        setPage({ items: [] });
        setReadFailed(true);
        setMessage(
          error instanceof PublicApiClientError
            ? error.message
            : "暂时无法读取资料",
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [baseUrl, cursor, libraryId, mode, reloadVersion]);

  useEffect(() => {
    if (mode !== "scan" || scanExecutionId === undefined) return;
    const client = createPublicApiClient({ baseUrl });
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inspect = async () => {
      try {
        const execution = await client.inspectExecution(scanExecutionId);
        if (!active) return;
        setExecutionInspection(execution);
        setScanError(undefined);
        if (execution.kind === "asset-library-scan") {
          setRefreshKind("library-scan");
          const result = await client.inspectAssetLibraryScan(scanExecutionId);
          if (!active) return;
          setScanResult(result);
          if (execution.status === "running")
            timer = setTimeout(() => void inspect(), 500);
          else {
            setMessage(
              executionResultMessage("扫描", result.status, result.outcome),
            );
            setReloadVersion((version) => version + 1);
          }
          return;
        }
        setScanResult(undefined);
        setRefreshKind(
          execution.operationKind === "rescrape"
            ? "rescrape"
            : execution.operationKind === "refresh-metadata"
              ? "metadata-refresh"
              : "unknown",
        );
        if (execution.status === "running")
          timer = setTimeout(() => void inspect(), 500);
        else {
          setMessage(
            executionResultMessage("刷新", execution.status, execution.outcome),
          );
          setReloadVersion((version) => version + 1);
        }
      } catch (error) {
        if (!active) return;
        setScanError(
          error instanceof PublicApiClientError ||
            error instanceof PublicExecutionClientError
            ? error.message
            : "暂时无法读取执行结果",
        );
        timer = setTimeout(() => void inspect(), 1500);
      }
    };
    void inspect();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [baseUrl, mode, scanExecutionId, scanReloadVersion]);

  const openLibraryEditor = (library?: PublicAssetLibrary) => {
    setEditorLoading(true);
    setMessage("正在读取识别能力与来源…");
    void createPublicApiClient({ baseUrl })
      .listAssetLibraryOptions()
      .then((options) => {
        setLibraryOptions(options);
        setEditor({
          ...(library === undefined
            ? {}
            : { id: library.id, expectedVersion: library.configVersion }),
          stage: "name",
          displayName: library?.displayName ?? "",
          directories:
            library?.directories
              .filter(({ status }) => status !== "removed")
              .map(({ path: directoryPath }) => directoryPath) ?? [],
          recognitionProfileIds: library?.recognitionProfileIds ?? [],
          sourceIdentities: library?.sourceIdentities ?? [],
          input: library?.displayName ?? "",
          selectedChoice: 0,
        });
        setMessage("");
      })
      .catch((error: unknown) => {
        setMessage(publicErrorMessage(error, "暂时无法读取资产库选项"));
        setReadFailed(true);
      })
      .finally(() => setEditorLoading(false));
  };

  const refreshLibraries = async (preferredId?: string) => {
    const result = await createPublicApiClient({ baseUrl }).listAssetLibraries({
      limit: 20,
    });
    setMode("libraries");
    setCursor(undefined);
    setPreviousCursors([]);
    setPage(result);
    setSelected(
      preferredId === undefined
        ? 0
        : Math.max(
            0,
            result.items.findIndex((item) => item.id === preferredId),
          ),
    );
    setReadFailed(false);
  };

  const saveEditor = async (current: LibraryEditor) => {
    if (actionBusy) return;
    setActionBusy(true);
    setMessage("正在保存资产库…");
    try {
      const client = createPublicApiClient({ baseUrl });
      const saved = await client.saveAssetLibrary({
        ...(current.id === undefined || current.expectedVersion === undefined
          ? {}
          : { id: current.id, expectedVersion: current.expectedVersion }),
        displayName: current.displayName,
        directories: [...current.directories],
        recognitionProfileIds: [...current.recognitionProfileIds],
        sourceIdentities: [...current.sourceIdentities],
      });
      const result = await client.listAssetLibraries({ limit: 20 });
      setPage(result);
      setMode("libraries");
      setCursor(undefined);
      setPreviousCursors([]);
      setSelected(
        Math.max(
          0,
          result.items.findIndex(({ id }) => id === saved.id),
        ),
      );
      setEditor(undefined);
      setReadFailed(false);
      setMessage(
        `已保存「${saved.displayName}」。目录路径由服务所在机器访问，不会上传客户端文件。`,
      );
    } catch (error) {
      setEditor({
        ...current,
        error: publicErrorMessage(error, "资产库保存失败"),
      });
      setMessage("");
    } finally {
      setActionBusy(false);
    }
  };

  const removeLibrary = async (library: PublicAssetLibrary) => {
    if (actionBusy) return;
    setActionBusy(true);
    setMessage(`正在移除「${library.displayName}」…`);
    try {
      await createPublicApiClient({ baseUrl }).removeAssetLibrary({
        id: library.id,
        expectedVersion: library.configVersion,
      });
      await refreshLibraries();
      setMessage(`已移除「${library.displayName}」的资产库配置`);
    } catch (error) {
      setMessage(publicErrorMessage(error, "资产库移除失败"));
    } finally {
      setActionBusy(false);
      setPendingRemoval(undefined);
    }
  };

  const startLibraryScan = async (library: PublicAssetLibrary) => {
    if (actionBusy) return;
    setActionBusy(true);
    setLibraryId(library.id);
    setLibraryName(library.displayName);
    setScanResult(undefined);
    setExecutionInspection(undefined);
    setScanExecutionId(undefined);
    setRefreshKind("library-scan");
    setCancelRequestStatus(undefined);
    setScanError(undefined);
    setMode("scan");
    setMessage("正在发起扫描…");
    try {
      const started = await createPublicApiClient({
        baseUrl,
      }).startAssetLibraryScan(library.id);
      setScanExecutionId(started.parentExecutionId);
      setMessage("已发起扫描");
    } catch (error) {
      setMode("libraries");
      setMessage(publicErrorMessage(error, "无法发起资产库扫描"));
    } finally {
      setActionBusy(false);
    }
  };

  const startSubjectRefresh = async (
    subjectId: string,
    kind: "rescrape" | "metadata-refresh",
  ) => {
    if (actionBusy) return;
    setActionBusy(true);
    setScanResult(undefined);
    setExecutionInspection(undefined);
    setScanExecutionId(undefined);
    setRefreshKind(kind);
    setCancelRequestStatus(undefined);
    setScanError(undefined);
    setMode("scan");
    setMessage(
      kind === "rescrape" ? "正在发起重新刮削…" : "正在发起元数据刷新…",
    );
    try {
      const client = createPublicApiClient({ baseUrl });
      const started =
        kind === "rescrape"
          ? await client.startCurrentScopeRescrape({ subjectId })
          : await client.startMetadataRefresh({ subjectId });
      setScanExecutionId(started.id);
      setMessage("已发起刷新");
    } catch (error) {
      setMode("assets");
      setMessage(publicErrorMessage(error, "无法发起刷新"));
    } finally {
      setActionBusy(false);
    }
  };

  const cancelCurrentExecution = async () => {
    if (actionBusy || scanExecutionId === undefined) return;
    setActionBusy(true);
    setScanError(undefined);
    setMessage("正在请求取消…");
    try {
      const result = await createPublicApiClient({ baseUrl }).cancelExecution(
        scanExecutionId,
      );
      setCancelRequestStatus(result.requestStatus);
      setExecutionInspection(result.inspection);
      setMessage(
        result.requestStatus === "requested"
          ? "取消请求已提交，仍在等待实际结局"
          : "执行已结束，显示持久化结局",
      );
      if (result.inspection.kind === "asset-library-scan") {
        setRefreshKind("library-scan");
        const scan = await createPublicApiClient({
          baseUrl,
        }).inspectAssetLibraryScan(scanExecutionId);
        setScanResult(scan);
      } else {
        setScanResult(undefined);
        setRefreshKind(
          result.inspection.operationKind === "rescrape"
            ? "rescrape"
            : result.inspection.operationKind === "refresh-metadata"
              ? "metadata-refresh"
              : "unknown",
        );
      }
    } catch (error) {
      setScanError(publicErrorMessage(error, "取消请求失败；执行状态仍需检查"));
      setMessage("取消请求失败，执行仍可能继续");
    } finally {
      setActionBusy(false);
    }
  };

  const rows: readonly Row[] = page.items;
  const narrow = terminalSize.columns < 40;
  const filteredRows =
    filterText.length === 0
      ? rows
      : rows.filter((row) =>
          rowSearchText(row, mode)
            .toLocaleLowerCase()
            .includes(filterText.toLocaleLowerCase()),
        );
  const rowViewportHeight = Math.max(
    1,
    terminalSize.rows - (filterEditing || filterText.length > 0 ? 8 : 7),
  );
  const viewportStart = Math.min(
    Math.max(0, selected - rowViewportHeight + 1),
    Math.max(0, filteredRows.length - rowViewportHeight),
  );
  const visibleRows = filteredRows.slice(
    viewportStart,
    viewportStart + rowViewportHeight,
  );

  useInput((input, key) => {
    if (mode === "connections" || mode === "automation") return;
    if (editor !== undefined) {
      if (key.escape) {
        setEditor(undefined);
        setMessage("已取消资产库编辑");
        return;
      }
      if (editor.stage === "profiles" || editor.stage === "sources") {
        const options =
          editor.stage === "profiles"
            ? (libraryOptions?.recognitionProfiles ?? [])
            : (libraryOptions?.sources ?? []);
        if (key.upArrow || input === "k") {
          setEditor({
            ...editor,
            selectedChoice: Math.max(0, editor.selectedChoice - 1),
            error: undefined,
          });
          return;
        }
        if (key.downArrow || input === "j") {
          setEditor({
            ...editor,
            selectedChoice: Math.min(
              Math.max(0, options.length - 1),
              editor.selectedChoice + 1,
            ),
            error: undefined,
          });
          return;
        }
        if (input === " ") {
          const option = options[editor.selectedChoice];
          if (option === undefined) return;
          const values =
            editor.stage === "profiles"
              ? editor.recognitionProfileIds
              : editor.sourceIdentities;
          const updated = values.includes(option.id)
            ? values.filter((value) => value !== option.id)
            : [...values, option.id];
          setEditor({
            ...editor,
            ...(editor.stage === "profiles"
              ? { recognitionProfileIds: updated }
              : { sourceIdentities: updated }),
            error: undefined,
          });
          return;
        }
        if (input === "b") {
          setEditor({
            ...editor,
            stage: editor.stage === "sources" ? "profiles" : "directories",
            selectedChoice: 0,
            input: "",
            error: undefined,
          });
          return;
        }
        if (key.return) {
          if (editor.stage === "profiles")
            setEditor({
              ...editor,
              stage: "sources",
              selectedChoice: 0,
              error: undefined,
            });
          else void saveEditor(editor);
        }
        return;
      }
      if (input === "b" && editor.stage === "directories") {
        setEditor({
          ...editor,
          stage: "name",
          input: editor.displayName,
          error: undefined,
        });
        return;
      }
      if (key.ctrl && input.toLowerCase() === "u") {
        setEditor({ ...editor, input: "", error: undefined });
        return;
      }
      if (key.backspace || key.delete) {
        setEditor({
          ...editor,
          input: Array.from(editor.input).slice(0, -1).join(""),
          error: undefined,
        });
        return;
      }
      if (key.return) {
        const value = editor.input.trim();
        if (editor.stage === "name") {
          if (value.length === 0) {
            setEditor({ ...editor, error: "请填写资产库名称" });
            return;
          }
          setEditor({
            ...editor,
            stage: "directories",
            displayName: value,
            input: "",
            error: undefined,
          });
          return;
        }
        if (editor.stage === "directories") {
          if (value.length === 0) {
            if (editor.directories.length === 0) {
              setEditor({ ...editor, error: "至少添加一个服务端目录" });
              return;
            }
            setEditor({
              ...editor,
              stage: "profiles",
              selectedChoice: 0,
              input: "",
              error: undefined,
            });
            return;
          }
          if (value.startsWith("-")) {
            const removePath = value.slice(1).trim();
            if (!editor.directories.includes(removePath)) {
              setEditor({ ...editor, input: "", error: "没有这条服务端目录" });
              return;
            }
            setEditor({
              ...editor,
              directories: editor.directories.filter(
                (item) => item !== removePath,
              ),
              input: "",
              error: undefined,
            });
            return;
          }
          if (editor.directories.includes(value)) {
            setEditor({ ...editor, input: "", error: "这条服务端目录已添加" });
            return;
          }
          setEditor({
            ...editor,
            directories: [...editor.directories, value],
            input: "",
            error: undefined,
          });
          return;
        }
      }
      if (input.length > 0 && !key.ctrl && !key.meta)
        setEditor({ ...editor, input: editor.input + input, error: undefined });
      return;
    }
    if (editorLoading || actionBusy) return;
    if (pendingRemoval !== undefined) {
      if (input.toLowerCase() === "y") void removeLibrary(pendingRemoval);
      else if (input.toLowerCase() === "n" || key.escape) {
        setPendingRemoval(undefined);
        setMessage("已取消移除");
      }
      return;
    }
    if (filterEditing) {
      if (key.return) {
        setFilterEditing(false);
        return;
      }
      if (key.escape) {
        setFilterEditing(false);
        setFilterText("");
        setSelected(0);
        return;
      }
      if (key.backspace || key.delete) {
        setFilterText((value) => Array.from(value).slice(0, -1).join(""));
        setSelected(0);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setFilterText((value) => value + input);
        setSelected(0);
      }
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    if (isInspectionMode(mode)) return;
    if (key.escape) {
      exit();
      return;
    }
    if (
      input === "1" ||
      input === "2" ||
      input === "3" ||
      input === "4" ||
      input === "5" ||
      input === "6" ||
      input === "7"
    ) {
      const nextMode: Mode =
        input === "1"
          ? "libraries"
          : input === "2"
            ? "assets"
            : input === "3"
              ? "unrecognized"
              : input === "4"
                ? "scan"
                : input === "5"
                  ? "attention"
                  : input === "6"
                    ? "history"
                    : "connections";
      if (
        nextMode === "scan" &&
        scanResult === undefined &&
        scanExecutionId === undefined
      )
        return;
      if (nextMode === "attention" || nextMode === "history")
        setWorkItemsReturnMode(mode);
      setMode(nextMode);
      setCursor(undefined);
      setPreviousCursors([]);
      setSelected(0);
      setFilterText("");
      setFilterEditing(false);
      return;
    }
    if (input === "/") {
      setFilterText("");
      setFilterEditing(true);
      setSelected(0);
      return;
    }
    if (input === "r") {
      if (mode === "scan") {
        setScanError(undefined);
        setScanReloadVersion((version) => version + 1);
      } else {
        setMessage("正在重新读取…");
        setReadFailed(false);
        setReloadVersion((version) => version + 1);
      }
      return;
    }
    if (mode === "scan" && input === "c") {
      void cancelCurrentExecution();
      return;
    }
    if (input === "l" && libraryId !== undefined) {
      setMode("libraries");
      setCursor(undefined);
      setPreviousCursors([]);
      setSelected(0);
      return;
    }
    if (mode === "libraries" && input === "c") {
      openLibraryEditor();
      return;
    }
    if (input === "n" && page.nextCursor !== undefined) {
      setPreviousCursors((values) => [...values, cursor]);
      setCursor(page.nextCursor);
      setSelected(0);
      setFilterText("");
      return;
    }
    if (input === "p" && previousCursors.length > 0) {
      setCursor(previousCursors.at(-1));
      setPreviousCursors((values) => values.slice(0, -1));
      setSelected(0);
      setFilterText("");
      return;
    }
    if ((key.downArrow || input === "j") && selected < filteredRows.length - 1)
      setSelected(selected + 1);
    if ((key.upArrow || input === "k") && selected > 0)
      setSelected(selected - 1);
    const selectedRow = filteredRows[selected];
    if (
      (input === "i" || key.return) &&
      mode === "assets" &&
      selectedRow !== undefined &&
      "descriptions" in selectedRow
    ) {
      setInspectionAssetId(selectedRow.id);
      setInspectionReturnMode("assets");
      setMode("inspection");
      return;
    }
    if (
      mode === "libraries" &&
      selectedRow !== undefined &&
      "displayName" in selectedRow
    ) {
      const library = selectedRow as PublicAssetLibrary;
      if (input === "e") {
        openLibraryEditor(library);
        return;
      }
      if (input === "d") {
        setPendingRemoval(library);
        setMessage(`确认移除「${library.displayName}」？按 y 确认，n 取消`);
        return;
      }
      if (input === "s") {
        void startLibraryScan(library);
        return;
      }
      if (input === "a") {
        setAutomationLibrary(library);
        setMode("automation");
        return;
      }
    }
    if (
      mode === "assets" &&
      selectedRow !== undefined &&
      "descriptions" in selectedRow
    ) {
      if (input === "x") {
        void startSubjectRefresh(selectedRow.id, "rescrape");
        return;
      }
      if (input === "m") {
        void startSubjectRefresh(selectedRow.id, "metadata-refresh");
        return;
      }
    }
    if (key.return && mode === "libraries" && selectedRow !== undefined) {
      const library = selectedRow as PublicAssetLibrary;
      setLibraryId(library.id);
      setLibraryName(library.displayName);
      setMode("assets");
      setCursor(undefined);
      setPreviousCursors([]);
      setSelected(0);
      setFilterText("");
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Text color="cyan" bold>
        数字资料库
      </Text>
      {mode === "automation" ? null : (
        <Text>
          {navigationLabel(narrow, terminalSize.columns, libraryName, mode)}
        </Text>
      )}
      {mode === "inspection" && inspectionAssetId !== undefined ? (
        <AssetInspectionPanel
          client={inspectionClient}
          assetId={inspectionAssetId}
          onBack={() => setMode(inspectionReturnMode)}
        />
      ) : null}
      {mode === "attention" || mode === "history" ? (
        <WorkItemsPanel
          client={inspectionClient}
          kind={mode === "attention" ? "attention" : "history"}
          onBack={() => setMode(workItemsReturnMode)}
          onOpenAsset={(assetId) => {
            setInspectionAssetId(assetId);
            setInspectionReturnMode(mode);
            setMode("inspection");
          }}
        />
      ) : null}
      {mode === "connections" ? (
        <SourceConnectionsPanel
          client={sourceConnectionClient}
          serviceUrl={baseUrl}
          onExit={() => setMode("libraries")}
        />
      ) : null}
      {mode === "automation" && automationLibrary !== undefined ? (
        <AutomationPanel
          client={inspectionClient}
          library={automationLibrary}
          onExit={() => {
            setAutomationLibrary(undefined);
            setMode("libraries");
            setReloadVersion((version) => version + 1);
          }}
        />
      ) : null}
      {mode === "libraries" && editor === undefined ? (
        <Text dimColor>
          {narrow
            ? "c新建 e修改 d移除 s扫描 a自动刷新 Enter资产"
            : "c 新建　e 修改　d 移除　s 扫描　a 自动刷新　Enter 查看资产"}
        </Text>
      ) : null}
      {mode === "assets" && editor === undefined ? (
        <Text dimColor>
          {narrow
            ? "x刮削 m元数据 i/Enter检查"
            : "x 重新刮削　m 元数据刷新　i / Enter 检查资料"}
        </Text>
      ) : null}
      {!isInspectionMode(mode) &&
      mode !== "connections" &&
      mode !== "automation" &&
      message.length > 0 ? (
        <Text color={readFailed || scanError !== undefined ? "red" : "gray"}>
          {message}
        </Text>
      ) : null}
      {!isInspectionMode(mode) && editorLoading ? (
        <Text>正在读取配置选项…</Text>
      ) : null}
      {editor !== undefined ? (
        <LibraryEditorView
          editor={editor}
          options={libraryOptions}
          narrow={narrow}
          columns={terminalSize.columns}
          saving={actionBusy}
        />
      ) : null}
      {!isInspectionMode(mode) && pendingRemoval !== undefined ? (
        <Text color="yellow">
          将移除「{pendingRemoval.displayName}」的配置；原素材不会被删除。
        </Text>
      ) : null}
      {!isInspectionMode(mode) && (filterEditing || filterText.length > 0) ? (
        <Text color="yellow">
          筛选本页：{truncateToWidth(filterText, terminalSize.columns - 12)}
          {filterEditing
            ? "（输入后回车，退格可修正）"
            : `（${filteredRows.length}/${rows.length}）`}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {mode === "scan" ? (
          <ScanResultView
            scan={scanResult}
            executionId={scanExecutionId}
            execution={executionInspection}
            refreshKind={refreshKind}
            error={scanError}
            message={message}
            cancelRequestStatus={cancelRequestStatus}
            narrow={narrow}
            columns={terminalSize.columns}
          />
        ) : null}
        {editor === undefined &&
        mode !== "scan" &&
        !isInspectionMode(mode) &&
        mode !== "connections" &&
        mode !== "automation"
          ? visibleRows.map((row, visibleIndex) => {
              const index = viewportStart + visibleIndex;
              return (
                <Text
                  key={rowKey(row)}
                  {...(index === selected ? { color: "green" } : {})}
                >
                  {index === selected ? "› " : "  "}
                  {truncateToWidth(
                    rowLabel(row, mode, narrow, filterText),
                    terminalSize.columns - 4,
                  )}
                </Text>
              );
            })
          : null}
        {editor === undefined &&
        mode !== "scan" &&
        !isInspectionMode(mode) &&
        mode !== "connections" &&
        mode !== "automation" &&
        rows.length > 0 &&
        filteredRows.length === 0 ? (
          <Text color="gray">当前页没有匹配内容</Text>
        ) : null}
        {editor === undefined &&
        mode !== "scan" &&
        !isInspectionMode(mode) &&
        mode !== "connections" &&
        mode !== "automation" &&
        rows.length === 0 &&
        message.length > 0 ? (
          <Text color={readFailed ? "red" : "gray"}>{message}</Text>
        ) : null}
      </Box>
      {isInspectionMode(mode) ? null : editor !== undefined ? (
        <Text dimColor>Esc 取消　b 返回　Ctrl+U 清空输入</Text>
      ) : mode === "connections" || mode === "automation" ? null : narrow ? (
        <>
          {mode === "scan" && scanExecutionId !== undefined ? (
            <Text dimColor>c请求取消　r重新查询　q退出</Text>
          ) : null}
          <Text dimColor>
            {page.nextCursor === undefined
              ? ""
              : previousCursors.length === 0
                ? "n下一页 "
                : "n/p翻页 "}
            {page.nextCursor === undefined && previousCursors.length > 0
              ? "p上一页 "
              : ""}
            ↑↓移动 r重读 q退出 /筛选
          </Text>
          <Text dimColor>
            {filteredRows.length > 0
              ? `第 ${viewportStart + 1}-${viewportStart + visibleRows.length}/${filteredRows.length} 项`
              : ""}
          </Text>
        </>
      ) : (
        <Text dimColor>
          {mode === "scan" && scanExecutionId !== undefined
            ? "c 请求取消　"
            : ""}
          {page.nextCursor === undefined ? "" : "n 下一页　"}
          {previousCursors.length === 0 ? "" : "p 上一页　"}↑↓/j k 移动　r
          重读　q 退出　/筛选本页　
          {filteredRows.length > 0
            ? `第 ${viewportStart + 1}-${viewportStart + visibleRows.length}/${filteredRows.length} 项`
            : ""}
        </Text>
      )}
    </Box>
  );
}

function navigationLabel(
  narrow: boolean,
  columns: number,
  libraryName: string | undefined,
  mode: Mode,
): string {
  const entries: readonly [Mode, string, string][] = narrow
    ? [
        ["libraries", "1", "库"],
        ["assets", "2", "资产"],
        ["unrecognized", "3", "未识别"],
        ["scan", "4", "扫描"],
        ["attention", "5", "待办"],
        ["history", "6", "历史"],
        ["connections", "7", "连接"],
      ]
    : [
        ["libraries", "1", "资产库"],
        ["assets", "2", "资产"],
        ["unrecognized", "3", "未识别材料"],
        ["scan", "4", "执行"],
        ["attention", "5", "待处理"],
        ["history", "6", "历史"],
        ["connections", "7", "来源连接"],
      ];
  const menu = entries
    .map(
      ([entryMode, number, label]) =>
        `${mode === entryMode ? "›" : ""}${number} ${label}`,
    )
    .join("　");
  if (libraryName === undefined) return menu;
  const separator = narrow ? "　" : "　当前库：";
  return `${menu}${separator}${truncateToWidth(
    libraryName,
    columns - terminalWidth(menu) - terminalWidth(separator),
  )}`;
}

function isInspectionMode(mode: Mode): boolean {
  return mode === "inspection" || mode === "attention" || mode === "history";
}

function LibraryEditorView({
  editor,
  options,
  narrow,
  columns,
  saving,
}: {
  readonly editor: LibraryEditor;
  readonly options: PublicAssetLibraryOptions | undefined;
  readonly narrow: boolean;
  readonly columns: number;
  readonly saving: boolean;
}) {
  const selectionStage =
    editor.stage === "profiles" || editor.stage === "sources";
  const choices =
    editor.stage === "profiles"
      ? (options?.recognitionProfiles ?? [])
      : editor.stage === "sources"
        ? (options?.sources ?? [])
        : [];
  const selectedIds =
    editor.stage === "profiles"
      ? editor.recognitionProfileIds
      : editor.sourceIdentities;
  const sectionLabel =
    editor.stage === "name"
      ? "资产库名称"
      : editor.stage === "directories"
        ? "服务端目录"
        : editor.stage === "profiles"
          ? "识别能力"
          : "来源";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>
        {editor.id === undefined ? "新建资产库" : "修改资产库"}：{sectionLabel}
      </Text>
      {editor.stage === "name" ? (
        <>
          <Text>名称：{truncateToWidth(editor.input, columns - 5)}</Text>
          <Text dimColor>输入名称后按 Enter。Ctrl+U 清空当前输入。</Text>
        </>
      ) : null}
      {editor.stage === "directories" ? (
        <>
          <Text>
            {narrow
              ? "服务端绝对路径；Enter 添加，-路径 移除。"
              : "目录由服务所在机器访问；输入绝对路径并按 Enter 添加，-路径 移除。"}
          </Text>
          {editor.directories.length === 0 ? (
            <Text dimColor>尚未添加目录</Text>
          ) : (
            editor.directories.map((directory) => (
              <Text key={directory}>
                · {truncateToWidth(directory, columns - 5)}
              </Text>
            ))
          )}
          <Text>路径输入：{truncateToWidth(editor.input, columns - 8)}</Text>
          <Text dimColor>空行继续；不会上传、修改或删除原素材。</Text>
        </>
      ) : null}
      {selectionStage ? (
        <>
          <Text dimColor>
            ↑↓ 移动　Space 选择　Enter 继续
            {editor.stage === "sources" ? "并保存" : ""}
          </Text>
          {choices.length === 0 ? (
            <Text color="yellow">服务没有提供可选{sectionLabel}</Text>
          ) : (
            choices.map((choice, index) => (
              <Text
                key={choice.id}
                {...(index === editor.selectedChoice ? { color: "green" } : {})}
              >
                {index === editor.selectedChoice ? "› " : "  "}
                {selectedIds.includes(choice.id) ? "[x] " : "[ ] "}
                {truncateToWidth(choice.displayName, columns - 12)}
              </Text>
            ))
          )}
        </>
      ) : null}
      {editor.error !== undefined ? (
        <Text color="red">{editor.error}</Text>
      ) : null}
      {saving ? <Text>正在保存…</Text> : null}
    </Box>
  );
}

function ScanResultView({
  scan,
  executionId,
  execution,
  refreshKind,
  error,
  message,
  cancelRequestStatus,
  narrow,
  columns,
}: {
  readonly scan: PublicAssetLibraryScan | undefined;
  readonly executionId: string | undefined;
  readonly execution: PublicExecutionInspection | undefined;
  readonly refreshKind: RefreshKind;
  readonly error: string | undefined;
  readonly message: string;
  readonly cancelRequestStatus: "requested" | "already-finished" | undefined;
  readonly narrow: boolean;
  readonly columns: number;
}) {
  if (execution?.kind === "execution")
    return (
      <Box flexDirection="column">
        <Text>刷新执行编号：{execution.id}</Text>
        <Text>
          状态：
          {executionResultStatusLabel(execution.status, execution.outcome)}
          {execution.status === "running"
            ? ` / ${executionStageLabel(execution.stage)}`
            : ""}
        </Text>
        {execution.reason === undefined ? null : (
          <Text>{execution.reason}</Text>
        )}
        {execution.cancellation === undefined ? null : (
          <Text>取消请求已记录：{execution.cancellation.requestedBy}</Text>
        )}
        {cancelRequestStatus === "requested" &&
        execution.status === "running" ? (
          <Text>取消请求已提交，仍在等待实际结局</Text>
        ) : null}
        {execution.progress.dispositions.map((disposition) => (
          <Text key={disposition.key}>
            处理项：
            {executionProgressStatusLabel(disposition.status)}
            {disposition.reason === undefined ? "" : `，${disposition.reason}`}
          </Text>
        ))}
        {execution.progress.workItems.map((item) => (
          <Text key={item.key}>
            {truncateToWidth(
              `${item.relativePaths.join("、")} → ${scanOutcomeLabel(item.outcome)}${item.acceptedAssetId === undefined ? "" : `，资产 ${item.acceptedAssetId}`}`,
              columns - (narrow ? 3 : 4),
            )}
          </Text>
        ))}
        {execution.sourceRefreshRuns.map((run) => {
          const line = `来源刷新 ${run.id}：${sourceRefreshStatusLabel(run.phase, run.outcome)}；变更集 ${
            run.changeSets
              .map(
                ({ id, disposition }) =>
                  `${id}（${changeSetDispositionLabel(disposition)}）`,
              )
              .join("、") || "尚无"
          }`;
          return (
            <Text key={run.id}>
              {truncateToWidth(line, columns - (narrow ? 3 : 4))}
            </Text>
          );
        })}
        {error !== undefined ? <Text color="red">{error}</Text> : null}
        {message.length > 0 ? <Text>{message}</Text> : null}
      </Box>
    );
  if (scan === undefined)
    return (
      <Box flexDirection="column">
        {executionId !== undefined ? (
          <>
            <Text>
              {refreshKind === "library-scan" ? "扫描" : "刷新"}执行编号：
            </Text>
            <Text>{executionId}</Text>
          </>
        ) : null}
        {error !== undefined ? <Text color="red">{error}</Text> : null}
        {message.length > 0 ? <Text>{message}</Text> : null}
        {executionId !== undefined ? (
          <Text dimColor>
            c 请求取消　r 重新查询；可用 --execution 指定编号恢复
          </Text>
        ) : null}
      </Box>
    );
  const fileItems = scan.directories.flatMap((directory) =>
    directory.files.map((file) => ({ directory, file })),
  );
  return (
    <Box flexDirection="column">
      <Text>扫描执行编号：</Text>
      <Text>{scan.parentExecutionId}</Text>
      <Text>
        结果：{executionResultStatusLabel(scan.status, scan.outcome)}
        {`；目录 ${scan.directories.length}，资料 ${fileItems.length}`}
      </Text>
      {execution?.kind === "asset-library-scan" ? (
        <>
          {execution.cancellationRequested === undefined ? null : (
            <Text>
              取消请求已记录：{execution.cancellationRequested.requestedBy}
              {execution.status === "running" ? "；仍在等待实际结局" : ""}
            </Text>
          )}
          {execution.children.map((child, index) => (
            <Text key={child.executionId}>
              子任务 {index + 1}：
              {child.status === "missing"
                ? "当前不可读取"
                : `${executionResultStatusLabel(child.execution.status, child.execution.outcome)}${child.execution.status === "running" ? ` / ${executionStageLabel(child.execution.stage)}` : ""}`}
            </Text>
          ))}
          {execution.children.flatMap((child) =>
            child.status === "available"
              ? child.execution.sourceRefreshRuns.map((run) => {
                  const line = `来源刷新 ${run.id}：${sourceRefreshStatusLabel(run.phase, run.outcome)}；变更集 ${
                    run.changeSets
                      .map(
                        ({ id, disposition }) =>
                          `${id}（${changeSetDispositionLabel(disposition)}）`,
                      )
                      .join("、") || "尚无"
                  }`;
                  return (
                    <Text key={run.id}>
                      {truncateToWidth(line, columns - (narrow ? 3 : 4))}
                    </Text>
                  );
                })
              : [],
          )}
        </>
      ) : null}
      {cancelRequestStatus === "requested" && scan.status === "running" ? (
        <Text>取消请求已提交，扫描父执行仍在等待实际结局</Text>
      ) : null}
      {scan.directories.map((directory, index) => (
        <Text key={`${directory.id}:${index}`}>
          {directory.displayName}：{scanDirectoryStageLabel(directory.stage)} /{" "}
          {scanDirectoryModeLabel(directory.mode)}，
          {`资料 ${directory.workItemCount}，待确认 ${directory.unresolvedCount}，失败 ${directory.failedCount}`}
          {directory.outcome === undefined
            ? ""
            : `，${scanOutcomeLabel(directory.outcome)}`}
          {directory.reason === undefined ? "" : `（${directory.reason}）`}
        </Text>
      ))}
      {fileItems.map(({ directory, file }, index) => (
        <Text key={`${directory.id}:${index}:${file.relativePaths.join("|")}`}>
          {truncateToWidth(
            `${file.relativePaths.join("、")} → ${scanOutcomeLabel(file.outcome)}${file.assetId === undefined ? "" : `，资产 ${file.assetId}`}`,
            columns - (narrow ? 3 : 4),
          )}
        </Text>
      ))}
      {fileItems.length === 0 ? <Text dimColor>没有可列出的资料项</Text> : null}
      {error !== undefined ? <Text color="red">{error}</Text> : null}
      {message.length > 0 ? <Text>{message}</Text> : null}
    </Box>
  );
}

function executionResultMessage(
  name: string,
  status: PublicExecutionInspection["status"],
  outcome: PublicExecutionInspection["outcome"] | undefined,
): string {
  if (outcome === "cancelled") return `${name}已取消`;
  if (outcome === "interrupted") return `${name}已中断`;
  if (status === "failed" || outcome === "failed") return `${name}失败`;
  return `${name}已完成${outcome === undefined ? "" : `：${scanOutcomeLabel(outcome)}`}`;
}

function executionResultStatusLabel(
  status: PublicExecutionInspection["status"],
  outcome: PublicExecutionInspection["outcome"] | undefined,
): string {
  if (status === "running") return "进行中";
  if (outcome === "cancelled") return "已取消";
  if (outcome === "interrupted") return "已中断";
  if (status === "failed" || outcome === "failed") return "失败";
  return `已完成${outcome === undefined ? "" : `，${scanOutcomeLabel(outcome)}`}`;
}

function executionProgressStatusLabel(
  status:
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "reused"
    | "no-change",
): string {
  switch (status) {
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "skipped":
      return "已跳过";
    case "reused":
      return "已复用";
    case "no-change":
      return "无变化";
  }
}

function executionStageLabel(
  stage:
    | "recognition"
    | "source-records-retained"
    | "source-artifacts-acquired"
    | "source-artifacts-stored"
    | "cover-acquired"
    | "cover-stored"
    | "completed"
    | "failed",
): string {
  switch (stage) {
    case "recognition":
      return "识别";
    case "source-records-retained":
      return "已保留来源记录";
    case "source-artifacts-acquired":
      return "正在获取来源资料";
    case "source-artifacts-stored":
      return "已保存来源资料";
    case "cover-acquired":
      return "已获取封面";
    case "cover-stored":
      return "已保存封面";
    case "completed":
      return "已结束";
    case "failed":
      return "失败";
  }
}

function sourceRefreshStatusLabel(
  phase: "planning" | "acquiring" | "reviewing" | "applying" | "terminal",
  outcome:
    | "succeeded"
    | "partially-succeeded"
    | "failed"
    | "cancelled"
    | undefined,
): string {
  if (outcome === "succeeded") return "已完成";
  if (outcome === "partially-succeeded") return "部分完成";
  if (outcome === "failed") return "失败";
  if (outcome === "cancelled") return "已取消";
  switch (phase) {
    case "planning":
      return "正在规划";
    case "acquiring":
      return "正在获取";
    case "reviewing":
      return "等待审阅";
    case "applying":
      return "正在应用";
    case "terminal":
      return "已结束";
  }
}

function changeSetDispositionLabel(
  disposition: "automatic" | "pending" | "approved" | "rejected",
): string {
  switch (disposition) {
    case "automatic":
      return "自动应用";
    case "pending":
      return "待审阅";
    case "approved":
      return "已批准";
    case "rejected":
      return "已拒绝";
  }
}

function scanDirectoryStageLabel(
  stage: PublicAssetLibraryScan["directories"][number]["stage"],
): string {
  switch (stage) {
    case "queued":
      return "等待扫描";
    case "running":
      return "扫描中";
    case "settled":
      return "已结束";
    case "cancelled":
      return "已取消";
    default:
      return "状态未知";
  }
}

function scanDirectoryModeLabel(
  mode: PublicAssetLibraryScan["directories"][number]["mode"],
): string {
  return mode === "execute"
    ? "独立扫描"
    : mode === "covered"
      ? "由父目录覆盖"
      : "状态未知";
}

function scanOutcomeLabel(
  outcome: PublicAssetLibraryScan["outcome"] | undefined,
): string {
  switch (outcome) {
    case "accepted":
      return "已识别";
    case "unresolved":
      return "未识别";
    case "proposal":
      return "待确认";
    case "partially-succeeded":
      return "部分完成";
    case "failed":
      return "失败";
    case "interrupted":
      return "已中断";
    case "cancelled":
      return "已取消";
    case "no-change":
      return "无变更";
    default:
      return "待查看";
  }
}

function publicErrorMessage(error: unknown, fallback: string): string {
  return error instanceof PublicApiClientError ||
    error instanceof PublicExecutionClientError
    ? error.message
    : fallback;
}

function truncateToWidth(value: string, maximumWidth: number): string {
  const limit = Math.max(1, maximumWidth);
  let width = 0;
  let result = "";
  for (const character of value) {
    const characterWidth = terminalWidth(character);
    if (width + characterWidth > limit) return `${result}…`;
    result += character;
    width += characterWidth;
  }
  return result;
}

function terminalWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    if (/\p{Mark}/u.test(character) || character === "\u200d") continue;
    width +=
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303f\uff01-\uff60]/u.test(
        character,
      )
        ? 2
        : 1;
  }
  return width;
}

function rowKey(row: Row): string {
  if ("displayName" in row) return row.id;
  if ("parentExecutionId" in row)
    return row.kind === "work-item"
      ? `${row.parentExecutionId}:${row.workItemKey}`
      : `${row.parentExecutionId}:${row.observationId}`;
  return row.id;
}

function rowLabel(
  row: Row,
  mode: Mode,
  narrow: boolean,
  filterText: string,
): string {
  if (mode === "libraries" && "displayName" in row) {
    const hasUnavailableDirectory = row.directories.some(
      ({ status, reachable }) => status === "active" && reachable === false,
    );
    return `${hasUnavailableDirectory ? "目录不可用 · " : ""}${row.displayName} (${row.directories.length} 个目录)`;
  }
  if (mode === "unrecognized" && "parentExecutionId" in row) {
    const matchingPaths = row.relativePaths.filter((relativePath) =>
      relativePath.toLocaleLowerCase().includes(filterText.toLocaleLowerCase()),
    );
    const paths = filterText.length > 0 ? matchingPaths : row.relativePaths;
    return narrow ? (paths[0] ?? "") : paths.join("、");
  }
  if ("descriptions" in row) {
    const title = row.descriptions
      .filter(
        (description) =>
          description.target.kind === "entity" &&
          description.target.entityId === row.id,
      )
      .flatMap((description) => description.metadata)
      .find(
        (metadata) =>
          metadata.property === "asset.title" &&
          metadata.result.status === "resolved",
      )?.result;
    const titleText =
      title?.status === "resolved" ? title.values[0]?.value : undefined;
    return (
      titleText ??
      row.relatedEntities.find((entity) => entity.id === row.id)?.label ??
      "未命名资产"
    );
  }
  return "未命名资料";
}

function rowSearchText(row: Row, mode: Mode): string {
  if (mode === "unrecognized" && "parentExecutionId" in row)
    return row.relativePaths.join("\n");
  return rowLabel(row, mode, false, "");
}

try {
  const arguments_ = process.argv.slice(2);
  const baseUrl = argumentUrl(arguments_);
  new URL(baseUrl);
  const initialExecutionId = argumentValue(arguments_, "--execution");
  if (arguments_.includes("--execution") && initialExecutionId === undefined)
    throw new Error("请在 --execution 后提供执行编号");
  render(
    <App
      baseUrl={baseUrl}
      {...(initialExecutionId === undefined ? {} : { initialExecutionId })}
    />,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "服务地址无效"}\n`,
  );
  process.exitCode = 2;
}
