import type {
  AssetEvidenceKind,
  AssetEvidencePage,
  AssetInspectionOverview,
  AssetSourceRecordChunk,
  CurrentAttentionPage,
  InspectionPageRequest,
  ListAssetEvidenceRequest,
  MetadataDecisionPreview,
  PublicChangeImpactPreview,
  PublicApiClient,
  PublicExecutionInspection,
  PublicSourceInputRequirement,
  SourceAssociationDecisionInspection,
  SourceEnrichmentInspection,
  WorkflowHistoryPage,
} from "@digital/public-api";
import { Box, Text, useInput, useStdout, type Key } from "ink";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const evidenceLabels: Record<AssetEvidenceKind, string> = {
  "local-observations": "本地观察",
  "format-results": "格式读取结果",
  "source-records": "来源记录",
  "interpreted-facts": "解释事实",
  "current-values": "当前采用值及依据",
  "metadata-decisions": "人工属性修订记录",
};

type InspectionClient = Pick<
  PublicApiClient,
  | "inspectAssetEvidence"
  | "listAssetEvidence"
  | "readAssetSourceRecord"
  | "listCurrentAttention"
  | "listWorkflowHistory"
  | "inspectExecution"
  | "prepareMetadataDecision"
  | "confirmMetadataDecision"
  | "cancelMetadataDecision"
  | "listSourceInputRequirements"
  | "startSourceEnrichment"
  | "inspectSourceEnrichment"
  | "listRetryableSourceEnrichments"
  | "retrySourceEnrichment"
  | "inspectSourceAssociationDecision"
  | "selectSourceAssociationCandidate"
  | "retrySourceAssociationDecision"
  | "confirmChangeImpactPreview"
  | "rejectChangeImpactPreview"
  | "reviewSourceRefreshChangeSet"
  | "inspectChangeImpactPreview"
>;

type AssetInspectionPanelProps = {
  readonly client: InspectionClient;
  readonly assetId: string;
  readonly onBack: () => void;
};

type WorkItemsPanelProps = {
  readonly client: InspectionClient;
  readonly kind: "attention" | "history";
  readonly onBack: () => void;
  readonly onOpenAsset?: ((assetId: string) => void) | undefined;
};

type CursorState = {
  readonly cursor?: string | undefined;
  readonly previous: readonly (string | undefined)[];
};

type MetadataDecisionInteraction =
  | {
      readonly kind: "input";
      readonly property: string;
      readonly metadataUsageContext: string;
      readonly value: string;
    }
  | {
      readonly kind: "candidates";
      readonly property: string;
      readonly metadataUsageContext: string;
      readonly candidates: readonly {
        readonly reference: string;
        readonly value: string;
        readonly sourceIdentity: string;
      }[];
      readonly selected: number;
    }
  | { readonly kind: "review"; readonly preview: MetadataDecisionPreview }
  | { readonly kind: "error"; readonly message: string };

type SourceEnrichmentInteraction =
  | { readonly kind: "loading" }
  | {
      readonly kind: "form";
      readonly requirements: readonly PublicSourceInputRequirement[];
      readonly selectedSource: number;
      readonly selectedField: number;
      readonly values: Readonly<Record<string, string>>;
      readonly error?: string | undefined;
    }
  | { readonly kind: "running"; readonly executionId: string }
  | {
      readonly kind: "result";
      readonly executionId: string;
      readonly inspection: SourceEnrichmentInspection;
    }
  | { readonly kind: "error"; readonly message: string };

