import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { realpath } from "node:fs/promises";
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
  // Composite TypeScript can accept a stale build-info file after Docker has
  // excluded its dist output. Remove only this package's build-info so a
  // successful build always materializes its declared output.
  await rm(resolve(item.directory, "tsconfig.tsbuildinfo"), { force: true });
  await command("pnpm", ["--filter", name, "run", "build"]);
  const sourceDist = resolve(item.directory, "dist");
  const sourceExport = item.manifest.exports?.["."]?.default;
  if (!(await exists(sourceDist)) && !sourceExport?.startsWith("./src/")) {
    throw new Error(`${name} build 未生成 dist`);
  }
  for (const consumerName of closure) {
    const consumer = manifests.get(consumerName);
    if (
      consumerName === name ||
      consumer.manifest.dependencies?.[name] !== "workspace:*"
    )
      continue;
    const link = resolve(
      consumer.directory,
      "node_modules",
      ...name.split("/"),
    );
    const target = await realpath(link);
    if (!target.includes("/node_modules/"))
      throw new Error(`${consumerName} 的 ${name} 不指向 node_modules`);
    const targetManifest = JSON.parse(
      await readFile(resolve(target, "package.json"), "utf8"),
    );
    if (
      targetManifest.name !== name ||
      targetManifest.version !== item.manifest.version
    )
      throw new Error(`${name} injected copy 身份不匹配`);
    if (!(await exists(sourceDist))) continue;
    await rm(resolve(target, "dist"), { recursive: true, force: true });
    await mkdir(resolve(target, "dist"), { recursive: true });
    await cp(sourceDist, resolve(target, "dist"), { recursive: true });
    if (!(await exists(resolve(target, "dist", "index.d.ts"))))
      throw new Error(`${name} injected copy 缺少 dist entry`);
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
