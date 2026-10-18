#!/usr/bin/env node

import path from "node:path";

import { prepareRestoredProductionCatalogue } from "@digital/db-migrations";
import {
  createOfflineProductDataBackup,
  restoreOfflineProductDataBackup,
} from "@digital/product-data";

type MaintenanceOptions = {
  readonly productDataDirectory: string;
  readonly backupDirectory: string;
};

function parseOptions(arguments_: readonly string[]): MaintenanceOptions {
  const [command, ...rest] = arguments_;
  if (command !== "offline-backup" && command !== "offline-restore")
    throw new Error(usage());

  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1]?.trim();
    if (
      (option !== "--product-data" && option !== "--backup-directory") ||
      value === undefined ||
      value.length === 0 ||
      options.has(option)
    ) {
      throw new Error(usage());
    }
    if (!path.isAbsolute(value)) throw new Error("维护路径必须是绝对路径");
    options.set(option, value);
  }

  const productDataDirectory = options.get("--product-data");
  const backupDirectory = options.get("--backup-directory");
  if (productDataDirectory === undefined || backupDirectory === undefined)
    throw new Error(usage());
  return { productDataDirectory, backupDirectory };
}

function usage(): string {
  return [
    "用法：",
    "  digital-product-maintenance offline-backup --product-data <产品数据绝对路径> --backup-directory <空备份绝对路径>",
    "  digital-product-maintenance offline-restore --backup-directory <备份绝对路径> --product-data <空产品数据绝对路径>",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const failures = [...error.errors].map(errorMessage).join("；");
    return failures.length === 0
      ? error.message
      : `${error.message}：${failures}`;
  }
  return error instanceof Error ? error.message : "未知维护失败";
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const options = parseOptions(process.argv.slice(2));
  if (command === "offline-backup") {
    await createOfflineProductDataBackup(options);
    process.stdout.write("离线备份完成。\n");
    return;
  }
  await restoreOfflineProductDataBackup({
    ...options,
    prepareProductionCatalogue: async (stage) => {
      await prepareRestoredProductionCatalogue(stage);
    },
  });
  process.stdout.write("离线恢复完成；正式迁移检查已通过。\n");
}

try {
  await main();
} catch (error) {
  process.stderr.write(`离线产品数据维护失败：${errorMessage(error)}\n`);
  process.exitCode = 1;
}
