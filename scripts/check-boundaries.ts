import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { checkSourceEdges as checkActualSourceEdges } from "./boundary-source-edges.ts";
import { checkRendererBoundaries } from "./check-renderer-boundaries.ts";

const architecturalTags = new Set([
  "application",
  "composition",
  "delivery",
  "domain",
  "infrastructure",
  "integration",
  "presentation",
  "test-support",
  "tooling",
]);

const workspaceResult = spawnSync(
  "pnpm",
  ["exec", "turbo", "ls", "--output=json"],
  {
    encoding: "utf8",
  },
);

if (workspaceResult.error !== undefined) throw workspaceResult.error;
if (workspaceResult.status !== 0) {
  process.stderr.write(workspaceResult.stderr);
  process.exit(workspaceResult.status ?? 1);
}

const workspace = JSON.parse(workspaceResult.stdout) as {
  packages: {
    items: Array<{ name: string; path: string }>;
  };
};
const invalidPackages: string[] = [];
const packageTags = new Map<string, readonly string[]>();
const packagePaths = new Map<string, string>();

for (const packageEntry of workspace.packages.items) {
  const packageTurboUrl = new URL(
    `../${packageEntry.path}/turbo.json`,
    import.meta.url,
  );
  const packageTurbo = (await import(packageTurboUrl.href, {
    with: { type: "json" },
  })) as { default: { tags?: string[] } };
  const assignedArchitecturalTags = (packageTurbo.default.tags ?? []).filter(
    (tag) => architecturalTags.has(tag),
  );

  if (assignedArchitecturalTags.length !== 1) {
    invalidPackages.push(
      `${packageEntry.name} (${packageEntry.path}): expected exactly one architectural tag, found ${assignedArchitecturalTags.join(", ") || "none"}`,
    );
  }
  packageTags.set(packageEntry.name, assignedArchitecturalTags);
  packagePaths.set(packageEntry.name, packageEntry.path);
}

if (invalidPackages.length > 0) {
  process.stderr.write(`${invalidPackages.join("\n")}\n`);
  process.exit(1);
}

const deliveryDirectDependencyTags = new Set([
  "delivery",
  "presentation",
  "composition",
  "application",
  "domain",
  "test-support",
]);
const invalidDeliveryDependencies: string[] = [];

for (const [packageName, tags] of packageTags) {
  if (!tags.includes("delivery")) continue;
  const packagePath = packagePaths.get(packageName);
  if (packagePath === undefined) continue;
  const manifest = JSON.parse(
    await readFile(
      path.join(process.cwd(), packagePath, "package.json"),
      "utf8",
    ),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const dependencies = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
  ].flatMap((group) => Object.keys(group ?? {}));
  for (const dependency of dependencies) {
    const dependencyTags = packageTags.get(dependency);
    if (
      dependencyTags !== undefined &&
      !dependencyTags.some((tag) => deliveryDirectDependencyTags.has(tag))
    ) {
      invalidDeliveryDependencies.push(
        `${packageName}: direct dependency ${dependency} has forbidden tag ${dependencyTags.join(", ")}`,
      );
    }
  }
}

const sourceEdgeFailures = await checkActualSourceEdges({
  packagePaths,
  packageTags,
  workspaceRoot: process.cwd(),
});
const rendererBoundaryFailures = await checkRendererBoundaries();
if (
  invalidDeliveryDependencies.length > 0 ||
  sourceEdgeFailures.length > 0 ||
  rendererBoundaryFailures.length > 0
) {
  process.stderr.write(
    [
      ...invalidDeliveryDependencies,
      ...sourceEdgeFailures,
      ...rendererBoundaryFailures,
    ].join("\n") + "\n",
  );
  process.exit(1);
}

const boundaryResult = spawnSync(
  "pnpm",
  [
    "exec",
    "turbo",
    "boundaries",
    "--no-color",
    // Turbo 2.10.5 checks a delivery package against Composition's complete
    // adapter closure. That rejects the only permitted delivery entrypoint as
    // if it directly imported each adapter. Delivery packages are therefore
    // checked above against their direct workspace dependencies; every other
    // package remains under Turbo's strict tag rules here.
    ...[...packageTags]
      .filter(([, tags]) => tags.includes("delivery"))
      .map(([packageName]) => `--filter=!${packageName}`),
  ],
  {
    stdio: "inherit",
  },
);

if (boundaryResult.error !== undefined) throw boundaryResult.error;
process.exit(boundaryResult.status ?? 1);