export function AssetInspectionPanel({
  client,
  assetId,
  onBack,
}: AssetInspectionPanelProps) {
  const { stdout } = useStdout();
  const availableRows = Math.max(1, (stdout.rows ?? 24) - 8);
  const sourceChunkLimit = Math.max(
    40,
    Math.min(
      600,
      availableRows * Math.max(16, Math.floor((stdout.columns ?? 80) / 2)),
    ),
  );
  const [overview, setOverview] = useState<AssetInspectionOverview>();
  const [overviewError, setOverviewError] = useState<string>();
  const [sectionIndex, setSectionIndex] = useState(0);
  const [page, setPage] = useState<AssetEvidencePage>();
  const [pageError, setPageError] = useState<string>();
  const [pageCursor, setPageCursor] = useState<CursorState>({ previous: [] });
  const [selected, setSelected] = useState(0);
  const [sourceChunk, setSourceChunk] = useState<AssetSourceRecordChunk>();
  const [sourceOffsets, setSourceOffsets] = useState<readonly number[]>([]);
  const [sourceError, setSourceError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [decisionInteraction, setDecisionInteraction] =
    useState<MetadataDecisionInteraction>();
  const [sourceInteraction, setSourceInteraction] =
    useState<SourceEnrichmentInteraction>();

  useEffect(() => {
    let active = true;
    setOverview(undefined);
    setOverviewError(undefined);
    void client
      .inspectAssetEvidence(assetId)
      .then((result) => {
        if (active) setOverview(result);
      })
      .catch((error: unknown) => {
        if (active)
          setOverviewError(
            publicErrorMessage(error, "暂时无法读取这项资产的资料"),
          );
      });
    return () => {
      active = false;
    };
  }, [assetId, client, reloadVersion]);

  useEffect(() => {
    if (sourceInteraction?.kind !== "running") return;
    const executionId = sourceInteraction.executionId;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inspect = async () => {
      try {
        const inspection = await client.inspectSourceEnrichment(executionId);
        if (!active) return;
        if (inspection.status === "running") {
          timer = setTimeout(() => void inspect(), 500);
          return;
        }
        setSourceInteraction({ kind: "result", executionId, inspection });
        if (inspection.status === "completed")
          setReloadVersion((version) => version + 1);
      } catch (cause) {
        if (active)
          setSourceInteraction({
            kind: "error",
            message: publicErrorMessage(cause, "暂时无法读取来源补充结果"),
          });
      }
    };
    void inspect();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, sourceInteraction]);

  const selectedKind = overview?.sections[sectionIndex]?.kind;

  const loadEvidencePage = async (
    kind: AssetEvidenceKind,
    cursor: string | undefined,
  ) => {
    setBusy(true);
    setPageError(undefined);
    setSourceChunk(undefined);
    setSourceError(undefined);
    try {
      const request: ListAssetEvidenceRequest = {
        kind,
        limit: 24,
        ...(cursor === undefined ? {} : { cursor }),
      };
      setPage(await client.listAssetEvidence(assetId, request));
      setPageCursor((current) => ({ ...current, cursor }));
      setSelected(0);
    } catch (error) {
      setPage(undefined);
      setPageError(publicErrorMessage(error, "暂时无法读取这一层资料"));
    } finally {
      setBusy(false);
    }
  };

  const loadSourceChunk = async (recordId: string, offset: number) => {
    setBusy(true);
    setSourceError(undefined);
    try {
      setSourceChunk(
        await client.readAssetSourceRecord(assetId, recordId, {
          offset,
          limit: sourceChunkLimit,
        }),
      );
    } catch (error) {
      setSourceChunk(undefined);
      setSourceError(publicErrorMessage(error, "暂时无法读取这份来源资料"));
    } finally {
      setBusy(false);
    }
  };

  const evidenceItem = page?.items[selected];
  const sourceId =
    evidenceItem?.kind === "source-record" &&
    evidenceItem.status === "available"
      ? evidenceItem.id
      : undefined;

  const prepareDecision = async (
    request:
      | {
          readonly kind: "pin";
          readonly property: string;
          readonly metadataUsageContext: string;
          readonly value: string;
        }
      | {
          readonly kind: "adopt";
          readonly property: string;
          readonly metadataUsageContext: string;
          readonly candidateReference: string;
        }
      | {
          readonly kind: "clear";
          readonly property: string;
          readonly metadataUsageContext: string;
        },
  ) => {
    setBusy(true);
    setDecisionInteraction(undefined);
    try {
      const preview = await client.prepareMetadataDecision(assetId, request);
      setDecisionInteraction({ kind: "review", preview });
    } catch (error) {
      setDecisionInteraction({
        kind: "error",
        message: publicErrorMessage(error, "暂时无法形成修订预演"),
      });
    } finally {
      setBusy(false);
    }
  };

  const openSourceEnrichment = async () => {
    setSourceInteraction({ kind: "loading" });
    try {
      const requirements = await client.listSourceInputRequirements();
      if (requirements.length === 0) {
        setSourceInteraction({
          kind: "error",
          message: "服务没有提供可用于补充的来源",
        });
        return;
      }
      setSourceInteraction({
        kind: "form",
        requirements,
        selectedSource: 0,
        selectedField: 0,
        values: {},
      });
    } catch (cause) {
      setSourceInteraction({
        kind: "error",
        message: publicErrorMessage(cause, "暂时无法读取来源输入要求"),
      });
    }
  };

  const submitSourceEnrichment = async (
    form: Extract<SourceEnrichmentInteraction, { kind: "form" }>,
  ) => {
    const requirement = form.requirements[form.selectedSource];
    if (requirement === undefined) {
      setSourceInteraction({ kind: "error", message: "请选择一个来源" });
      return;
    }
    const missing = requirement.fields.find(
      (field) => field.required && !(form.values[field.key] ?? "").trim(),
    );
    if (missing !== undefined) {
      const fieldIndex = requirement.fields.findIndex(
        ({ key }) => key === missing.key,
      );
      setSourceInteraction({
        ...form,
        selectedField: Math.max(0, fieldIndex),
        error: `请填写${missing.label}`,
      });
      return;
    }
    setBusy(true);
    try {
      const started = await client.startSourceEnrichment({
        subjectId: assetId,
        sourceIdentity: requirement.sourceIdentity,
        sourceInput: Object.fromEntries(
          requirement.fields.flatMap(({ key }) => {
            const value = form.values[key]?.trim();
            return value === undefined || value.length === 0
              ? []
              : [[key, value]];
          }),
        ),
      });
      setSourceInteraction({ kind: "running", executionId: started.id });
    } catch (cause) {
      setSourceInteraction({
        kind: "error",
        message: publicErrorMessage(cause, "无法发起来源补充"),
      });
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (sourceInteraction !== undefined) {
      if (sourceInteraction.kind === "form") {
        const requirement =
          sourceInteraction.requirements[sourceInteraction.selectedSource];
        const fields = requirement?.fields ?? [];
        const field = fields[sourceInteraction.selectedField];
        if (key.escape) {
          setSourceInteraction(undefined);
          return;
        }
        if (key.leftArrow || key.rightArrow) {
          setSourceInteraction({
            ...sourceInteraction,
            selectedSource: Math.min(
              Math.max(
                0,
                sourceInteraction.selectedSource + (key.rightArrow ? 1 : -1),
              ),
              sourceInteraction.requirements.length - 1,
            ),
            selectedField: 0,
            values: {},
            error: undefined,
          });
          return;
        }
        if (key.tab && fields.length > 0) {
          setSourceInteraction({
            ...sourceInteraction,
            selectedField:
              (sourceInteraction.selectedField + 1) % fields.length,
            error: undefined,
          });
          return;
        }
        if (key.return) {
          if (sourceInteraction.selectedField < fields.length - 1) {
            setSourceInteraction({
              ...sourceInteraction,
              selectedField: sourceInteraction.selectedField + 1,
              error: undefined,
            });
          } else void submitSourceEnrichment(sourceInteraction);
          return;
        }
        if (key.ctrl && input.toLowerCase() === "u" && field !== undefined) {
          setSourceInteraction({
            ...sourceInteraction,
            values: { ...sourceInteraction.values, [field.key]: "" },
            error: undefined,
          });
          return;
        }
        if ((key.backspace || key.delete) && field !== undefined) {
          setSourceInteraction({
            ...sourceInteraction,
            values: {
              ...sourceInteraction.values,
              [field.key]: (sourceInteraction.values[field.key] ?? "").slice(
                0,
                -1,
              ),
            },
            error: undefined,
          });
          return;
        }
        if (input.length > 0 && !key.ctrl && !key.meta && field !== undefined)
          setSourceInteraction({
            ...sourceInteraction,
            values: {
              ...sourceInteraction.values,
              [field.key]: `${sourceInteraction.values[field.key] ?? ""}${input}`,
            },
            error: undefined,
          });
        return;
      }
      if (sourceInteraction.kind === "result" && input === "r") {
        if (sourceInteraction.inspection.status !== "failed") return;
        setBusy(true);
        void (async () => {
          try {
            const retryable =
              await client.listRetryableSourceEnrichments(assetId);
            const item = retryable.find(
              ({ executionId }) =>
                executionId === sourceInteraction.executionId,
            );
            if (item === undefined || !item.canRetry) {
              setSourceInteraction({
                kind: "error",
                message: "这项来源补充已不能重试，请重新发起补充",
              });
              return;
            }
            const retried = await client.retrySourceEnrichment({
              executionId: item.executionId,
              subjectId: item.subjectId,
              sourceIdentity: item.sourceIdentity,
            });
            setSourceInteraction({ kind: "running", executionId: retried.id });
          } catch (cause) {
            setSourceInteraction({
              kind: "error",
              message: publicErrorMessage(cause, "无法重试来源补充"),
            });
          } finally {
            setBusy(false);
          }
        })();
        return;
      }
      if (
        key.escape ||
        sourceInteraction.kind === "error" ||
        sourceInteraction.kind === "result"
      ) {
        setSourceInteraction(undefined);
      }
      return;
    }
    if (decisionInteraction?.kind === "input") {
      if (key.escape) {
        setDecisionInteraction(undefined);
        return;
      }
      if (key.return) {
        if (decisionInteraction.value.trim().length === 0) {
          setDecisionInteraction({ kind: "error", message: "请输入修订值" });
          return;
        }
        void prepareDecision({
          kind: "pin",
          property: decisionInteraction.property,
          metadataUsageContext: decisionInteraction.metadataUsageContext,
          value: decisionInteraction.value,
        });
        return;
      }
      if (key.backspace || key.delete) {
        setDecisionInteraction({
          ...decisionInteraction,
          value: decisionInteraction.value.slice(0, -1),
        });
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta)
        setDecisionInteraction({
          ...decisionInteraction,
          value: `${decisionInteraction.value}${input}`,
        });
      return;
    }
    if (decisionInteraction?.kind === "candidates") {
      if (key.escape) {
        setDecisionInteraction(undefined);
        return;
      }
      if (key.downArrow || input === "j") {
        setDecisionInteraction({
          ...decisionInteraction,
          selected: Math.min(
            decisionInteraction.selected + 1,
            decisionInteraction.candidates.length - 1,
          ),
        });
        return;
      }
      if (key.upArrow || input === "k") {
        setDecisionInteraction({
          ...decisionInteraction,
          selected: Math.max(decisionInteraction.selected - 1, 0),
        });
        return;
      }
      if (key.return) {
        const candidate =
          decisionInteraction.candidates[decisionInteraction.selected];
        if (candidate !== undefined)
          void prepareDecision({
            kind: "adopt",
            property: decisionInteraction.property,
            metadataUsageContext: decisionInteraction.metadataUsageContext,
            candidateReference: candidate.reference,
          });
        return;
      }
      return;
    }
    if (decisionInteraction?.kind === "review") {
      if (
        decisionInteraction.preview.status !== "awaiting-confirmation" &&
        (key.escape || key.return || input === "b")
      ) {
        setDecisionInteraction(undefined);
        return;
      }
      if (input === "y") {
        setBusy(true);
        void client
          .confirmMetadataDecision(decisionInteraction.preview.previewId)
          .then((preview) => {
            setDecisionInteraction({ kind: "review", preview });
            if (preview.status === "applied") {
              setReloadVersion((version) => version + 1);
              if (page !== undefined)
                void loadEvidencePage(page.kind, pageCursor.cursor);
            }
          })
          .catch((error: unknown) =>
            setDecisionInteraction({
              kind: "error",
              message: publicErrorMessage(
                error,
                "属性修订已过期，请重新检查资料",
              ),
            }),
          )
          .finally(() => setBusy(false));
        return;
      }
      if (input === "n" || key.escape) {
        setBusy(true);
        void client
          .cancelMetadataDecision(decisionInteraction.preview.previewId)
          .then((preview) =>
            setDecisionInteraction({ kind: "review", preview }),
          )
          .catch((error: unknown) =>
            setDecisionInteraction({
              kind: "error",
              message: publicErrorMessage(error, "暂时无法取消修订"),
            }),
          )
          .finally(() => setBusy(false));
        return;
      }
      return;
    }
    if (decisionInteraction?.kind === "error") {
      if (key.escape || key.return) setDecisionInteraction(undefined);
      return;
    }
    if (key.escape || input === "b") {
      if (sourceChunk !== undefined || sourceError !== undefined) {
        setSourceChunk(undefined);
        setSourceError(undefined);
        setSourceOffsets([]);
      } else if (page !== undefined || pageError !== undefined) {
        setPage(undefined);
        setPageError(undefined);
        setPageCursor({ previous: [] });
        setSourceChunk(undefined);
      } else onBack();
      return;
    }
    if (busy) return;
    if (sourceId !== undefined && (input === " " || input === "n")) {
      if (sourceChunk !== undefined && !sourceChunk.complete) {
        setSourceOffsets((offsets) => [...offsets, sourceChunk.offset]);
        void loadSourceChunk(sourceId, sourceChunk.nextOffset);
      } else if (sourceChunk === undefined) {
        setSourceOffsets([]);
        void loadSourceChunk(sourceId, 0);
      }
      return;
    }
    if (
      sourceChunk !== undefined &&
      input === "p" &&
      sourceOffsets.length > 0
    ) {
      const previous = sourceOffsets.at(-1);
      if (previous !== undefined) {
        setSourceOffsets((offsets) => offsets.slice(0, -1));
        void loadSourceChunk(sourceChunk.record.id, previous);
      }
      return;
    }
    if (page !== undefined && input === "n" && page.nextCursor !== undefined) {
      setPageCursor((current) => ({
        cursor: page.nextCursor,
        previous: [...current.previous, current.cursor],
      }));
      void loadEvidencePage(page.kind, page.nextCursor);
      return;
    }
    if (page !== undefined && input === "p" && pageCursor.previous.length > 0) {
      const cursor = pageCursor.previous.at(-1);
      setPageCursor({
        cursor,
        previous: pageCursor.previous.slice(0, -1),
      });
      void loadEvidencePage(page.kind, cursor);
      return;
    }
    if (page !== undefined && key.return && sourceId !== undefined) {
      setSourceOffsets([]);
      void loadSourceChunk(sourceId, 0);
      return;
    }
    if (page !== undefined) {
      if ((key.downArrow || input === "j") && selected < page.items.length - 1)
        setSelected(selected + 1);
      if ((key.upArrow || input === "k") && selected > 0)
        setSelected(selected - 1);
      if (
        evidenceItem?.kind === "current-value" &&
        evidenceItem.target.kind === "entity" &&
        evidenceItem.target.entityId === assetId
      ) {
        const coordinate = {
          property: evidenceItem.evidence.property,
          metadataUsageContext: "asset.ordinary",
        };
        if (input === "m")
          setDecisionInteraction({ kind: "input", ...coordinate, value: "" });
        if (input === "x")
          void prepareDecision({ kind: "clear", ...coordinate });
        if (
          input === "a" &&
          evidenceItem.evidence.result.status === "conflict"
        ) {
          const candidates = evidenceItem.evidence.result.candidates.flatMap(
            (candidate) =>
              candidate.reference === undefined
                ? []
                : [
                    {
                      reference: candidate.reference,
                      value: candidate.value,
                      sourceIdentity: candidate.sourceIdentity,
                    },
                  ],
          );
          setDecisionInteraction(
            candidates.length === 0
              ? { kind: "error", message: "当前冲突没有可采纳的来源候选" }
              : {
                  kind: "candidates",
                  ...coordinate,
                  candidates,
                  selected: 0,
                },
          );
        }
      }
      return;
    }
    if (overview !== undefined) {
      if (
        (key.downArrow || input === "j") &&
        sectionIndex < overview.sections.length - 1
      )
        setSectionIndex(sectionIndex + 1);
      if ((key.upArrow || input === "k") && sectionIndex > 0)
        setSectionIndex(sectionIndex - 1);
      if (key.return && selectedKind !== undefined) {
        setPageCursor({ previous: [] });
        void loadEvidencePage(selectedKind, undefined);
      }
      if (input === "r") setReloadVersion((version) => version + 1);
      if (input === "e") void openSourceEnrichment();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>资产资料检查</Text>
      <Text>用 ↑/↓ 选择，Enter 查看，Esc 返回</Text>
      {overviewError !== undefined ? (
        <Text color="red">{overviewError}（按 r 重试）</Text>
      ) : overview === undefined ? (
        <Text>正在读取资料…</Text>
      ) : page !== undefined || pageError !== undefined ? (
        <>
          <EvidenceView
            page={page}
            error={pageError}
            selected={selected}
            sourceChunk={sourceChunk}
            sourceError={sourceError}
            busy={busy}
            pageWindowSize={availableRows}
          />
          <MetadataDecisionPrompt interaction={decisionInteraction} />
        </>
      ) : (
        <Box flexDirection="column">
          {overview.sections.map((section, index) => (
            <Text key={section.kind}>
              {index === sectionIndex ? "› " : "  "}
              {evidenceLabels[section.kind]}：
              {section.status === "missing"
                ? "暂无资料"
                : `${section.count} 项`}
            </Text>
          ))}
        </Box>
      )}
      <SourceEnrichmentPrompt interaction={sourceInteraction} />
      <Text dimColor>
        {sourceInteraction?.kind === "form"
          ? "←/→ 选择来源 · Tab 切换字段 · Enter 继续或提交 · Esc 返回"
          : sourceInteraction?.kind === "result" &&
              sourceInteraction.inspection.status === "failed"
            ? "r 重试来源补充 · Esc 返回"
            : sourceInteraction !== undefined
              ? "Esc 返回"
              : sourceChunk === undefined
                ? page === undefined
                  ? "e 补充来源 · b 返回"
                  : `${evidenceItem?.kind === "current-value" && evidenceItem.target.kind === "entity" && evidenceItem.target.entityId === assetId ? "m 修订 · x 撤回 · a 采纳冲突候选 · " : ""}${page.nextCursor === undefined ? "" : "n 下一页 · "}${sourceId === undefined ? "" : "Enter 展开来源 · "}${pageCursor.previous.length === 0 ? "" : "p 上一页 · "}b 返回`
                : `来源资料 ${sourceChunk.offset + 1}–${sourceChunk.nextOffset} 字符`}
      </Text>
      {sourceChunk !== undefined && (
        <Text dimColor>
          {sourceChunk.complete ? "已到末尾" : "空格 / n 继续"}
          {sourceOffsets.length > 0 ? " · p 上一段" : ""}
        </Text>
      )}
    </Box>
  );
}

function SourceEnrichmentPrompt({
  interaction,
}: {
  readonly interaction: SourceEnrichmentInteraction | undefined;
}) {
  if (interaction === undefined) return null;
  if (interaction.kind === "loading") return <Text>正在读取来源输入要求…</Text>;
  if (interaction.kind === "error")
    return <Text color="red">{interaction.message}</Text>;
  if (interaction.kind === "running")
    return (
      <Box flexDirection="column">
        <Text>正在补充来源，请稍候…</Text>
      </Box>
    );
  if (interaction.kind === "form") {
    const requirement = interaction.requirements[interaction.selectedSource];
    if (requirement === undefined) return null;
    const field = requirement.fields[interaction.selectedField];
    return (
      <Box flexDirection="column">
        <Text bold>补充来源：{requirement.displayName}</Text>
        {requirement.fields.map((item, index) => (
          <Text key={item.key}>
            {index === interaction.selectedField ? "› " : "  "}
            {item.label}
            {item.required ? "（必填）" : ""}：
            {interaction.values[item.key] ?? ""}
            {item.example === undefined ? "" : ` · 示例 ${item.example}`}
          </Text>
        ))}
        {field === undefined ? null : (
          <Text dimColor>
            正在填写：{field.label} · {field.acceptedInput}
          </Text>
        )}
        {interaction.error === undefined ? null : (
          <Text color="red">{interaction.error}</Text>
        )}
        {interaction.requirements.length > 1 ? (
          <Text>
            来源 {interaction.selectedSource + 1}/
            {interaction.requirements.length} · ←/→ 切换
          </Text>
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>
        来源补充 · {sourceEnrichmentStatusLabel(interaction.inspection.status)}
      </Text>
      {interaction.inspection.reason === undefined ? null : (
        <Text color="yellow">{interaction.inspection.reason}</Text>
      )}
      {interaction.inspection.items.map((item, index) => (
        <Box key={`${item.sourceIdentity}:${index}`} flexDirection="column">
          <Text>
            {item.sourceIdentity} ·{" "}
            {item.input === undefined
              ? "未显示输入"
              : Object.entries(item.input)
                  .map(([key, value]) => `${key} ${value}`)
                  .join("，")}
            {" · "}
            {sourceEnrichmentStatusLabel(item.status)}
          </Text>
        </Box>
      ))}
      {interaction.inspection.sourceAssociations.map((association, index) => (
        <Text key={`${association.sourceIdentity}:${index}`}>
          已关联：{association.sourceIdentity} · {association.nativeAddress}
        </Text>
      ))}
      {interaction.inspection.status === "failed" &&
      interaction.inspection.items.some(({ canRetry }) => canRetry) ? (
        <Text>可按 r 再次获取当前失败项</Text>
      ) : null}
    </Box>
  );
}

function sourceEnrichmentStatusLabel(
  status: SourceEnrichmentInspection["status"],
): string {
  switch (status) {
    case "running":
      return "进行中";
    case "failed":
      return "未完成";
    case "completed":
      return "已完成";
  }
}

function MetadataDecisionPrompt({
  interaction,
}: {
  readonly interaction: MetadataDecisionInteraction | undefined;
}) {
  if (interaction === undefined) return null;
  if (interaction.kind === "input")
    return (
      <Text color="yellow">
        {interaction.property} 新值：{interaction.value} · Enter 预演 · Esc 取消
      </Text>
    );
  if (interaction.kind === "candidates")
    return (
      <Box flexDirection="column">
        <Text>选择要固定的冲突值 · ↑/↓ 选择 · Enter 预演 · Esc 返回</Text>
        {interaction.candidates.map((candidate, index) => (
          <Text key={candidate.reference}>
            {index === interaction.selected ? "› " : "  "}
            {candidate.value} · {candidate.sourceIdentity}
          </Text>
        ))}
      </Box>
    );
  if (interaction.kind === "error")
    return <Text color="red">{interaction.message} · Enter 继续</Text>;
  const preview = interaction.preview;
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        {preview.property}：
        {preview.kind === "clear" ? "撤回修订" : preview.value}
        {preview.status === "awaiting-confirmation"
          ? ` · ${preview.impact} · y 确认 · n 取消`
          : ` · ${decisionStatusLabel(preview.status)}`}
      </Text>
      {preview.blockingConditions.map((condition, index) => (
        <Text key={`${condition}:${index}`} color="yellow">
          {condition}
        </Text>
      ))}
    </Box>
  );
}

function decisionStatusLabel(
  status: MetadataDecisionPreview["status"],
): string {
  switch (status) {
    case "applied":
      return "已确认";
    case "stale":
      return "预演已过期，没有修改资料";
    case "rejected":
      return "已取消，没有修改资料";
    default:
      return "等待确认";
  }
}

export function WorkItemsPanel({
  client,
  kind,
  onBack,
  onOpenAsset,
}: WorkItemsPanelProps) {
  const { stdout } = useStdout();
  const pageWindowSize = Math.max(1, (stdout.rows ?? 24) - 6);
  const [page, setPage] = useState<
    CurrentAttentionPage | WorkflowHistoryPage
  >();
  const [cursor, setCursor] = useState<CursorState>({ previous: [] });
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [busy, setBusy] = useState(false);
  const [executionDetail, setExecutionDetail] = useState<{
    readonly id: string;
    readonly inspection: PublicExecutionInspection;
  }>();
  const [executionDetailError, setExecutionDetailError] = useState<string>();
  const [changePreview, setChangePreview] =
    useState<PublicChangeImpactPreview>();
  const [sourceDecision, setSourceDecision] =
    useState<SourceAssociationDecisionInspection>();
  const [actionMessage, setActionMessage] = useState<string>();

  const loadPage = async (
    nextCursor: string | undefined,
    preserveReviewResult = false,
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      const request: InspectionPageRequest = {
        limit: 24,
        ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      };
      const result =
        kind === "attention"
          ? await client.listCurrentAttention(request)
          : await client.listWorkflowHistory(request);
      setPage(result);
      setCursor((current) => ({ ...current, cursor: nextCursor }));
      setSelected(0);
      setExecutionDetail(undefined);
      setExecutionDetailError(undefined);
      if (!preserveReviewResult) {
        setChangePreview(undefined);
        setSourceDecision(undefined);
        setActionMessage(undefined);
      }
    } catch (cause) {
      setPage(undefined);
      setError(
        publicErrorMessage(
          cause,
          kind === "attention"
            ? "暂时无法读取待处理事项"
            : "暂时无法读取工作流历史",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const reviewSelectedAttention = async (
    disposition: "approved" | "rejected",
  ) => {
    if (kind !== "attention" || page === undefined || busy) return;
    const item = (page as CurrentAttentionPage).items[selected];
    if (item === undefined) return;
    const reviewedDecision = sourceDecision;
    setBusy(true);
    setActionMessage(undefined);
    try {
      if (item.kind === "change-impact-review") {
        if (item.changeImpactPreviewId === undefined)
          throw new Error("当前事项没有关联变更预演");
        const preview =
          disposition === "approved"
            ? await client.confirmChangeImpactPreview(
                item.changeImpactPreviewId,
                "tui-user",
              )
            : await client.rejectChangeImpactPreview(
                item.changeImpactPreviewId,
                "tui-user",
              );
        setChangePreview(preview);
        setActionMessage(
          preview.status === "applied"
            ? "变更已确认"
            : preview.status === "rejected"
              ? "已拒绝，资料没有改变"
              : preview.status === "stale"
                ? "预演已过期，资料没有改变"
                : "变更仍待确认",
        );
      } else if (item.kind === "source-refresh-review") {
        if (
          item.executionId === undefined ||
          item.sourceRefreshChangeSetId === undefined
        )
          throw new Error("当前事项缺少来源更新坐标");
        const execution = await client.inspectExecution(item.executionId);
        if (execution.kind !== "execution")
          throw new Error("当前来源更新没有可审核的执行结果");
        const run = execution.sourceRefreshRuns.find((candidate) =>
          candidate.changeSets.some(
            ({ id }) => id === item.sourceRefreshChangeSetId,
          ),
        );
        if (run === undefined) throw new Error("没有找到待审核的来源刷新记录");
        const reviewed = await client.reviewSourceRefreshChangeSet(run.id, {
          changeSetId: item.sourceRefreshChangeSetId,
          disposition,
        });
        const changeSet = reviewed.changeSets.find(
          ({ id }) => id === item.sourceRefreshChangeSetId,
        );
        setActionMessage(
          changeSet?.disposition === "approved"
            ? "来源更新已批准并按当前依据应用"
            : changeSet?.disposition === "rejected"
              ? "来源更新已拒绝，当前资料保持不变"
              : "来源更新审核已提交",
        );
      } else if (
        item.kind === "recognition-review" &&
        reviewedDecision !== undefined &&
        reviewedDecision.executionId === item.executionId &&
        reviewedDecision.preview !== undefined
      ) {
        const preview =
          disposition === "approved"
            ? await client.confirmChangeImpactPreview(
                reviewedDecision.preview.previewId,
                "tui-user",
              )
            : await client.rejectChangeImpactPreview(
                reviewedDecision.preview.previewId,
                "tui-user",
              );
        setChangePreview(preview);
        setActionMessage(
          preview.status === "applied"
            ? "来源关联已确认"
            : preview.status === "rejected"
              ? "已拒绝来源关联，当前资料保持不变"
              : preview.status === "stale"
                ? "来源关联预演已过期，当前资料保持不变"
                : "来源关联仍待确认",
        );
      } else {
        throw new Error("请先查看来源候选，并完成候选选择或重新判断");
      }
      await loadPage(cursor.cursor, true);
    } catch (cause) {
      setActionMessage(publicErrorMessage(cause, "无法处理这项待处理事项"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void loadPage(undefined);
  }, [kind, client]);

  const selectedExecutionId =
    page === undefined
      ? undefined
      : kind === "attention"
        ? (page as CurrentAttentionPage).items[selected]?.executionId
        : (page as WorkflowHistoryPage).items[selected]?.execution.id;
  const loadSourceDecision = async (executionId: string) => {
    setBusy(true);
    setSourceDecision(undefined);
    setExecutionDetail(undefined);
    setExecutionDetailError(undefined);
    try {
      setSourceDecision(
        await client.inspectSourceAssociationDecision(executionId),
      );
      setSelectedCandidate(0);
    } catch {
      try {
        const inspection = await client.inspectExecution(executionId);
        setExecutionDetail({ id: executionId, inspection });
      } catch (cause) {
        setExecutionDetailError(
          publicErrorMessage(cause, "暂时无法读取执行详情"),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const selectSourceCandidate = async () => {
    if (sourceDecision === undefined || busy) return;
    const candidate = sourceDecision.candidates[selectedCandidate];
    if (candidate === undefined) return;
    setBusy(true);
    setActionMessage(undefined);
    try {
      const updated = await client.selectSourceAssociationCandidate(
        sourceDecision.executionId,
        candidate.reference,
      );
      setSourceDecision(updated);
      setChangePreview(
        updated.preview === undefined
          ? undefined
          : await client.inspectChangeImpactPreview(updated.preview.previewId),
      );
      setActionMessage(
        updated.preview === undefined
          ? "已选择来源候选"
          : "已选择来源候选，请检查变更影响后确认",
      );
    } catch (cause) {
      setActionMessage(publicErrorMessage(cause, "无法选择这项来源候选"));
    } finally {
      setBusy(false);
    }
  };

  const retrySourceDecision = async () => {
    if (selectedExecutionId === undefined || busy) return;
    setBusy(true);
    setActionMessage(undefined);
    try {
      const decision =
        sourceDecision?.executionId === selectedExecutionId
          ? sourceDecision
          : await client.inspectSourceAssociationDecision(selectedExecutionId);
      if (!decision.availableActions.includes("retry")) {
        setSourceDecision(decision);
        setActionMessage("这项来源关联当前不能重新判断");
        return;
      }
      const retried =
        await client.retrySourceAssociationDecision(selectedExecutionId);
      setSourceDecision(retried);
      setActionMessage("已重新判断来源关联，请检查返回结果");
    } catch (cause) {
      setActionMessage(publicErrorMessage(cause, "无法重新判断来源关联"));
    } finally {
      setBusy(false);
    }
  };

  const inputHandlerRef = useRef<(input: string, key: Key) => void>(() => {});
  const handleInput = (input: string, key: Key): void => {
    if (key.escape || input === "b") {
      if (
        executionDetail !== undefined ||
        executionDetailError !== undefined ||
        sourceDecision !== undefined ||
        changePreview !== undefined
      ) {
        setExecutionDetail(undefined);
        setExecutionDetailError(undefined);
        setSourceDecision(undefined);
        setChangePreview(undefined);
        setActionMessage(undefined);
      } else onBack();
      return;
    }
    if (busy) return;
    if (kind === "attention" && input === "a") {
      void reviewSelectedAttention("approved");
      return;
    }
    if (kind === "attention" && input === "x") {
      void reviewSelectedAttention("rejected");
      return;
    }
    if (
      sourceDecision?.state === "awaiting-selection" &&
      sourceDecision.candidates.length > 0 &&
      (key.downArrow || input === "j")
    ) {
      setSelectedCandidate(
        Math.min(selectedCandidate + 1, sourceDecision.candidates.length - 1),
      );
      return;
    }
    if (
      sourceDecision?.state === "awaiting-selection" &&
      sourceDecision.candidates.length > 0 &&
      (key.upArrow || input === "k")
    ) {
      setSelectedCandidate(Math.max(0, selectedCandidate - 1));
      return;
    }
    if (
      kind === "attention" &&
      input === "s" &&
      sourceDecision?.availableActions.includes("select")
    ) {
      void selectSourceCandidate();
      return;
    }
    if (
      kind === "attention" &&
      input === "r" &&
      (page as CurrentAttentionPage | undefined)?.items[selected]?.kind ===
        "recognition-review"
    ) {
      void retrySourceDecision();
      return;
    }
    if (input === "v") {
      if (kind === "attention") {
        const item = (page as CurrentAttentionPage | undefined)?.items[
          selected
        ];
        if (
          item?.kind === "change-impact-review" &&
          item.changeImpactPreviewId !== undefined
        ) {
          setBusy(true);
          setChangePreview(undefined);
          setExecutionDetailError(undefined);
          void client
            .inspectChangeImpactPreview(item.changeImpactPreviewId)
            .then(setChangePreview)
            .catch((cause: unknown) =>
              setExecutionDetailError(
                publicErrorMessage(cause, "暂时无法读取变更预演"),
              ),
            )
            .finally(() => setBusy(false));
          return;
        }
        if (
          item?.kind === "recognition-review" &&
          item.executionId !== undefined
        ) {
          void loadSourceDecision(item.executionId);
          return;
        }
      }
      if (selectedExecutionId === undefined) {
        setExecutionDetail(undefined);
        setExecutionDetailError("当前事项没有关联的执行记录");
        return;
      }
      setBusy(true);
      setExecutionDetail(undefined);
      setExecutionDetailError(undefined);
      setChangePreview(undefined);
      void client
        .inspectExecution(selectedExecutionId)
        .then((inspection) =>
          setExecutionDetail({
            id: selectedExecutionId,
            inspection,
          }),
        )
        .catch((cause: unknown) =>
          setExecutionDetailError(
            publicErrorMessage(cause, "暂时无法读取执行详情"),
          ),
        )
        .finally(() => setBusy(false));
      return;
    }
    if (input === "r") {
      void loadPage(cursor.cursor);
      return;
    }
    if (key.return && onOpenAsset !== undefined && page !== undefined) {
      const assetId =
        kind === "attention"
          ? (page as CurrentAttentionPage).items[selected]?.assetId
          : (page as WorkflowHistoryPage).items[selected]?.resultReferences
              .acceptedAssetIds[0];
      if (assetId !== undefined) onOpenAsset(assetId);
      return;
    }
    if (page !== undefined && input === "n" && page.nextCursor !== undefined) {
      setCursor((current) => ({
        cursor: page.nextCursor,
        previous: [...current.previous, current.cursor],
      }));
      void loadPage(page.nextCursor);
      return;
    }
    if (page !== undefined && input === "p" && cursor.previous.length > 0) {
      const previous = cursor.previous.at(-1);
      setCursor({ cursor: previous, previous: cursor.previous.slice(0, -1) });
      void loadPage(previous);
      return;
    }
    const rows = page?.items ?? [];
    if ((key.downArrow || input === "j") && selected < rows.length - 1) {
      setSelected(selected + 1);
      setExecutionDetail(undefined);
      setExecutionDetailError(undefined);
      setChangePreview(undefined);
      setSourceDecision(undefined);
      setActionMessage(undefined);
    }
    if ((key.upArrow || input === "k") && selected > 0) {
      setSelected(selected - 1);
      setExecutionDetail(undefined);
      setExecutionDetailError(undefined);
      setChangePreview(undefined);
      setSourceDecision(undefined);
      setActionMessage(undefined);
    }
  };
  useLayoutEffect(() => {
    inputHandlerRef.current = handleInput;
  }, [handleInput]);
  const dispatchInput = useCallback(
    (input: string, key: Key) => inputHandlerRef.current(input, key),
    [],
  );
  useInput(dispatchInput);

  const heading = kind === "attention" ? "待处理事项" : "工作流历史";
  const pageStart = windowStart(
    page?.items.length ?? 0,
    selected,
    pageWindowSize,
  );
  const visibleRows =
    page?.items.slice(pageStart, pageStart + pageWindowSize) ?? [];
  return (
    <Box flexDirection="column">
      <Text bold>{heading}</Text>
      <Text>
        ↑/↓ 选择 · v 查看依据 · a 确认 · x 拒绝 · s 选择来源候选 · r 重新判断 ·
        n/p 翻页 · Esc 返回
      </Text>
      {error !== undefined ? (
        <Text color="red">{error}</Text>
      ) : page === undefined ? (
        <Text>{busy ? "正在读取…" : "此页没有内容"}</Text>
      ) : page.items.length === 0 ? (
        <Text>
          {kind === "attention" ? "目前没有待处理事项" : "暂无工作流历史"}
        </Text>
      ) : kind === "attention" ? (
        visibleRows.map((rawItem, index) => {
          const item = rawItem as CurrentAttentionPage["items"][number];
          const absoluteIndex = pageStart + index;
          return (
            <Box key={item.id} flexDirection="column">
              <Text>
                {absoluteIndex === selected ? "› " : "  "}
                {item.summary}
              </Text>
              {absoluteIndex === selected && (
                <Text dimColor>{attentionKindLabel(item.kind)}</Text>
              )}
            </Box>
          );
        })
      ) : (
        visibleRows.map((rawItem, index) => {
          const item = rawItem as WorkflowHistoryPage["items"][number];
          const absoluteIndex = pageStart + index;
          return (
            <Box key={item.execution.id} flexDirection="column">
              <Text>
                {absoluteIndex === selected ? "› " : "  "}
                {operationLabel(item.execution.operationKind)}
                {operationLabel(item.execution.operationKind) === "工作流"
                  ? ""
                  : " · "}
                {hasCancellationOutcome(item.execution.outcome)
                  ? historyExecutionStatus(
                      item.execution.status,
                      item.execution.outcome,
                    )
                  : `${historyStage(item.execution.stage)} · ${historyExecutionStatus(
                      item.execution.status,
                      item.execution.outcome,
                    )}`}
              </Text>
              <Text dimColor>
                {item.resultReferences.acceptedAssetIds.length} 项关联资产 ·
                {item.recognitionResults.length} 项识别结果
              </Text>
              {absoluteIndex === selected &&
                item.recognitionResults.map((result, resultIndex) => (
                  <Text key={`${result.proposalId}:${resultIndex}`} dimColor>
                    {result.status === "accepted" ? "已采用" : "曾提出"}：
                    {result.explanation}
                  </Text>
                ))}
            </Box>
          );
        })
      )}
      {executionDetail !== undefined &&
        executionDetail.id === selectedExecutionId && (
          <ExecutionHistoryDetails inspection={executionDetail.inspection} />
        )}
      {sourceDecision !== undefined && (
        <SourceAssociationDecisionDetails
          inspection={sourceDecision}
          selectedCandidate={selectedCandidate}
        />
      )}
      {changePreview !== undefined && (
        <ChangeImpactReviewDetails preview={changePreview} />
      )}
      {actionMessage !== undefined && (
        <Text color="yellow">{actionMessage}</Text>
      )}
      {executionDetailError !== undefined && (
        <Text color="yellow">{executionDetailError}</Text>
      )}
      {onOpenAsset !== undefined && (
        <Text dimColor>Enter 打开当前关联资产</Text>
      )}
    </Box>
  );
}

function SourceAssociationDecisionDetails({
  inspection,
  selectedCandidate,
}: {
  readonly inspection: SourceAssociationDecisionInspection;
  readonly selectedCandidate: number;
}) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text bold>
        来源关联 · {sourceDecisionIntentLabel(inspection.intent)}
      </Text>
      <Text>
        {inspection.failure === undefined
          ? `候选 ${inspection.candidates.length} 项 · ${sourceDecisionStateLabel(inspection.state)}`
          : `需要处理：${inspection.failure}`}
      </Text>
      {inspection.currentAssociations.map((association) => (
        <Text key={association.id}>
          当前关联：{association.sourceIdentity} · {association.nativeAddress}
        </Text>
      ))}
      {inspection.candidates.map((candidate, index) => (
        <Box key={candidate.reference} flexDirection="column">
          <Text>
            {index === selectedCandidate ? "› " : "  "}
            {candidate.sourceIdentity} ·{" "}
            {candidate.outcome === "accepted" ? "可用候选" : "不符合条件"} ·{" "}
            {candidate.nativeAddress}
          </Text>
          <Text dimColor>{candidate.explanation}</Text>
        </Box>
      ))}
      {inspection.preview !== undefined && (
        <Text>
          变更预演：
          {inspection.preview.status === "awaiting-confirmation"
            ? "等待确认"
            : inspection.preview.status === "applied"
              ? "已应用"
              : inspection.preview.status === "stale"
                ? "依据已变化"
                : "已拒绝"}
        </Text>
      )}
      {inspection.availableActions.includes("select") && (
        <Text dimColor>按 s 选择当前候选</Text>
      )}
      {inspection.availableActions.includes("retry") && (
        <Text dimColor>按 r 重新判断来源关联</Text>
      )}
    </Box>
  );
}

function ChangeImpactReviewDetails({
  preview,
}: {
  readonly preview: PublicChangeImpactPreview;
}) {
  const stateLabel = (state: string | undefined) =>
    state === "recognized"
      ? "已识别"
      : state === "unresolved"
        ? "待识别"
        : "未改变";
  const associations = (
    values: PublicChangeImpactPreview["current"]["sourceAssociations"],
  ) =>
    values.length === 0
      ? "没有来源关联"
      : values.map(({ sourceIdentity }) => sourceIdentity).join("、");
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text bold>
        变更影响 ·{" "}
        {preview.status === "awaiting-confirmation"
          ? "等待确认"
          : preview.status === "applied"
            ? "已应用"
            : preview.status === "stale"
              ? "依据已变化"
              : "已拒绝"}
      </Text>
      <Text>
        识别状态：{stateLabel(preview.current.recognitionState)} →{" "}
        {stateLabel(preview.projected.recognitionState)}
      </Text>
      <Text>
        来源关联：{associations(preview.current.sourceAssociations)} →{" "}
        {associations(preview.projected.sourceAssociations)}
      </Text>
      {preview.evidenceConflicts.map((conflict, index) => (
        <Text key={`conflict:${index}`} color="yellow">
          依据冲突：{conflict}
        </Text>
      ))}
      {preview.blockingConditions.map((condition, index) => (
        <Text key={`blocking:${index}`} color="yellow">
          暂不能确认：{condition}
        </Text>
      ))}
    </Box>
  );
}

function sourceDecisionIntentLabel(
  intent: SourceAssociationDecisionInspection["intent"],
): string {
  switch (intent) {
    case "establish":
      return "建立关联";
    case "replace":
      return "替换关联";
    case "retract":
      return "撤回关联";
  }
}

function sourceDecisionStateLabel(state: string): string {
  switch (state) {
    case "awaiting-selection":
      return "等待选择候选";
    case "awaiting-confirmation":
      return "等待检查并确认";
    case "failed":
      return "未完成";
    default:
      return "已处理";
  }
}

function EvidenceView(props: {
  readonly page: AssetEvidencePage | undefined;
  readonly error: string | undefined;
  readonly selected: number;
  readonly sourceChunk: AssetSourceRecordChunk | undefined;
  readonly sourceError: string | undefined;
  readonly busy: boolean;
  readonly pageWindowSize: number;
}) {
  const { page, error, selected, sourceChunk, sourceError, busy } = props;
  if (error !== undefined) return <Text color="red">{error}</Text>;
  if (sourceError !== undefined) return <Text color="red">{sourceError}</Text>;
  if (sourceChunk !== undefined)
    return (
      <Box flexDirection="column">
        <Text>来源：{sourceChunk.record.nativeAddress}</Text>
        <Text>{sourceChunk.content}</Text>
      </Box>
    );
  if (page === undefined) return <Text>{busy ? "正在读取…" : "暂无资料"}</Text>;
  if (page.items.length === 0)
    return (
      <Text>
        {page.status === "missing" ? "暂无这一层资料" : "这一页没有更多内容"}
      </Text>
    );
  const pageStart = windowStart(
    page.items.length,
    selected,
    props.pageWindowSize,
  );
  const visibleItems = page.items.slice(
    pageStart,
    pageStart + props.pageWindowSize,
  );
  return (
    <Box flexDirection="column">
      <Text bold>
        {evidenceLabels[page.kind]} · {page.items.length} 项
      </Text>
      {visibleItems.map((item, index) => {
        const absoluteIndex = pageStart + index;
        return (
          <Box key={`${item.kind}:${absoluteIndex}`} flexDirection="column">
            <Text>
              {absoluteIndex === selected ? "› " : "  "}
              {evidenceTitle(item)}
            </Text>
            {absoluteIndex === selected && <EvidenceDetails item={item} />}
          </Box>
        );
      })}
    </Box>
  );
}

function EvidenceDetails({
  item,
}: {
  readonly item: AssetEvidencePage["items"][number];
}) {
  if (item.kind === "current-value") {
    const result = item.evidence.result;
    return (
      <Box flexDirection="column" marginLeft={2}>
        {result.status === "resolved" ? (
          <>
            {result.values.map((value, index) => (
              <Text key={`${value.property}:${index}`}>
                {value.property}：{value.value}（{reasonLabel(value.reasoning)}
                ，来源 {value.sourceIdentity}）
              </Text>
            ))}
            {result.notSelected.map((value, index) => (
              <Text key={`${value.property}:${index}`} dimColor>
                未采用：{value.property}：{value.value} · {value.sourceIdentity}
              </Text>
            ))}
          </>
        ) : result.status === "conflict" ? (
          <Box flexDirection="column">
            <Text color="yellow">
              存在冲突：{result.explanation}（{result.candidates.length}{" "}
              个候选）
            </Text>
            {result.candidates.map((candidate, index) => (
              <Text
                key={`${candidate.property}:${candidate.sourceIdentity}:${index}`}
              >
                候选：{candidate.value} · 来源 {candidate.sourceIdentity}
              </Text>
            ))}
          </Box>
        ) : (
          <Text dimColor>当前没有可采用值</Text>
        )}
      </Box>
    );
  }
  if (item.kind === "interpreted-fact")
    return (
      <Text dimColor>
        {item.property}：{item.value} · {item.sourceIdentity ?? "本地解释"}
        {item.sourceRecordIds.length === 0
          ? ""
          : ` · 依据 ${item.sourceRecordIds.length} 份来源资料`}
      </Text>
    );
  if (item.kind === "metadata-decision")
    return (
      <Text dimColor>
        {item.decision === "pin" ? "固定值" : "撤回修订"}
        {item.value === undefined ? "" : `：${item.value}`}
        {item.adoptedFrom?.sourceIdentity === undefined
          ? ""
          : ` · 采纳自 ${item.adoptedFrom.sourceIdentity}`}
        {item.current ? " · 当前修订" : " · 历史记录"}
      </Text>
    );
  if (item.kind === "source-record")
    return (
      <Text dimColor>
        {item.status === "missing"
          ? "所引用的来源资料当前不可用"
          : `${item.sourceIdentity ?? "来源"} · ${item.mediaType ?? "资料"}${item.acquiredAt === undefined ? "" : ` · 获取于 ${formatDate(item.acquiredAt)}`}${item.coverage === undefined ? "" : ` · ${item.coverage.completeness === "complete" ? "记录完整" : "记录不完整"}`} · 按 Enter 展开正文`}
      </Text>
    );
  if (item.kind === "local-observation")
    return <Text dimColor>{localObservationDetails(item)}</Text>;
  return <Text dimColor>{formatResultDetails(item)}</Text>;
}

function evidenceTitle(item: AssetEvidencePage["items"][number]): string {
  switch (item.kind) {
    case "local-observation":
      return item.relativePath || "资产目录";
    case "format-result":
      return item.explanation;
    case "source-record":
      return item.nativeAddress ?? "来源资料";
    case "interpreted-fact":
      return `${item.property}：${item.value}`;
    case "current-value":
      return item.evidence.property;
    case "metadata-decision":
      return `${item.property} · ${item.decision === "pin" ? "固定值" : "撤回"}`;
  }
}

function reasonLabel(reason: { readonly kind: string }): string {
  switch (reason.kind) {
    case "source-preference":
      return "按来源偏好采用";
    case "preferred-source-absent-fallback":
      return "首选来源缺失，采用回退来源";
    case "preferred-sources-absent-unranked":
      return "首选来源缺失，未排序采用";
    default:
      return "没有来源优先级";
  }
}

function historyExecutionStatus(status: string, outcome?: string): string {
  if (status === "running") return "进行中";
  if (outcome === "cancelled") return "已取消";
  if (outcome === "interrupted") return "已中断";
  if (status === "failed" || outcome === "failed") return "失败";
  return `已完成${outcome === undefined ? "" : `，${historyOutcome(outcome)}`}`;
}

function hasCancellationOutcome(outcome?: string): boolean {
  return outcome === "cancelled" || outcome === "interrupted";
}

function ExecutionHistoryDetails({
  inspection,
}: {
  readonly inspection: PublicExecutionInspection;
}) {
  if (inspection.kind === "asset-library-scan") {
    const available = inspection.children.filter(
      (child) => child.status === "available",
    );
    const missing = inspection.children.length - available.length;
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text bold>执行详情 · 资料库扫描</Text>
        <Text>
          {historyExecutionStatus(inspection.status, inspection.outcome)}
          {inspection.cancellationRequested === undefined
            ? ""
            : " · 已收到停止请求"}
        </Text>
        <Text>
          {inspection.children.length} 项目录处理
          {missing === 0 ? "" : ` · ${missing} 项详情暂不可用`}
        </Text>
        {available.length > 0 && (
          <Text>
            目录状态：
            {summarizeExecutionStatuses(
              available.map((child) => child.execution),
            )}
          </Text>
        )}
        <Text>
          来源更新：
          {available.reduce(
            (count, child) => count + child.execution.sourceRefreshRuns.length,
            0,
          )}{" "}
          项
        </Text>
      </Box>
    );
  }

  const { progress, sourceRefreshRuns } = inspection;
  const dispositions = progress.dispositions;
  const workItems = progress.workItems;
  const targets = progress.targets;
  const changeSets = sourceRefreshRuns.flatMap((run) => run.changeSets);
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text bold>执行详情 · {operationLabel(inspection.operationKind)}</Text>
      <Text>
        {hasCancellationOutcome(inspection.outcome)
          ? historyExecutionStatus(inspection.status, inspection.outcome)
          : `${historyStage(inspection.stage)} · ${historyExecutionStatus(
              inspection.status,
              inspection.outcome,
            )}`}
        {inspection.cancellation === undefined ? "" : " · 已收到停止请求"}
      </Text>
      {dispositions.length > 0 && (
        <Text>
          处理步骤：
          {summarizeStatuses(
            dispositions.map(({ status }) => status),
            progressStatusLabel,
          )}
        </Text>
      )}
      {workItems.length > 0 && (
        <Text>
          资料项：{workItems.length} 项
          {workItems.filter(
            ({ acceptedAssetId }) => acceptedAssetId !== undefined,
          ).length === 0
            ? ""
            : ` · ${workItems.filter(({ acceptedAssetId }) => acceptedAssetId !== undefined).length} 项已关联`}
          {workItems.filter(({ reason }) => reason !== undefined).length === 0
            ? ""
            : ` · ${workItems.filter(({ reason }) => reason !== undefined).length} 项有说明`}
        </Text>
      )}
      {targets.length > 0 && (
        <Text>
          目标：
          {summarizeStatuses(
            targets.map(({ status }) => status),
            progressStatusLabel,
          )}
        </Text>
      )}
      {sourceRefreshRuns.length > 0 && (
        <Text>
          来源更新：{sourceRefreshRuns.length} 项 · {changeSets.length} 组变更
          {changeSets.filter(({ disposition }) => disposition === "pending")
            .length === 0
            ? ""
            : ` · ${changeSets.filter(({ disposition }) => disposition === "pending").length} 组待确认`}
        </Text>
      )}
    </Box>
  );
}

function summarizeStatuses(
  statuses: readonly string[],
  label: (status: string) => string,
): string {
  const counts = new Map<string, number>();
  for (const status of statuses)
    counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts]
    .map(([status, count]) => `${label(status)} ${count}`)
    .join("、");
}

function summarizeExecutionStatuses(
  executions: readonly {
    readonly status: string;
    readonly outcome?: string | undefined;
  }[],
): string {
  const counts = new Map<string, number>();
  for (const execution of executions) {
    const label = historyExecutionStatus(execution.status, execution.outcome);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join("、");
}

function progressStatusLabel(status: string): string {
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
    case "blocked":
      return "受阻";
    default:
      return "已处理";
  }
}

function operationLabel(operationKind: string | undefined): string {
  switch (operationKind) {
    case "scan-filesystem":
      return "本地目录扫描";
    case "scan-asset-library":
      return "资料库扫描";
    case "refresh-metadata":
      return "资料更新";
    case "rescrape":
      return "来源复查";
    case "associate-observed-material":
      return "资料关联";
    default:
      return "工作流";
  }
}

function historyStage(stage: string): string {
  switch (stage) {
    case "recognition":
      return "识别中";
    case "source-records-retained":
      return "来源资料已保存";
    case "source-artifacts-acquired":
    case "cover-acquired":
      return "正在获取资料文件";
    case "source-artifacts-stored":
    case "cover-stored":
      return "资料文件已保存";
    case "completed":
      return "已结束";
    case "failed":
      return "遇到问题";
    default:
      return "处理中";
  }
}

function historyOutcome(outcome: string): string {
  switch (outcome) {
    case "unresolved":
      return "尚未解决";
    case "proposal":
      return "有待确认的建议";
    case "accepted":
      return "已确认";
    case "partially-succeeded":
      return "部分完成";
    case "failed":
      return "未完成";
    case "interrupted":
      return "已中断";
    case "cancelled":
      return "已取消";
    case "no-change":
      return "没有变化";
    default:
      return "已处理";
  }
}

function attentionKindLabel(
  kind: CurrentAttentionPage["items"][number]["kind"],
): string {
  switch (kind) {
    case "recognition-review":
      return "需要确认识别结果";
    case "change-impact-review":
      return "需要查看变更影响";
    case "source-refresh-review":
      return "需要查看来源更新";
    case "prerequisite-unavailable":
      return "所需资料暂不可用";
  }
}

function localObservationDetails(
  item: Extract<
    AssetEvidencePage["items"][number],
    { kind: "local-observation" }
  >,
): string {
  const entry = item.entry;
  const observedAt = formatDate(item.observedAt);
  if (entry.kind === "file")
    return `${item.relativePath} · 文件 · ${entry.size} 字节 · 修改 ${formatDate(entry.modifiedAt)} · 观察 ${observedAt}`;
  if (entry.kind === "directory")
    return `${item.relativePath} · 目录 · 修改 ${formatDate(entry.modifiedAt)} · 观察 ${observedAt}`;
  return `${item.relativePath} · 未纳入 · ${observationExclusionLabel(entry.reason)} · 观察 ${observedAt}`;
}

function observationExclusionLabel(
  reason: "symbolic-link" | "special" | "unavailable",
): string {
  switch (reason) {
    case "symbolic-link":
      return "链接未纳入";
    case "special":
      return "特殊文件未纳入";
    case "unavailable":
      return "当前不可读取";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN");
}

function formatResultDetails(
  item: Extract<AssetEvidencePage["items"][number], { kind: "format-result" }>,
): string {
  switch (item.detail.kind) {
    case "result":
      return `读取结果 · ${item.detail.byteLength} 字节 · ${mediaTypeLabel(item.detail.mediaType)}`;
    case "identifier":
      return `标识 ${identifierSchemeLabel(item.detail.scheme)}：${item.detail.value || "（空）"}`;
    case "metadata":
      return `${formatMetadataPropertyLabel(item.detail.property)}：${item.detail.value || "（空）"}`;
    case "part":
      return `${formatPartRoleLabel(item.detail.role)} · ${mediaTypeLabel(item.detail.mediaType)}`;
    case "entity-graph":
      return `检查到 ${item.detail.entityCount} 个条目、${item.detail.mentionCount} 处提及、${item.detail.relationshipCount} 项关联`;
  }
}

function mediaTypeLabel(mediaType: string): string {
  switch (mediaType) {
    case "application/pdf":
      return "PDF 文档";
    case "application/epub+zip":
      return "EPUB 电子书";
    case "image/jpeg":
      return "JPEG 图像";
    case "image/png":
      return "PNG 图像";
    case "audio/mpeg":
      return "MP3 音频";
    default:
      return mediaType;
  }
}

function identifierSchemeLabel(scheme: string): string {
  return scheme.toLocaleLowerCase() === "isbn-13" ? "ISBN-13" : scheme;
}

function formatMetadataPropertyLabel(property: string): string {
  switch (property) {
    case "pdf.page-count":
      return "页数";
    case "pdf.document-author":
      return "作者";
    default:
      return property;
  }
}

function formatPartRoleLabel(role: string): string {
  switch (role) {
    case "asset.material-image":
      return "页面图像";
    case "asset.primary-cover":
      return "封面";
    default:
      return role;
  }
}

function windowStart(length: number, selected: number, size: number): number {
  return Math.min(Math.max(0, selected - size + 1), Math.max(0, length - size));
}

function publicErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}
