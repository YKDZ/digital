import { spawn } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

type PackageManifest = {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports?: {
    readonly "."?: { readonly default?: string };
  };
};

type WorkspacePackage = {
  readonly directory: string;
  readonly manifest: PackageManifest;
};

const root = resolve(import.meta.dirname, "..");
const roots = new Set<string>(["@digital/web", "@digital/db-migrations"]);
const manifests = new Map<string, WorkspacePackage>();
for (const group of ["apps", "packages", "sources"]) {
  for (const entry of await readdir(resolve(root, group))) {
    const directory = resolve(root, group, entry);
    try {
      const manifest = JSON.parse(
        await readFile(resolve(directory, "package.json"), "utf8"),
      ) as PackageManifest;
      manifests.set(manifest.name, { directory, manifest });
    } catch {}
  }
}
const closure = new Set<string>();
function visit(name: string): void {
  if (closure.has(name)) return;
  const item = manifests.get(name);
  if (!item) throw new Error(`未知 workspace package: ${name}`);
  closure.add(name);
  for (const [dependency, version] of Object.entries(
    item.manifest.dependencies ?? {},
  )) {
    if (version === "workspace:*") visit(dependency);
  }
}
for (const name of roots) visit(name);
const built = new Set<string>();
async function build(name: string): Promise<void> {
  if (built.has(name)) return;
  const item = manifests.get(name);
  if (item === undefined) throw new Error(`未知 workspace package: ${name}`);
  for (const [dependency, version] of Object.entries(
    item.manifest.dependencies ?? {},
  )) {
    if (version === "workspace:*" && closure.has(dependency))
      await build(dependency);
  }
  // Docker 排除 `dist` 输出后，TypeScript 组合构建可能仍接受过期的构建信息文件。
  // 构建配置名决定默认构建信息文件名；移除它以确保重新实体化声明输出。
  await rm(resolve(item.directory, "tsconfig.build.tsbuildinfo"), {
    force: true,
  });
  await run("pnpm", ["--filter", name, "run", "build"]);
  const sourceDist = resolve(item.directory, "dist");
  const sourceExport = item.manifest.exports?.["."]?.default;
  if (!(await exists(sourceDist)) && !sourceExport?.startsWith("./src/")) {
    throw new Error(`${name} build 未生成 dist`);
  }
  built.add(name);
}
for (const name of roots) await build(name);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((ok, fail) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? ok() : fail(new Error(`${command} failed: ${code}`)),
    );
  });
}
