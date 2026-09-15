import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  AssetRefreshInspection,
  ChangeImpactPreviewInspection,
  InformationRequirement,
} from "@digital/application";
import type {
  ProductApplication,
  ProductAutomationHostOptions,
  ProductAutomationOperations,
  ProductWorkflowOperations,
} from "@digital/product-application";
import { Command, CommanderError } from "commander";

const commandName = "cli";
export type Greeting = {
  readonly message: string;
};

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly streams: {
    readonly stdin: object;
    readonly stdout: { write(chunk: string): unknown };
    readonly stderr: { write(chunk: string): unknown };
  };
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tty: {
    readonly stdin: boolean;
    readonly stdout: boolean;
    readonly stderr: boolean;
  };
  readonly version: string;
  readonly waitForShutdown?: () => Promise<void>;
};

export function greet(name: string): Greeting {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new Error("Name must not be empty");
  }
  return { message: `Hello, ${normalizedName}` };
}

export type CliProductApplication = Pick<
  ProductApplication,
  "workflow" | "automation" | "createOfflineBackup" | "startAutomation"
>;

export class CliResources {
  private readonly application: CliProductApplication;

  constructor(application: CliProductApplication) {
    this.application = application;
  }

  assetRefresh(): ProductWorkflowOperations {
    return this.application.workflow;
  }

  async automationHost(
    options: ProductAutomationHostOptions,
  ): Promise<ProductAutomationOperations> {
    await this.application.startAutomation(options);
    return this.application.automation;
  }

  async createOfflineBackup(backupDirectory: string): Promise<void> {
    await this.application.createOfflineBackup(backupDirectory);
  }

  async close(): Promise<void> {
    // 生命周期由可执行组合根持有；交付层没有关闭权。
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 浏览器导出内容只作为导入输入。文件系统/JSON 诊断应保持通用，
 * 使路径和不完整私有导出内容都不会成为 CLI 错误面。
 */
async function readFanboxBrowserCredentialFile(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error("无法读取 FANBOX 浏览器凭据文件");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("FANBOX 浏览器凭据文件格式无效");
  }
}

function sourceConnectionVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0)
    throw new Error("来源连接版本无效");
  return version;
}

const cliAssetViewInformationRequirement: InformationRequirement = {
  metadataUsageContext: "asset.ordinary",
  metadata: [
    { property: "asset.title", necessity: "optional" },
    { property: "asset.introduction", necessity: "optional" },
    { property: "asset.summary", necessity: "optional" },
    { property: "asset.body", necessity: "optional" },
    { property: "asset.release-date", necessity: "optional" },
    { property: "asset.runtime-minutes", necessity: "optional" },
    { property: "asset.awards", necessity: "optional" },
    { property: "asset.box-office", necessity: "optional" },
    { property: "rating.*", necessity: "optional" },
    { property: "external.imdb-id", necessity: "optional" },
    { property: "asset.publication-datetime", necessity: "optional" },
    { property: "asset.declared-language", necessity: "optional" },
    { property: "asset.content-classification", necessity: "optional" },
  ],
  artifactRoles: [
    { role: "asset.primary-cover", necessity: "optional" },
    { role: "asset.material-image", necessity: "optional" },
  ],
  relationshipTypes: [
    { type: "asset.*", necessity: "optional" },
    { type: "bangumi.subject.related", necessity: "optional" },
  ],
};

function informationRequirement(
  requiredArtifactRoles: readonly string[] | undefined,
): InformationRequirement {
  const required = new Set(requiredArtifactRoles ?? []);
  const roles =
    required.size === 0
      ? cliAssetViewInformationRequirement.artifactRoles
      : [...required].map((role) => ({
          role,
          necessity: "required" as const,
          maximum: 1,
        }));
  return {
    ...cliAssetViewInformationRequirement,
    artifactRoles: roles,
  };
}

function renderStructuredFailure(reason: string): string {
  return `${JSON.stringify({
    format: "temporary-asset-refresh-inspection/v1",
    unstable: true,
    execution: {
      status: "failed",
      outcome: "failed",
      reason,
    },
    sourceRecords: [],
  })}\n`;
}

