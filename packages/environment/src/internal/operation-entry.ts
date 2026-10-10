import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOperationCancellation,
  type OperationCancellation,
} from "./cancellation.ts";
import {
  deleteCrashResult,
  deleteInvalidPayload,
  runDeleteOperation,
} from "./delete-operation.ts";
import {
  parseOperationPayload,
  type OperationRequest,
  type OperationResult,
} from "./operation-contract.ts";
import { emit } from "./operation-support.ts";
import {
  prepareCrashResult,
  prepareInvalidPayload,
  runPrepareOperation,
} from "./prepare-operation.ts";
import { HeldCommands } from "./processes.ts";
import {
  rebuildCrashResult,
  rebuildInvalidPayload,
  runRebuildOperation,
} from "./rebuild-operation.ts";
import {
  runStartOperation,
  startCrashResult,
  startInvalidPayload,
} from "./start-operation.ts";
import {
  runStopOperation,
  stopCrashResult,
  stopInvalidPayload,
} from "./stop-operation.ts";

/** 操作种类由内核显式给出，载荷自身也必须声明同一种类。 */
const operationKinds = [
  "prepare",
  "start",
  "stop",
  "rebuild",
  "delete",
] as const;
type OperationKind = (typeof operationKinds)[number];

function invalidPayload(kind: OperationKind, message: string): OperationResult {
  if (kind === "prepare") return prepareInvalidPayload(message);
  if (kind === "start") return startInvalidPayload(message);
  if (kind === "rebuild") return rebuildInvalidPayload(message);
  if (kind === "delete") return deleteInvalidPayload(message);
  return stopInvalidPayload(message);
}

async function runOperation(
  request: OperationRequest,
  held: HeldCommands,
  cancellation: OperationCancellation,
): Promise<OperationResult> {
  if (request.kind === "prepare")
    return await runPrepareOperation(request, held, cancellation);
  if (request.kind === "start")
    return await runStartOperation(request, cancellation);
  if (request.kind === "rebuild")
    return await runRebuildOperation(request, held, cancellation);
  if (request.kind === "delete") return await runDeleteOperation(request, held);
  return await runStopOperation(request, cancellation);
}

async function crashResult(
  request: OperationRequest,
  error: unknown,
  held: HeldCommands,
): Promise<OperationResult> {
  if (request.kind === "prepare")
    return await prepareCrashResult(request, error, held);
  if (request.kind === "start") return startCrashResult(request, error);
  if (request.kind === "rebuild")
    return await rebuildCrashResult(request, error, held);
  if (request.kind === "delete")
    return await deleteCrashResult(request, error, held);
  return stopCrashResult(request, error);
}

function requestedKind(value: string | undefined): OperationKind | undefined {
  return operationKinds.find((kind) => kind === value);
}

async function main(): Promise<void> {
  const kind = requestedKind(process.argv[2]);
  if (kind === undefined) {
    emit(
      prepareInvalidPayload(
        "缺少受支持的操作种类（prepare、start、stop、rebuild 或 delete）",
      ),
    );
    process.exitCode = 78;
    return;
  }
  const payload = process.argv[3];
  if (payload === undefined) {
    emit(invalidPayload(kind, `缺少 ${kind} 载荷`));
    process.exitCode = 78;
    return;
  }
  const parsed = parseOperationPayload(payload);
  if ("reason" in parsed) {
    emit(invalidPayload(kind, parsed.reason));
    process.exitCode = 78;
    return;
  }
  if (parsed.request.kind !== kind) {
    emit(invalidPayload(kind, "载荷声明的操作种类与内核请求不符"));
    process.exitCode = 78;
    return;
  }
  const held = new HeldCommands();
  const cancellation = createOperationCancellation({
    deadlineAt: parsed.request.deadlineAt,
  });
  try {
    emit(await runOperation(parsed.request, held, cancellation));
  } catch (error) {
    // 走到这里说明操作内部没有形成结果。仍先真实收尾本次持有的子进程，再按实际
    // 收尾状态如实上报，绝不宣称完成。
    emit(await crashResult(parsed.request, error, held));
    process.exitCode = 70;
  } finally {
    cancellation.dispose();
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
