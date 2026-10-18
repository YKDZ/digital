import { lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyDataOwnership, type EnvironmentLayout } from "./paths.ts";
import {
  filteredEnvironment,
  runLoggedCommand,
  type CommandRun,
  type HeldCommands,
} from "./processes.ts";

const catalogueFileName = "catalogue.sqlite";
/**
 * 正式备份在取得维护准入之后才检查副本源，因此这一条完整拒绝同时交出两件事：本次正式入口
 * 确实运行到了副本复制阶段，且维护准入已经通过。只接受维护实现以固定错误前缀交出的完整拒绝；
 * pnpm 的命令、cwd 与模块载入诊断都不会以该行开头，因此不能伪造产品给出的准入结论。
 */
const incompleteCopyRefusal =
  "离线产品数据维护失败：备份源缺少产品 Catalogue；拒绝创建不完整副本";

export type OfflineAdmission =
  | { readonly offline: true }
  | { readonly ownResidue: true }
  | { readonly reason: string };

/**
 * 破坏性操作前的离线核验：通过正式产品维护入口走产品自己的维护租约准入。
 * 命令成功即确认没有管理器之外的活跃写入者（陈旧租约由产品自行回收）；其它非成功退出
 * 都如实报告为无法确认离线，绝不删除或改写租约来绕过占用，也绝不据此猜测占用者身份。
 *
 * 该核验只做租约准入与只读复制，不打开业务数据库，临时目录用完即删。唯一的例外分支是
 * `ownResidue`：本管理器自己的回收已经把自有数据根删到只剩残余，重入时正式备份只能判定
 * 副本源不完整，同一条显式命令必须能继续收敛，而不是被「备份前提」永久挡住。该分支只承认
 * 本次正式产品入口自己交出的结论——workspace 正式维护命令执行到产品实现、按产品自己的错误输出语法出现在
 * stderr 开头的完整目标拒绝，再加归属、持久意图与 catalogue 缺失三项文件系统事实。缺少维护
 * 命令缺失、维护包产物无法执行、pnpm 路径或载入诊断复现同一文字、真实活跃写入者、
 * 其它产品拒绝、未知归属与日志不完整一律回到拒绝。
 */
export async function assertProductRootOffline(input: {
  readonly layout: EnvironmentLayout;
  readonly inputs: readonly string[];
  /** 该环境已有持久破坏意图：残余只可能来自本管理器自己的回收。 */
  readonly continuationEligible: boolean;
  readonly logFile: string;
  readonly held: HeldCommands;
}): Promise<OfflineAdmission> {
  const root = await stat(input.layout.productDataRoot).catch(
    (error: unknown) => {
      const code =
        error instanceof Error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      return code === "ENOENT" ? ("absent" as const) : undefined;
    },
  );
  if (root === "absent") return { offline: true };
  if (root === undefined)
    return {
      reason: `无法核验产品数据根是否存在，不能确认离线：${input.layout.productDataRoot}`,
    };
  const scratch = await mkdtemp(
    path.join(tmpdir(), "digital-environment-offline-check-"),
  );
  try {
    const run = await runLoggedCommand({
      command: "pnpm",
      args: [
        "--silent",
        "run",
        "product:maintenance",
        "offline-backup",
        "--product-data",
        input.layout.productDataRoot,
        "--backup-directory",
        scratch,
      ],
      cwd: input.layout.workspacePath,
      env: filteredEnvironment(process.env),
      logFile: input.logFile,
      captureStderr: input.continuationEligible,
      secretValues: [],
      held: input.held,
    });
    if (run.spawnError !== undefined)
      return {
        reason: `正式产品维护命令无法启动：${run.spawnError}`,
      };
    if (run.exitCode === 0 && run.signal === null) {
      if (run.logFailure !== undefined)
        return {
          reason: `离线核验日志未能完整持久化，核验结论不可信：${run.logFailure.cause}`,
        };
      return { offline: true };
    }
    if (await isFormallyAdmittedOwnResidue(input, run))
      return { ownResidue: true };
    return {
      reason: `产品数据根存在管理器之外的活跃使用或离线核验未成功：退出码 ${String(
        run.exitCode,
      )} 信号 ${String(run.signal)}（详见 ${input.logFile}）`,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 判断本次非成功退出是否可确认「本管理器自己的回收已把自有根删成残余、而正式产品的维护
 * 准入确实通过」。全部证据都必须来自本次正式产品运行自身，任何一项不成立都按拒绝处理。
 */
async function isFormallyAdmittedOwnResidue(
  input: {
    readonly layout: EnvironmentLayout;
    readonly inputs: readonly string[];
    readonly continuationEligible: boolean;
  },
  run: CommandRun,
): Promise<boolean> {
  if (!input.continuationEligible) return false;
  // 只有自然结束的非成功退出才可能有产品自己交出的结论；被信号终止或日志不完整时不可信。
  if (run.signal !== null || run.exitCode === null || run.exitCode === 0)
    return false;
  if (run.logFailure !== undefined) return false;
  if (!handedOverIncompleteCopyRefusal(run.stderr)) return false;
  const ownership = await verifyDataOwnership(input.layout, input.inputs);
  if ("reason" in ownership) return false;
  const catalogue = await lstat(
    path.join(ownership.productDataRoot, catalogueFileName),
  ).catch(() => undefined);
  return catalogue === undefined;
}

/**
 * 产品交出的拒绝必须落在产品自己的错误输出语法里：子进程 stderr 的第一行就是完整目标拒绝，
 * 固定前缀由维护实现只在产品复制阶段交出；workspace 命令缺失、维护产物缺失或模块载入失败时，
 * stderr 由 pnpm/Node 的命令诊断开头。归属和 Catalogue 是否缺失另行核验，单独的路径错误不能授权。
 */
function handedOverIncompleteCopyRefusal(stderr: string | undefined): boolean {
  if (stderr === undefined) return false;
  const lines = stderr.split("\n").map((line) => line.replace(/\r$/u, ""));
  return lines[0] === incompleteCopyRefusal;
}
