import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const roots = new Set(["@digital/web", "@digital/db-migrations"]);
const manifests = new Map();
for (const group of ["apps", "packages"]) {
  for (const entry of await readdir(resolve(root, group))) {
    const directory = resolve(root, group, entry);
    try {
      const manifest = JSON.parse(
        await readFile(resolve(directory, "package.json"), "utf8"),
      );
      manifests.set(manifest.name, { directory, manifest });
    } catch {}
  }
}
const closure = new Set();
function visit(name) {
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
const built = new Set();
async function build(name) {
  if (built.has(name)) return;
  const item = manifests.get(name);
  for (const [dependency, version] of Object.entries(
    item.manifest.dependencies ?? {},
  )) {
    if (version === "workspace:*" && closure.has(dependency))
      await build(dependency);
  }
  // Docker 排除 `dist` 输出后，TypeScript 组合构建可能仍接受过期的构建信息文件。
  // 只移除当前包的构建信息，使成功构建总会实体化其声明输出。
  await rm(resolve(item.directory, "tsconfig.tsbuildinfo"), { force: true });
  await command("pnpm", ["--filter", name, "run", "build"]);
  const sourceDist = resolve(item.directory, "dist");
  const sourceExport = item.manifest.exports?.["."]?.default;
  if (!(await exists(sourceDist)) && !sourceExport?.startsWith("./src/")) {
    throw new Error(`${name} build 未生成 dist`);
  }
  built.add(name);
}
for (const name of roots) await build(name);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function command(command, args) {
  await new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? ok() : fail(new Error(`${command} failed: ${code}`)),
    );
  });
}