function renderInspection(
  inspection: AssetRefreshInspection,
  json: boolean,
): string {
  const { execution } = inspection;
  if (json) {
    return `${JSON.stringify({
      format: "temporary-asset-refresh-inspection/v1",
      unstable: true,
      executionId: execution.id,
      ...inspection,
    })}\n`;
  }
  const outcome =
    execution.outcome === undefined
      ? "进行中"
      : execution.outcome === "unresolved"
        ? "未识别"
        : execution.outcome === "proposal"
          ? "已生成识别预览"
          : execution.outcome === "accepted"
            ? "已接受"
            : execution.outcome === "partially-succeeded"
              ? "部分完成"
              : execution.outcome === "no-change"
                ? "无变更（已复用）"
                : "失败";
  const accepted = inspection.accepted;
  const metadata = accepted?.effectiveMetadata ?? [];
  const metadataPolicyConflicts = accepted?.metadataPolicyConflicts ?? [];
  const title = metadata.find(
    (entry) => entry.property === "asset.title",
  )?.value;
  const operation =
    execution.selection.intent === "metadata-refresh"
      ? "刷新元数据"
      : undefined;
  return (
    [
      `刷新记录：${execution.id}`,
      ...(operation === undefined ? [] : [`操作：${operation}`]),
      `结果：${outcome}`,
      `文件：${execution.snapshot?.files.length ?? 0}`,
      ...(inspection.unresolvedObservation === undefined
        ? []
        : [
            `观察范围：${inspection.unresolvedObservation.observedRoot}`,
            `总大小：${inspection.unresolvedObservation.totalSize} 字节`,
            `代表文件：${inspection.unresolvedObservation.representativePaths.join("、") || "无"}`,
          ]),
      ...(title === undefined ? [] : [`作品：${title}`]),
      ...(accepted === undefined
        ? []
        : [
            "来源：",
            ...accepted.sourceAssociations.map(
              (association) =>
                `  ${association.sourceIdentity}：${association.nativeAddress}`,
            ),
            "当前采用：",
            ...metadata.flatMap((item) => [
              `  ${item.property}：${item.value}（${item.sourceIdentity}；记录 ${item.sourceRecordIds.join("、")}；来源位置 ${item.sourceSlot}）`,
              `    选择依据：${effectiveMetadataReason(item.reasoning)}`,
              ...item.alternatives.map(
                (alternative) =>
                  `    其他来源：${alternative.value}（${alternative.sourceIdentity}；记录 ${alternative.sourceRecordIds.join("、")}；来源位置 ${alternative.sourceSlot}；${alternative.exclusion?.disagreesWithSelected === true ? "与当前值不一致" : "与当前值一致"}；${alternative.exclusion?.kind === "source-preference" ? "因来源顺序未采用" : "按稳定断言顺序未采用"}）`,
              ),
            ]),
            ...(metadataPolicyConflicts.length === 0
              ? []
              : [
                  "元数据规则冲突：",
                  ...metadataPolicyConflicts.map(
                    (conflict) =>
                      `  ${conflict.property}：${conflict.kind === "policy-conflict" ? `规则 ${conflict.policyIds.join("、")} 尚未确定先后` : "存在多个同等有效值"}，当前没有采用值（候选 ${conflict.candidates.map((candidate) => `${candidate.value}［${candidate.sourceIdentity}］`).join("、") || "无"}）`,
                  ),
                ]),
            "实体：",
            ...(accepted.currentRelatedEntities ?? []).map((entity) => {
              const kind =
                entity.kind.status === "effective"
                  ? entity.kind.kind
                  : entity.kind.status === "conflict"
                    ? entity.kind.kinds.join("、")
                    : "entity";
              return `  ${entity.label}（${kind}）`;
            }),
            "关系与角色：",
            ...(accepted.relationships ?? []).map((relationship) => {
              const participants = relationship.participants.map((item) => {
                const participant = (
                  accepted.currentRelatedEntities ?? []
                ).find((entity) => entity.id === item.entityId);
                return `${item.role}：${participant?.label ?? item.entityId}`;
              });
              return `  ${relationship.type}：${participants.join("；")}（记录 ${relationship.sourceRecordIds.join("、")}）`;
            }),
            `识别说明：${accepted.recognitionExplanation}`,
            "产物与位置：",
            ...accepted.artifacts.map((artifact) => {
              const location = accepted.locations.find(
                (item) => item.artifactId === artifact.id,
              );
              const roles = accepted.artifactAssociations
                .filter((item) => item.artifactId === artifact.id)
                .map((item) => item.role)
                .join("、");
              return `  ${roles || "未命名"}：${location?.address ?? "无位置"}（${location?.kind === "observed" ? "本地可用" : location?.kind === "managed" ? "已托管" : "未知"}）`;
            }),
          ]),
      ...(inspection.itemResults === undefined
        ? []
        : inspection.itemResults.flatMap((item) => [
            `边界 ${item.key}：${item.outcome ?? "进行中"}`,
            ...(item.accepted === undefined
              ? []
              : [
                  "  来源：",
                  ...item.accepted.sourceAssociations.map(
                    (association) =>
                      `    ${association.sourceIdentity}：${association.nativeAddress}`,
                  ),
                  "  当前采用：",
                  ...item.accepted.effectiveMetadata.flatMap((data) => [
                    `    ${data.property}：${data.value}（${data.sourceIdentity}；记录 ${data.sourceRecordIds.join("、")}；来源位置 ${data.sourceSlot}）`,
                    `      选择依据：${effectiveMetadataReason(data.reasoning)}`,
                    ...data.alternatives.map(
                      (alternative) =>
                        `      其他来源：${alternative.value}（${alternative.sourceIdentity}；记录 ${alternative.sourceRecordIds.join("、")}；来源位置 ${alternative.sourceSlot}；${alternative.exclusion?.disagreesWithSelected === true ? "与当前值不一致" : "与当前值一致"}；${alternative.exclusion?.kind === "source-preference" ? "因来源顺序未采用" : "按稳定断言顺序未采用"}）`,
                    ),
                  ]),
                  ...((item.accepted.metadataPolicyConflicts ?? []).length === 0
                    ? []
                    : [
                        "  元数据规则冲突：",
                        ...(item.accepted.metadataPolicyConflicts ?? []).map(
                          (conflict) =>
                            `    ${conflict.property}：${conflict.kind === "policy-conflict" ? `规则 ${conflict.policyIds.join("、")} 尚未确定先后` : "存在多个同等有效值"}，当前没有采用值`,
                        ),
                      ]),
                ]),
          ])),
      ...(execution.reusedExecutionId === undefined
        ? []
        : [`复用记录：${execution.reusedExecutionId}`]),
      ...(execution.reason === undefined ? [] : [`原因：${execution.reason}`]),
      ...(inspection.changeImpactPreview === undefined
        ? []
        : [
            `变更影响预演：${inspection.changeImpactPreview.id}（${inspection.changeImpactPreview.status}）`,
            `预演事实：元数据 ${inspection.changeImpactPreview.metadataCount}，实体 ${inspection.changeImpactPreview.entityCount}，关系 ${inspection.changeImpactPreview.relationshipCount}，产物 ${inspection.changeImpactPreview.artifactCount}`,
          ]),
      "工作项：",
      ...execution.dispositions.map(
        (item) =>
          `  ${item.key}：${item.status}${item.reason === undefined ? "" : `（${item.reason}）`}`,
      ),
      ...(json ? [] : ["机器可读输出为临时格式；使用 --json 获取。"]),
    ].join("\n") + "\n"
  );
}

function effectiveMetadataReason(
  reasoning: NonNullable<
    AssetRefreshInspection["accepted"]
  >["effectiveMetadata"][number]["reasoning"],
): string {
  if (reasoning.kind === "source-preference")
    return `采用首选来源 ${reasoning.preferredSource}`;
  if (reasoning.kind === "preferred-source-absent-fallback")
    return `首选来源 ${reasoning.absentPreferredSources.join("、")} 没有可用值，采用 ${reasoning.selectedFallbackSource}`;
  return "采用当前可用来源";
}

function renderChangeImpactPreview(
  preview: ChangeImpactPreviewInspection,
  json: boolean,
): string {
  if (json)
    return `${JSON.stringify({ format: "temporary-change-impact-preview/v1", unstable: true, preview })}\n`;
  return (
    [
      `变更影响预演：${preview.id}`,
      `状态：${preview.status}`,
      `当前来源：${preview.current.recognitionSourceAssociation?.nativeAddress ?? "无识别来源"}`,
      `拟定来源：${preview.projected.recognitionSourceAssociation?.nativeAddress ?? "无识别来源"}`,
      `影响：元数据 ${preview.metadataCount}，实体 ${preview.entityCount}，提及 ${preview.mentionCount}，解析 ${preview.resolutionCount}，关系 ${preview.relationshipCount}，产物 ${preview.artifactCount}`,
      "当前元数据：",
      ...preview.current.metadata.map(
        (item) => `  ${item.property}：${item.value}`,
      ),
      "拟定元数据：",
      ...preview.projected.metadata.map(
        (item) => `  ${item.property}：${item.value}`,
      ),
      "当前关系：",
      ...preview.current.relationships.map(
        (item) =>
          `  ${item.type}：${item.participants.map((participant) => `${participant.role}：${participant.entityId}`).join("；")}`,
      ),
      "拟定关系：",
      ...preview.projected.relationships.map(
        (item) =>
          `  ${item.type}：${item.participants.map((participant) => `${participant.role}：${participant.entityId}`).join("；")}`,
      ),
      "当前产物用途：",
      ...preview.current.artifactAssociations.map((item) => `  ${item.role}`),
      "拟定产物用途：",
      ...preview.projected.artifactAssociations.map((item) => `  ${item.role}`),
      ...(preview.blockingConditions.length === 0
        ? []
        : [`阻塞条件：${preview.blockingConditions.join("；")}`]),
    ].join("\n") + "\n"
  );
}

export function createCliCommand(
  runtime: CliRuntime,
  resources: CliResources,
): Command {
  const command = new Command()
    .name(commandName)
    .description("A TypeScript command-line tool.")
    .version(runtime.version)
    .configureOutput({
      writeOut: (text) => runtime.streams.stdout.write(text),
      writeErr: (text) => runtime.streams.stderr.write(text),
    })
    .showHelpAfterError()
    .exitOverride();
  const greetCommand = command
    .command("greet")
    .description("Greet a person.")
    .argument("<name>", "name to greet")
    .action((name: string) => {
      try {
        runtime.streams.stdout.write(`${greet(name).message}\n`);
      } catch (error) {
        greetCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.greet.invalid-name",
        });
      }
    });

  const rootService = () => {
    const workflow = resources.assetRefresh();
    return workflow.observedRootRegistrations;
  };
  const fanboxConnections = () =>
    resources.assetRefresh().sourceConnections.fanbox;
  const sourceConnections = () => resources.assetRefresh().sourceConnections;

  const materialPrepareCommand = command
    .command("material-association-prepare")
    .description("检查文件位置中将关联到既有内容的完整文件。")
    .requiredOption("--asset <id>", "既有内容标识")
    .requiredOption("--root <id>", "已登记文件位置标识")
    .requiredOption("--scope <scope>", "文件位置内的相对范围")
    .requiredOption("--file <paths...>", "范围内的一个或多个完整文件")
    .requiredOption("--initiated-by <actor>", "发起者")
    .action(
      async (options: {
        readonly asset: string;
        readonly root: string;
        readonly scope: string;
        readonly file: string[];
        readonly initiatedBy: string;
      }) => {
        try {
          const result = await resources
            .assetRefresh()
            .prepareObservedMaterialAssociation({
              targetAssetId: options.asset,
              registrationId: options.root,
              relativeScope: options.scope,
              relativePaths: options.file,
              initiatedBy: options.initiatedBy,
            });
          runtime.streams.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
          materialPrepareCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.material-association.prepare-failed",
          });
        }
      },
    );

  const materialInspectCommand = command
    .command("material-association-inspect")
    .description("查看观察材料关联记录。")
    .argument("<execution-id>", "关联执行标识")
    .action(async (executionId: string) => {
      try {
        const result = await resources
          .assetRefresh()
          .inspectObservedMaterialAssociation(executionId);
        runtime.streams.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        materialInspectCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.material-association.inspect-failed",
        });
      }
    });

  const materialConfirmCommand = command
    .command("material-association-confirm")
    .description("确认已检查的观察材料关联。")
    .argument("<execution-id>", "关联执行标识")
    .requiredOption("--confirmed-by <actor>", "确认者")
    .action(
      async (
        executionId: string,
        options: { readonly confirmedBy: string },
      ) => {
        try {
          const result = await resources
            .assetRefresh()
            .confirmObservedMaterialAssociation({
              executionId,
              confirmedBy: options.confirmedBy,
            });
          runtime.streams.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
          materialConfirmCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.material-association.confirm-failed",
          });
        }
      },
    );

  command
    .command("catalogue-surface")
    .description("查看当前目录、需要处理或刷新历史中的一个分页面。")
    .requiredOption(
      "--surface <surface>",
      "current-catalogue、current-attention 或 workflow-history",
    )
    .action(async (options: { readonly surface: string }) => {
      const workflow = resources.assetRefresh();
      if (options.surface === "current-catalogue") {
        runtime.streams.stdout.write(
          `${JSON.stringify(await workflow.listCurrentCataloguePage({}))}\n`,
        );
        return;
      }
      if (options.surface === "current-attention") {
        runtime.streams.stdout.write(
          `${JSON.stringify(await workflow.listCurrentAttentionPage({}))}\n`,
        );
        return;
      }
      if (options.surface === "workflow-history") {
        runtime.streams.stdout.write(
          `${JSON.stringify(await workflow.listWorkflowHistoryPage({}))}\n`,
        );
        return;
      }
      throw new Error("未知内容目录 surface");
    });

  const offlineBackupCommand = command
    .command("offline-backup")
    .description("停机后复制可恢复的产品数据区域到一个空目录。")
    .argument("<backup-directory>", "空备份目录")
    .action(async (backupDirectory: string) => {
      try {
        await resources.createOfflineBackup(backupDirectory);
        runtime.streams.stdout.write("离线备份完成。\n");
      } catch (error) {
        offlineBackupCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.offline-backup.failed",
        });
      }
    });

  const offlineRestoreCommand = command
    .command("offline-restore")
    .description("从离线备份恢复到空产品数据目录，并调用正式迁移步骤。")
    .argument("<backup-directory>", "已有离线备份目录")
    .action(async (backupDirectory: string) => {
      try {
        await runFormalOfflineRestore(runtime, backupDirectory);
        runtime.streams.stdout.write("离线恢复完成；正式迁移检查已通过。\n");
      } catch (error) {
        offlineRestoreCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.offline-restore.failed",
        });
      }
    });

  command
    .command("source-connection-list")
    .description("查看已配置的在线来源连接状态。")
    .action(() => {
      runtime.streams.stdout.write(
        `${JSON.stringify(sourceConnections().inspect())}\n`,
      );
    });

  const bangumiAuthorizeCommand = command
    .command("bangumi-connection-authorize")
    .description("开始 Bangumi 授权，并输出需要在浏览器中打开的地址。")
    .action(() => {
      try {
        runtime.streams.stdout.write(
          `${JSON.stringify(sourceConnections().bangumi.beginAuthorization())}\n`,
        );
      } catch (error) {
        bangumiAuthorizeCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.bangumi-connection.authorize-failed",
        });
      }
    });

  const bangumiCallbackCommand = command
    .command("bangumi-connection-callback")
    .description("提交 Bangumi 浏览器回调地址以完成授权。")
    .argument("<callback-url>", "浏览器地址栏中的完整回调地址")
    .action(async (callbackUrl: string) => {
      try {
        const inspection =
          await sourceConnections().bangumi.completeAuthorizationCallback(
            callbackUrl,
          );
        runtime.streams.stdout.write(`${JSON.stringify(inspection)}\n`);
      } catch (error) {
        bangumiCallbackCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.bangumi-connection.callback-failed",
        });
      }
    });

  const bangumiRevokeCommand = command
    .command("bangumi-connection-revoke")
    .description("撤销当前 Bangumi 来源连接。")
    .requiredOption("--expected-version <number>", "当前连接版本")
    .action((options: { readonly expectedVersion: string }) => {
      try {
        const inspection = sourceConnections().bangumi.revoke(
          sourceConnectionVersion(options.expectedVersion),
        );
        runtime.streams.stdout.write(`${JSON.stringify(inspection)}\n`);
      } catch (error) {
        bangumiRevokeCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.bangumi-connection.revoke-failed",
        });
      }
    });

  const fanboxImportCommand = command
    .command("fanbox-connection-import")
    .description("导入并验证一个创作者范围的 FANBOX 浏览器凭据。")
    .argument("<creator-id>", "FANBOX 创作者范围")
    .argument("<browser-credential-file>", "浏览器请求上下文 JSON 文件")
    .action(async (creatorId: string, browserCredentialFile: string) => {
      try {
        const inspection = await fanboxConnections().importBrowserCredentials({
          creatorId,
          browserCredential: await readFanboxBrowserCredentialFile(
            browserCredentialFile,
          ),
        });
        runtime.streams.stdout.write(`${JSON.stringify(inspection)}\n`);
      } catch (error) {
        fanboxImportCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.fanbox-connection.import-failed",
        });
      }
    });

  const fanboxReplaceCommand = command
    .command("fanbox-connection-replace")
    .description("验证后替换一个创作者范围的 FANBOX 浏览器凭据。")
    .argument("<creator-id>", "FANBOX 创作者范围")
    .argument("<browser-credential-file>", "浏览器请求上下文 JSON 文件")
    .requiredOption("--expected-version <number>", "当前连接版本")
    .action(
      async (
        creatorId: string,
        browserCredentialFile: string,
        options: { readonly expectedVersion: string },
      ) => {
        try {
          const inspection =
            await fanboxConnections().replaceBrowserCredentials({
              creatorId,
              expectedVersion: sourceConnectionVersion(options.expectedVersion),
              browserCredential: await readFanboxBrowserCredentialFile(
                browserCredentialFile,
              ),
            });
          runtime.streams.stdout.write(`${JSON.stringify(inspection)}\n`);
        } catch (error) {
          fanboxReplaceCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.fanbox-connection.replace-failed",
          });
        }
      },
    );

  const fanboxRevokeCommand = command
    .command("fanbox-connection-revoke")
    .description("撤销一个创作者范围的 FANBOX 来源连接。")
    .argument("<creator-id>", "FANBOX 创作者范围")
    .requiredOption("--expected-version <number>", "当前连接版本")
    .action(
      (creatorId: string, options: { readonly expectedVersion: string }) => {
        try {
          const inspection = fanboxConnections().revoke({
            creatorId,
            expectedVersion: sourceConnectionVersion(options.expectedVersion),
          });
          runtime.streams.stdout.write(`${JSON.stringify(inspection)}\n`);
        } catch (error) {
          fanboxRevokeCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.fanbox-connection.revoke-failed",
          });
        }
      },
    );

  const rootCreateCommand = command
    .command("root-create")
    .description("登记一个容器内可见的只读文件位置。")
    .argument("<name>", "显示名称")
    .argument("<container-path>", "容器内绝对路径")
    .option("--symlink-mode <mode>", "链接策略", "do-not-follow")
    .action(async (name: string, containerPath: string, options) => {
      try {
        const created = await rootService().create({
          displayName: name,
          containerPath,
          readOnly: true,
          symlinkMode: options.symlinkMode,
          allowedTargetRootIds: [],
        });
        runtime.streams.stdout.write(`${JSON.stringify(created)}\n`);
      } catch (error) {
        rootCreateCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.observed-root.create-failed",
        });
      }
    });
  command
    .command("root-list")
    .description("列出文件位置。")
    .action(async () => {
      runtime.streams.stdout.write(
        `${JSON.stringify(await rootService().list())}\n`,
      );
    });
  command
    .command("root-get")
    .description("查看一个文件位置。")
    .argument("<id>", "文件位置编号")
    .action(async (id: string) => {
      const registration = await rootService().get(id);
      if (registration === undefined) throw new Error("文件位置不存在");
      runtime.streams.stdout.write(`${JSON.stringify(registration)}\n`);
    });
  command
    .command("root-update")
    .description("更新一个文件位置的名称和链接策略。")
    .argument("<id>", "文件位置编号")
    .requiredOption("--version <number>", "当前配置版本")
    .requiredOption("--name <name>", "显示名称")
    .requiredOption("--symlink-mode <mode>", "链接策略")
    .action(async (id: string, options) => {
      const updated = await rootService().update({
        id,
        expectedVersion: Number(options.version),
        displayName: options.name,
        readOnly: true,
        symlinkMode: options.symlinkMode,
        allowedTargetRootIds: [],
      });
      runtime.streams.stdout.write(`${JSON.stringify(updated)}\n`);
    });
  command
    .command("root-deactivate")
    .description("停用一个文件位置，但保留其历史身份。")
    .argument("<id>", "文件位置编号")
    .requiredOption("--version <number>", "当前配置版本")
    .action(async (id: string, options) => {
      runtime.streams.stdout.write(
        `${JSON.stringify(
          await rootService().deactivate({
            id,
            expectedVersion: Number(options.version),
          }),
        )}\n`,
      );
    });
  command
    .command("root-reconnect")
    .description("按原身份重新连接同一个文件位置。")
    .argument("<id>", "文件位置编号")
    .argument("<container-path>", "容器内绝对路径")
    .requiredOption("--version <number>", "当前配置版本")
    .action(async (id: string, containerPath: string, options) => {
      runtime.streams.stdout.write(
        `${JSON.stringify(
          await rootService().reconnect({
            id,
            expectedVersion: Number(options.version),
            containerPath,
            readOnly: true,
          }),
        )}\n`,
      );
    });

  for (const [name, acceptTrusted, intent, description] of [
    ["scan", true, "scan-now", "扫描目录并应用受信任的识别结果。"],
    ["preview", false, "scan-now", "扫描目录并显示未应用的识别结果。"],
    [
      "refresh-metadata",
      true,
      "metadata-refresh",
      "显式重新获取已关联来源的元数据。",
    ],
  ] as const) {
    const refreshCommand = command
      .command(name)
      .description(description)
      .argument(
        "<target>",
        intent === "metadata-refresh"
          ? "要刷新的主体标识"
          : "已登记的文件位置编号",
      )
      .option("--scope <relative-path>", "登记根内的有限相对范围", ".")
      .option("--json", "输出临时机器可读结果")
      .option("--require-artifact-role <roles...>", "要求本次获取指定产物用途")
      .action(
        async (
          target: string,
          options: {
            readonly json?: boolean;
            readonly scope?: string;
            readonly requireArtifactRole?: readonly string[];
          },
        ) => {
          let wroteInspection = false;
          try {
            const workflow = resources.assetRefresh();
            const callbacks = {
              onExecutionStarted(execution: { readonly id: string }) {
                runtime.streams.stderr.write(`刷新记录：${execution.id}\n`);
              },
              onProgress(message: string) {
                runtime.streams.stderr.write(`${message}\n`);
              },
            };
            const requirement = informationRequirement(
              options.requireArtifactRole,
            );
            const inspection =
              intent === "metadata-refresh"
                ? await workflow.refreshMetadata({
                    selection: {
                      version: "asset-refresh-selection/1",
                      subjects: [
                        {
                          subjectId: target,
                          explanations: [{ path: ["cli", target] }],
                        },
                      ],
                      filesystemScopes: [],
                    },
                    informationRequirement: requirement,
                    ...callbacks,
                  })
                : await workflow.scanObservedScope({
                    registrationId: target,
                    relativeScope: options.scope ?? ".",
                    acceptTrusted,
                    informationRequirement: requirement,
                    ...callbacks,
                  });
            runtime.streams.stdout.write(
              renderInspection(inspection, options.json === true),
            );
            wroteInspection = true;
            if (
              inspection.execution.outcome === "failed" ||
              inspection.execution.outcome === "partially-succeeded"
            ) {
              refreshCommand.error(
                `error: ${inspection.execution.reason ?? "refresh failed"}`,
                {
                  exitCode: 1,
                  code: "cli.asset-refresh.failed",
                },
              );
            }
          } catch (error) {
            if (error instanceof CommanderError) throw error;
            const reason = errorMessage(error);
            if (options.json === true && !wroteInspection)
              runtime.streams.stdout.write(renderStructuredFailure(reason));
            refreshCommand.error(`error: ${errorMessage(error)}`, {
              exitCode: 1,
              code: "cli.asset-refresh.failed",
            });
          }
        },
      );
  }

  command
    .command("source-inputs")
    .description("列出当前产品支持的明确来源输入要求。")
    .option("--json", "输出机器可读结果")
    .action((options: { readonly json?: boolean }) => {
      const requirements = resources.assetRefresh().sourceInputRequirements();
      runtime.streams.stdout.write(
        options.json === true
          ? `${JSON.stringify(requirements)}\n`
          : requirements
              .map(
                (source) =>
                  `${source.displayName} (${source.sourceIdentity})\n${source.fields
                    .map(
                      (field) =>
                        `  ${field.key}: ${field.acceptedInput}${field.required ? "（必填）" : ""}`,
                    )
                    .join("\n")}`,
              )
              .join("\n"),
      );
    });

  const enrichSourceCommand = command
    .command("enrich-source")
    .description("给一个已确认内容补充明确来源。")
    .argument("<asset-id>", "内容编号")
    .argument("<source-identity>", "来源标识")
    .argument("<source-input-json>", "按来源要求提供的 JSON 对象")
    .option("--json", "输出机器可读结果")
    .action(
      async (
        assetId: string,
        sourceIdentity: string,
        sourceInputJson: string,
        options: { readonly json?: boolean },
      ) => {
        let sourceInput: unknown;
        try {
          sourceInput = JSON.parse(sourceInputJson) as unknown;
        } catch {
          enrichSourceCommand.error("error: 来源输入必须是 JSON 对象", {
            exitCode: 1,
            code: "cli.source-enrichment.invalid-input",
          });
        }
        if (
          typeof sourceInput !== "object" ||
          sourceInput === null ||
          Array.isArray(sourceInput) ||
          !Object.values(sourceInput).every((item) => typeof item === "string")
        )
          enrichSourceCommand.error("error: 来源输入必须是字符串字段对象", {
            exitCode: 1,
            code: "cli.source-enrichment.invalid-input",
          });
        const workflow = resources.assetRefresh();
        let wroteInspection = false;
        try {
          const inspection = await workflow.enrichSource({
            subjectId: assetId,
            sourceIdentity,
            sourceInput: sourceInput as Readonly<Record<string, string>>,
            informationRequirement: cliAssetViewInformationRequirement,
            onExecutionStarted(execution) {
              runtime.streams.stderr.write(`刷新记录：${execution.id}\n`);
            },
            onProgress(message) {
              runtime.streams.stderr.write(`${message}\n`);
            },
          });
          runtime.streams.stdout.write(
            renderInspection(inspection, options.json === true),
          );
          wroteInspection = true;
          if (inspection.execution.outcome === "failed")
            enrichSourceCommand.error(
              `error: ${inspection.execution.reason ?? "source enrichment failed"}`,
              { exitCode: 1, code: "cli.source-enrichment.failed" },
            );
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          const reason = errorMessage(error);
          if (options.json === true && !wroteInspection)
            runtime.streams.stdout.write(renderStructuredFailure(reason));
          enrichSourceCommand.error(`error: ${reason}`, {
            exitCode: 1,
            code: "cli.source-enrichment.failed",
          });
        }
      },
    );

  const sourceDecision = command
    .command("source-decision")
    .description("准备一项点名来源关联的建立、更换或撤回。")
    .argument("<intent>", "establish、replace 或 retract")
    .argument("<asset-id>", "内容编号")
    .argument("<source-or-association-id>", "来源标识或 predecessor 关联编号")
    .argument("<input-or-reason>", "来源输入 JSON 或撤回原因")
    .requiredOption("--actor <actor-id>", "发起者标识")
    .option("--json", "输出机器可读结果")
    .action(
      async (
        intent: string,
        assetId: string,
        sourceOrAssociationId: string,
        inputOrReason: string,
        options: { readonly actor: string; readonly json?: boolean },
      ) => {
        try {
          const workflow = resources.assetRefresh();
          const started = (execution: { readonly id: string }) =>
            runtime.streams.stderr.write(`刷新记录：${execution.id}\n`);
          let inspection;
          if (intent === "retract")
            inspection = await workflow.prepareRetraction({
              assetId,
              predecessorAssociationId: sourceOrAssociationId,
              initiatedBy: options.actor,
              reason: inputOrReason,
              onExecutionStarted: started,
            });
          else {
            const parsed = JSON.parse(inputOrReason) as unknown;
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed) ||
              !Object.values(parsed).every((item) => typeof item === "string")
            )
              throw new Error("来源输入必须是字符串字段对象");
            inspection =
              intent === "establish"
                ? await workflow.prepareConflictedEstablishment({
                    assetId,
                    sourceIdentity: sourceOrAssociationId,
                    sourceInput: parsed as Readonly<Record<string, string>>,
                    initiatedBy: options.actor,
                    onExecutionStarted: started,
                  })
                : intent === "replace"
                  ? await workflow.prepareReplacement({
                      assetId,
                      predecessorAssociationId: sourceOrAssociationId,
                      sourceInput: parsed as Readonly<Record<string, string>>,
                      initiatedBy: options.actor,
                      onExecutionStarted: started,
                    })
                  : undefined;
          }
          if (inspection === undefined)
            throw new Error(
              "来源关联决定意图必须是 establish、replace 或 retract",
            );
          runtime.streams.stdout.write(
            `${JSON.stringify(inspection, null, options.json === true ? 0 : 2)}\n`,
          );
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          sourceDecision.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.source-decision.failed",
          });
        }
      },
    );

  const inspectSourceDecision = command
    .command("inspect-source-decision")
    .argument("<execution-id>", "执行编号")
    .option("--json", "输出机器可读结果")
    .action(
      async (executionId: string, options: { readonly json?: boolean }) => {
        const inspection = await resources
          .assetRefresh()
          .inspectSourceAssociationDecision(executionId);
        if (inspection === undefined)
          inspectSourceDecision.error("error: 未找到来源关联决定", {
            exitCode: 1,
            code: "cli.source-decision.not-found",
          });
        runtime.streams.stdout.write(
          `${JSON.stringify(inspection, null, options.json === true ? 0 : 2)}\n`,
        );
      },
    );

  const inspectCorrectionSubject = command
    .command("inspect-correction-subject")
    .argument("<asset-id>", "稳定内容编号")
    .option("--json", "输出机器可读结果")
    .action(async (assetId: string, options: { readonly json?: boolean }) => {
      const inspection = await resources
        .assetRefresh()
        .inspectCorrectionSubject(assetId);
      if (inspection === undefined)
        inspectCorrectionSubject.error("error: 未找到可更正内容", {
          exitCode: 1,
          code: "cli.correction-subject.not-found",
        });
      runtime.streams.stdout.write(
        `${JSON.stringify(inspection, null, options.json === true ? 0 : 2)}\n`,
      );
    });

  const selectSourceDecision = command
    .command("select-source-candidate")
    .argument("<execution-id>", "执行编号")
    .argument("<candidate-reference>", "候选引用")
    .option("--json", "输出机器可读结果")
    .action(
      async (
        executionId: string,
        candidateReference: string,
        options: { readonly json?: boolean },
      ) => {
        try {
          if (candidateReference.trim().length === 0)
            throw new Error("候选引用不能为空");
          const inspection = await resources
            .assetRefresh()
            .selectSourceAssociationCandidate({
              executionId,
              candidateReference,
            });
          runtime.streams.stdout.write(
            `${JSON.stringify(inspection, null, options.json === true ? 0 : 2)}\n`,
          );
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          selectSourceDecision.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.source-decision.select-failed",
          });
        }
      },
    );

  const retrySourceDecision = command
    .command("retry-source-decision")
    .argument("<execution-id>", "已终止执行编号")
    .option("--json", "输出机器可读结果")
    .action(
      async (executionId: string, options: { readonly json?: boolean }) => {
        try {
          const inspection = await resources
            .assetRefresh()
            .retrySourceAssociationDecision({
              executionId,
              onExecutionStarted(execution) {
                runtime.streams.stderr.write(`刷新记录：${execution.id}\n`);
              },
            });
          runtime.streams.stdout.write(
            `${JSON.stringify(inspection, null, options.json === true ? 0 : 2)}\n`,
          );
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          retrySourceDecision.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.source-decision.retry-failed",
          });
        }
      },
    );

  const retractIdentity = command
    .command("retract-identity")
    .argument("<asset-id>", "内容编号")
    .argument("<decision-id>", "当前识别决定编号")
    .argument("<reason>", "撤回原因")
    .requiredOption("--actor <actor-id>", "提议者标识")
    .option("--json", "输出机器可读结果")
    .action(
      async (
        assetId: string,
        decisionId: string,
        reason: string,
        options: { readonly actor: string; readonly json?: boolean },
      ) => {
        try {
          const preview = await resources
            .assetRefresh()
            .prepareRecognitionRetraction({
              assetId,
              predecessorDecisionId: decisionId,
              proposedBy: options.actor,
              reason,
              onExecutionStarted(execution) {
                runtime.streams.stderr.write(`刷新记录：${execution.id}\n`);
              },
            });
          runtime.streams.stdout.write(
            renderChangeImpactPreview(preview, options.json === true),
          );
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          retractIdentity.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.identity-retraction.failed",
          });
        }
      },
    );

  const scrapeSourceCommand = command
    .command("scrape-source")
    .description("按来源公布的输入要求定向识别一个文件范围。")
    .argument("<observed-root-id>", "已登记的文件位置编号")
    .argument("<source-identity>", "来源标识")
    .argument("<source-input-json>", "按来源要求提供的 JSON 对象")
    .option("--scope <relative-path>", "登记根内的有限相对范围", ".")
    .option("--json", "输出机器可读结果")
    .action(
      async (
        observedRootId: string,
        sourceIdentity: string,
        sourceInputJson: string,
        options: { readonly scope?: string; readonly json?: boolean },
      ) => {
        try {
          const sourceInput = JSON.parse(sourceInputJson) as unknown;
          if (
            typeof sourceInput !== "object" ||
            sourceInput === null ||
            Array.isArray(sourceInput) ||
            !Object.values(sourceInput).every(
              (item) => typeof item === "string",
            )
          )
            throw new Error("来源输入必须是字符串字段对象");
          const inspection = await resources
            .assetRefresh()
            .directedRecognitionSourceInputObservedScope({
              registrationId: observedRootId,
              relativeScope: options.scope ?? ".",
              sourceIdentity,
              sourceInput: sourceInput as Readonly<Record<string, string>>,
              informationRequirement: cliAssetViewInformationRequirement,
            });
          runtime.streams.stdout.write(
            renderInspection(inspection, options.json === true),
          );
          if (inspection.execution.outcome === "failed")
            scrapeSourceCommand.error(
              `error: ${inspection.execution.reason ?? "scrape failed"}`,
              { exitCode: 1, code: "cli.source-scrape.failed" },
            );
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          scrapeSourceCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.source-scrape.failed",
          });
        }
      },
    );

  const rescrapeCommand = command
    .command("rescrape")
    .description("按来源公布的输入要求重新刮削并生成身份变更预演。")
    .argument("<observed-root-id>", "已登记的文件位置编号")
    .argument("<source-identity>", "来源标识")
    .argument("<source-input-json>", "按来源要求提供的 JSON 对象")
    .option("--scope <relative-path>", "登记根内的有限相对范围", ".")
    .requiredOption("--subject-id <subjectId>", "当前精确主体标识")
    .option("--require-artifact-role <roles...>", "要求本次获取指定产物用途")
    .option("--json", "输出临时机器可读结果")
    .action(
      async (
        observedRootId: string,
        sourceIdentity: string,
        sourceInputJson: string,
        options: {
          readonly json?: boolean;
          readonly subjectId: string;
          readonly requireArtifactRole?: readonly string[];
          readonly scope?: string;
        },
      ) => {
        let wroteInspection = false;
        try {
          const sourceInput = JSON.parse(sourceInputJson) as unknown;
          if (
            typeof sourceInput !== "object" ||
            sourceInput === null ||
            Array.isArray(sourceInput) ||
            !Object.values(sourceInput).every(
              (item) => typeof item === "string",
            )
          )
            throw new Error("来源输入必须是字符串字段对象");
          const workflow = resources.assetRefresh();
          const inspection = await workflow.rescrapeObservedScope({
            subjectId: options.subjectId,
            registrationId: observedRootId,
            relativeScope: options.scope ?? ".",
            sourceIdentity,
            sourceInput: sourceInput as Readonly<Record<string, string>>,
            informationRequirement: informationRequirement(
              options.requireArtifactRole,
            ),
            onExecutionStarted(execution) {
              runtime.streams.stderr.write(`刷新记录：${execution.id}\n`);
            },
            onProgress(message) {
              runtime.streams.stderr.write(`${message}\n`);
            },
          });
          runtime.streams.stdout.write(
            renderInspection(inspection, options.json === true),
          );
          wroteInspection = true;
          if (
            inspection.execution.outcome === "failed" ||
            inspection.execution.outcome === "partially-succeeded"
          ) {
            rescrapeCommand.error(
              `error: ${inspection.execution.reason ?? "rescrape failed"}`,
              { exitCode: 1, code: "cli.asset-refresh.rescrape-failed" },
            );
          }
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          const reason = errorMessage(error);
          if (options.json === true && !wroteInspection)
            runtime.streams.stdout.write(renderStructuredFailure(reason));
          rescrapeCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.asset-refresh.rescrape-failed",
          });
        }
      },
    );

  const previewCommand = command
    .command("show-preview")
    .description("检查已保存的身份变更影响预演。")
    .argument("<preview-id>", "预演标识")
    .option("--json", "输出临时机器可读结果")
    .action(async (previewId: string, options: { readonly json?: boolean }) => {
      const workflow = resources.assetRefresh();
      const preview = await workflow.inspectChangeImpactPreview(previewId);
      if (preview === undefined) {
        previewCommand.error("error: 未找到变更影响预演", {
          exitCode: 1,
          code: "cli.asset-refresh.preview-not-found",
        });
        return;
      }
      runtime.streams.stdout.write(
        renderChangeImpactPreview(preview, options.json === true),
      );
    });

  const applyPreviewCommand = command
    .command("apply-preview")
    .description("确认并应用已保存的身份变更影响预演。")
    .argument("<preview-id>", "预演标识")
    .requiredOption("--actor <actor-id>", "确认者标识")
    .option("--json", "输出临时机器可读结果")
    .action(
      async (
        previewId: string,
        options: { readonly actor: string; readonly json?: boolean },
      ) => {
        try {
          const workflow = resources.assetRefresh();
          const result = await workflow.applyChangeImpactPreview({
            previewId,
            confirmedBy: options.actor,
          });
          const preview = await workflow.inspectChangeImpactPreview(previewId);
          if (preview === undefined)
            throw new Error("应用后未找到变更影响预演");
          runtime.streams.stdout.write(
            renderChangeImpactPreview(preview, options.json === true),
          );
          if (result.status === "stale") {
            applyPreviewCommand.error("error: 变更影响预演已过期，未应用", {
              exitCode: 1,
              code: "cli.asset-refresh.apply-preview-stale",
            });
          }
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          applyPreviewCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.asset-refresh.apply-preview-failed",
          });
        }
      },
    );

  const rejectPreviewCommand = command
    .command("reject-preview")
    .description("拒绝已保存的身份变更影响预演。")
    .argument("<preview-id>", "预演标识")
    .requiredOption("--actor <actor-id>", "拒绝者标识")
    .option("--json", "输出临时机器可读结果")
    .action(
      async (
        previewId: string,
        options: { readonly actor: string; readonly json?: boolean },
      ) => {
        try {
          const workflow = resources.assetRefresh();
          const preview = await workflow.rejectChangeImpactPreview({
            previewId,
            rejectedBy: options.actor,
          });
          runtime.streams.stdout.write(
            renderChangeImpactPreview(preview, options.json === true),
          );
          if (preview.status === "stale") {
            rejectPreviewCommand.error("error: 变更影响预演已过期，未拒绝", {
              exitCode: 1,
              code: "cli.asset-refresh.reject-preview-stale",
            });
          }
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          rejectPreviewCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.asset-refresh.reject-preview-failed",
          });
        }
      },
    );

  const inspectCommand = command
    .command("inspect")
    .description("检查已保存的刷新记录。")
    .argument("<execution-id>", "刷新记录标识")
    .option("--json", "输出临时机器可读结果")
    .action(
      async (executionId: string, options: { readonly json?: boolean }) => {
        try {
          const workflow = resources.assetRefresh();
          const inspection = await workflow.inspect(executionId);
          if (inspection === undefined) {
            inspectCommand.error(`error: 未找到刷新记录 ${executionId}`, {
              exitCode: 1,
              code: "cli.asset-refresh.not-found",
            });
            return;
          }
          runtime.streams.stdout.write(
            renderInspection(inspection, options.json === true),
          );
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          inspectCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.asset-refresh.inspect-failed",
          });
        }
      },
    );
  const resumeCommand = command
    .command("resume")
    .description("继续一个在持久检查点中断的刷新记录。")
    .argument("<execution-id>", "刷新记录标识")
    .option("--json", "输出临时机器可读结果")
    .action(
      async (executionId: string, options: { readonly json?: boolean }) => {
        try {
          const workflow = resources.assetRefresh();
          const inspection = await workflow.resume({
            executionId,
            onProgress(message) {
              runtime.streams.stderr.write(`${message}\n`);
            },
          });
          runtime.streams.stdout.write(
            renderInspection(inspection, options.json === true),
          );
          if (
            inspection.execution.outcome === "failed" ||
            inspection.execution.outcome === "partially-succeeded"
          ) {
            resumeCommand.error(
              `error: ${inspection.execution.reason ?? "refresh failed"}`,
              { exitCode: 1, code: "cli.asset-refresh.resume-failed" },
            );
          }
        } catch (error) {
          if (error instanceof CommanderError) throw error;
          resumeCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.asset-refresh.resume-failed",
          });
        }
      },
    );
  const rawSourceCommand = command
    .command("inspect-source")
    .description("技术诊断：显式读取已保留的原始官方记录。")
    .argument("<execution-id>", "刷新记录标识")
    .argument("<source-record-id>", "来源记录标识")
    .requiredOption("--raw", "确认输出原始记录内容")
    .action(async (executionId: string, sourceRecordId: string) => {
      try {
        const workflow = resources.assetRefresh();
        const source = await workflow.inspectRawSourceRecord(
          executionId,
          sourceRecordId,
        );
        if (source === undefined) {
          rawSourceCommand.error("error: 未找到来源记录", {
            exitCode: 1,
            code: "cli.asset-refresh.source-not-found",
          });
          return;
        }
        runtime.streams.stdout.write(`${source.body}\n`);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        rawSourceCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.asset-refresh.inspect-source-failed",
        });
      }
    });

  const automationEnableCommand = command
    .command("automation-enable")
    .description("启用固定间隔自动刷新，并执行首次普通资产刷新。")
    .argument("<observed-root-id>", "已登记的文件位置编号")
    .option("--scope <relative-path>", "登记根内的有限相对范围", ".")
    .requiredOption("--interval-ms <milliseconds>", "固定刷新间隔（毫秒）")
    .option("--json", "输出临时机器可读结果")
    .action(
      async (
        observedRootId: string,
        options: {
          readonly intervalMs: string;
          readonly json?: boolean;
          readonly scope?: string;
        },
      ) => {
        try {
          const workflow = resources.assetRefresh();
          const enabled = await workflow.enableAutomation({
            observedRootId,
            relativeScope: options.scope ?? ".",
            intervalMilliseconds: Number(options.intervalMs),
            acceptTrusted: true,
          });
          runtime.streams.stdout.write(
            options.json === true
              ? `${JSON.stringify({
                  format: "temporary-automation-intent/v1",
                  unstable: true,
                  intent: enabled.intent,
                  initial: enabled.initial,
                })}\n`
              : `自动刷新：${enabled.intent.id}\n状态：已启用\n间隔：${enabled.intent.intervalMilliseconds} 毫秒\n`,
          );
        } catch (error) {
          automationEnableCommand.error(`error: ${errorMessage(error)}`, {
            exitCode: 1,
            code: "cli.automation.enable-failed",
          });
        }
      },
    );

  const automationDisableCommand = command
    .command("automation-disable")
    .description("停用后续自动触发；不取消正在运行的刷新。")
    .argument("<intent-id>", "自动刷新标识")
    .action(async (intentId: string) => {
      try {
        const workflow = resources.assetRefresh();
        await workflow.disableAutomation(intentId);
        runtime.streams.stdout.write(`自动刷新：${intentId}\n状态：已停用\n`);
      } catch (error) {
        automationDisableCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.automation.disable-failed",
        });
      }
    });

  const automationScanNowCommand = command
    .command("automation-scan-now")
    .description("立即通过同一资产刷新工作流执行一次自动刷新。")
    .argument("<intent-id>", "自动刷新标识")
    .option("--json", "输出临时机器可读结果")
    .action(async (intentId: string, options: { readonly json?: boolean }) => {
      try {
        const workflow = resources.assetRefresh();
        const result = await workflow.triggerAutomation(intentId, "scan-now");
        if (result.status === "started") {
          runtime.streams.stdout.write(
            renderInspection(result.execution, options.json === true),
          );
        } else {
          runtime.streams.stdout.write(
            `${result.status === "disabled" ? "已停用" : "已跳过"}：${result.reason}\n`,
          );
        }
      } catch (error) {
        automationScanNowCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.automation.scan-now-failed",
        });
      }
    });

  const automationHostCommand = command
    .command("automation-host")
    .description("启动固定间隔自动刷新宿主，直到收到进程停止信号。")
    .option("--poll-ms <milliseconds>", "轮询间隔（毫秒）", "1000")
    .action(async (options: { readonly pollMs: string }) => {
      const host = await resources.automationHost({
        pollIntervalMilliseconds: Number(options.pollMs),
        onError(error) {
          runtime.streams.stderr.write(
            `自动刷新轮询失败：${errorMessage(error)}\n`,
          );
        },
      });
      try {
        await host.start();
        runtime.streams.stderr.write("自动刷新宿主：已启动\n");
        if (runtime.waitForShutdown === undefined) {
          throw new Error("当前运行环境没有提供停止信号");
        }
        await runtime.waitForShutdown();
      } catch (error) {
        automationHostCommand.error(`error: ${errorMessage(error)}`, {
          exitCode: 1,
          code: "cli.automation.host-failed",
        });
      } finally {
        host.stop();
        runtime.streams.stderr.write("自动刷新宿主：已停止\n");
      }
    });
  return command;
}

export async function runCli(
  runtime: CliRuntime,
  application: CliProductApplication,
): Promise<number> {
  const resources = new CliResources(application);
  try {
    await createCliCommand(runtime, resources).parseAsync([...runtime.argv], {
      from: "node",
    });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    runtime.streams.stderr.write(`error: 操作未完成：${errorMessage(error)}\n`);
    return 1;
  } finally {
    await resources.close();
  }
}

async function runFormalOfflineRestore(
  runtime: CliRuntime,
  backupDirectory: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@digital/db-migrations",
        "offline-restore",
        "--",
        backupDirectory,
      ],
      {
        cwd: runtime.cwd,
        env: {
          ...process.env,
          ...runtime.env,
          DIGITAL_PRODUCT_DATA: configuredProductDataDirectory(runtime),
        },
        stdio: "ignore",
      },
    );
    child.once("error", () => reject(new Error("无法启动正式离线恢复命令")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("正式离线恢复命令失败；恢复未完成"));
    });
  });
}

function configuredProductDataDirectory(runtime: CliRuntime): string {
  const directory = runtime.env.DIGITAL_PRODUCT_DATA?.trim();
  if (!directory) throw new Error("尚未配置产品数据目录");
  return directory;
}
