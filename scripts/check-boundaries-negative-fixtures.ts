import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkSourceEdges } from "./boundary-source-edges.ts";

const root = await mkdtemp(path.join(tmpdir(), "digital-boundary-fixture-"));
try {
  const application = path.join(root, "packages", "application");
  const domain = path.join(root, "packages", "domain");
  const config = path.join(root, "packages", "config");
  const testSupport = path.join(root, "packages", "test-support");
  const dlsite = path.join(root, "packages", "dlsite");
  const fanbox = path.join(root, "packages", "fanbox");
  const sqlite = path.join(root, "packages", "sqlite");
  const aliasFixture = path.join(root, "packages", "alias-fixture");
  const delivery = path.join(root, "apps", "delivery");
  for (const directory of [
    application,
    domain,
    config,
    testSupport,
    dlsite,
    fanbox,
    sqlite,
    aliasFixture,
    delivery,
  ]) {
    await mkdir(path.join(directory, "src"), { recursive: true });
  }
  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: { "@digital/domain": "workspace:*" },
    }),
  );
  await writeFile(
    path.join(domain, "package.json"),
    JSON.stringify({ name: "@digital/domain" }),
  );
  await writeFile(
    path.join(config, "package.json"),
    JSON.stringify({ name: "@digital/config", tsconfig: "tsconfig.json" }),
  );
  await writeFile(
    path.join(testSupport, "package.json"),
    JSON.stringify({ name: "@digital/test-support" }),
  );
  await writeFile(
    path.join(dlsite, "package.json"),
    JSON.stringify({
      name: "@digital/dlsite",
      dependencies: {
        "@digital/application": "workspace:*",
        "@digital/fanbox": "workspace:*",
      },
    }),
  );
  await writeFile(
    path.join(fanbox, "package.json"),
    JSON.stringify({ name: "@digital/fanbox" }),
  );
  await writeFile(
    path.join(sqlite, "package.json"),
    JSON.stringify({ name: "@digital/sqlite" }),
  );
  await writeFile(
    path.join(aliasFixture, "package.json"),
    JSON.stringify({
      name: "@digital/alias-fixture",
      dependencies: { "@digital/domain": "workspace:*" },
    }),
  );
  await writeFile(
    path.join(delivery, "package.json"),
    JSON.stringify({
      name: "@digital/delivery",
      dependencies: {
        "@digital/application": "workspace:*",
        "@digital/dlsite": "workspace:*",
      },
    }),
  );
  const paths = new Map([
    ["@digital/application", "packages/application"],
    ["@digital/domain", "packages/domain"],
    ["@digital/config", "packages/config"],
    ["@digital/test-support", "packages/test-support"],
    ["@digital/dlsite", "packages/dlsite"],
    ["@digital/fanbox", "packages/fanbox"],
    ["@digital/sqlite", "packages/sqlite"],
    ["@digital/alias-fixture", "packages/alias-fixture"],
    ["@digital/delivery", "apps/delivery"],
  ]);
  const tags = new Map([
    ["@digital/application", ["application"]],
    ["@digital/domain", ["domain"]],
    ["@digital/config", ["domain"]],
    ["@digital/test-support", ["test-support"]],
    ["@digital/dlsite", ["integration"]],
    ["@digital/fanbox", ["integration"]],
    ["@digital/sqlite", ["infrastructure"]],
    ["@digital/alias-fixture", ["application"]],
    ["@digital/delivery", ["delivery"]],
  ]);
  const check = async () =>
    await checkSourceEdges({
      packagePaths: paths,
      packageTags: tags,
      workspaceRoot: root,
    });

  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "@digital/domain";',
  );
  assert.deepEqual(await check(), []);

  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "@digital/domain";\nimport "@digital/delivery";',
  );
  assert.match(
    (await check()).join("\n"),
    /undeclared workspace source import/u,
  );
  assert.match((await check()).join("\n"), /forbidden source import/u);

  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "@digital/test-support";',
  );
  assert.match(
    (await check()).join("\n"),
    /forbidden source import @digital\/test-support/u,
  );

  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "../../../packages/domain/src/index.ts";',
  );
  assert.match((await check()).join("\n"), /forbidden source import/u);

  await writeFile(
    path.join(dlsite, "src", "index.ts"),
    'import "@digital/fanbox";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/dlsite: forbidden source import @digital\/fanbox/u,
  );

  await writeFile(path.join(dlsite, "src", "index.ts"), "");
  await writeFile(
    path.join(delivery, "src", "index.ts"),
    'import "@digital/dlsite";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/delivery: forbidden source import @digital\/dlsite/u,
  );

  await writeFile(path.join(delivery, "src", "index.ts"), "");

  // These fixtures deliberately resolve through aliases rather than a
  // package-looking specifier. They exercise the same source-edge check that
  // CI runs, so aliases cannot make an architectural edge invisible.
  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: { "@digital/domain": "workspace:*" },
      imports: {
        "#edge": "#workspace/delivery",
        "#workspace/*": {
          types: "@digital/*",
          default: "@digital/*",
        },
      },
    }),
  );
  await writeFile(path.join(application, "src", "index.ts"), 'import "#edge";');
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: forbidden source import #edge .* to @digital\/delivery/u,
  );
  assert.match(
    (await check()).join("\n"),
    /undeclared workspace source import #edge/u,
  );

  await writeFile(
    path.join(domain, "tsconfig.json"),
    JSON.stringify({ extends: "./tsconfig.aliases.json" }),
  );
  await writeFile(
    path.join(domain, "tsconfig.aliases.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "#domain-edge": ["#cross/application"],
          "#cross/*": ["../*/src/schema.ts"],
        },
      },
    }),
  );
  await writeFile(path.join(application, "src", "schema.ts"), "export {};\n");
  await writeFile(
    path.join(domain, "src", "index.ts"),
    'import "#domain-edge";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/domain: forbidden source import #domain-edge .* to @digital\/application/u,
  );

  await writeFile(
    path.join(dlsite, "package.json"),
    JSON.stringify({
      name: "@digital/dlsite",
      dependencies: {
        "@digital/application": "workspace:*",
        "@digital/fanbox": "workspace:*",
      },
      imports: { "#via-path": "#workspace/fanbox" },
    }),
  );
  await writeFile(
    path.join(dlsite, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "#workspace/*": ["@digital/*"] },
      },
    }),
  );
  await writeFile(path.join(dlsite, "src", "index.ts"), 'import "#via-path";');
  assert.match(
    (await check()).join("\n"),
    /@digital\/dlsite: forbidden source import #via-path .* to @digital\/fanbox/u,
  );

  await writeFile(
    path.join(delivery, "package.json"),
    JSON.stringify({
      name: "@digital/delivery",
      dependencies: {
        "@digital/application": "workspace:*",
        "@digital/dlsite": "workspace:*",
      },
      imports: { "#delivery-edge": "#dlsite-source" },
    }),
  );
  await writeFile(
    path.join(delivery, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "#dlsite-source": ["../../packages/dlsite/src/schema.ts"],
        },
      },
    }),
  );
  await writeFile(path.join(dlsite, "src", "schema.ts"), "export {};\n");
  await writeFile(
    path.join(delivery, "src", "index.ts"),
    'import "#delivery-edge";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/delivery: forbidden source import #delivery-edge .* to @digital\/dlsite/u,
  );

  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: { "@digital/domain": "workspace:*" },
      imports: {
        "#cycle-a": "#cycle-b",
        "#cycle-b": "#cycle-a",
        "#workspace/*": {
          types: "@digital/*",
          default: "@digital/*",
        },
      },
    }),
  );
  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "#cycle-a";',
  );
  await writeFile(path.join(domain, "src", "index.ts"), "");
  await writeFile(path.join(dlsite, "src", "index.ts"), "");
  await writeFile(path.join(delivery, "src", "index.ts"), "");
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: unresolvable source alias cycle #cycle-a/u,
  );

  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "#workspace/domain";',
  );
  assert.deepEqual(await check(), []);

  // A TypeScript path can cross a package boundary through a real pnpm/npm
  // symlink even though its lexical path remains inside this package.
  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: { "catalogue-db": "workspace:@digital/sqlite@*" },
    }),
  );
  await writeFile(path.join(sqlite, "src", "schema.ts"), "export {};\n");
  await mkdir(path.join(application, "node_modules"), { recursive: true });
  await symlink(
    sqlite,
    path.join(application, "node_modules", "catalogue-db"),
    "dir",
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        paths: { "#db": ["./node_modules/catalogue-db/src/schema.ts"] },
        target: "es2023",
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(path.join(application, "src", "index.ts"), 'import "#db";');
  const symlinkPathCompile = spawnSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--project",
      path.join(application, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(
    symlinkPathCompile.status,
    0,
    symlinkPathCompile.stderr || symlinkPathCompile.stdout,
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: forbidden source import #db .* to @digital\/sqlite; cross-package imports must use declared package exports/u,
  );
  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "../node_modules/catalogue-db/src/schema.ts";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: forbidden source import \.\.\/node_modules\/catalogue-db\/src\/schema\.ts .* to @digital\/sqlite; cross-package imports must use declared package exports/u,
  );

  await writeFile(path.join(application, "src", "self.ts"), "export {};\n");
  await symlink(
    application,
    path.join(application, "node_modules", "self-source"),
    "dir",
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        paths: {
          "#self": ["./node_modules/self-source/src/self.ts"],
        },
        target: "es2023",
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(path.join(application, "src", "index.ts"), 'import "#self";');
  assert.deepEqual(await check(), []);

  await symlink(
    path.join(root, "missing-catalogue-db"),
    path.join(application, "node_modules", "broken-source"),
    "dir",
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "#broken": ["./node_modules/broken-source/src/schema.ts"],
        },
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "#broken";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: unresolvable source path #broken .* broken symlink/u,
  );

  await symlink(
    "cycle-source",
    path.join(application, "node_modules", "cycle-source"),
    "dir",
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "#cycle": ["./node_modules/cycle-source/src/schema.ts"],
        },
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "#cycle";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: unresolvable source path #cycle .* symlink cycle/u,
  );

  // A bare tsconfig extends entry follows the owning package's dependency
  // alias through its real node_modules layout. TypeScript accepts this
  // setup, so the source-edge checker must see the inherited SQLite path too.
  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: { "config-base": "workspace:@digital/domain@*" },
    }),
  );
  await writeFile(
    path.join(domain, "package.json"),
    JSON.stringify({
      name: "@digital/domain",
      dependencies: { "config-middle": "npm:@digital/config@1.2.3" },
      tsconfig: "tsconfig.json",
    }),
  );
  await writeFile(
    path.join(config, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { paths: { "#db": ["../sqlite/src/schema.ts"] } },
    }),
  );
  await writeFile(
    path.join(domain, "tsconfig.json"),
    JSON.stringify({
      extends: "config-middle",
    }),
  );
  await writeFile(path.join(sqlite, "src", "schema.ts"), "export {};\n");
  await mkdir(path.join(application, "node_modules"), { recursive: true });
  await symlink(
    domain,
    path.join(application, "node_modules", "config-base"),
    "dir",
  );
  await mkdir(path.join(domain, "node_modules"), { recursive: true });
  await symlink(
    config,
    path.join(domain, "node_modules", "config-middle"),
    "dir",
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      extends: "config-base",
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        target: "es2023",
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(path.join(application, "src", "index.ts"), 'import "#db";');
  const configAliasCompile = spawnSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--project",
      path.join(application, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(
    configAliasCompile.status,
    0,
    configAliasCompile.stderr || configAliasCompile.stdout,
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: forbidden source import #db .* to @digital\/sqlite; cross-package imports must use declared package exports/u,
  );

  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: {
        "config-cycle-a": "workspace:config-cycle-b@*",
        "config-cycle-b": "npm:config-cycle-a@1.2.3",
      },
    }),
  );
  await symlink(
    domain,
    path.join(application, "node_modules", "config-cycle-a"),
    "dir",
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      extends: "config-cycle-a/tsconfig.json",
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        target: "es2023",
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(path.join(application, "src", "index.ts"), 'import "#db";');
  const cyclicConfigAliasCompile = spawnSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--project",
      path.join(application, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(
    cyclicConfigAliasCompile.status,
    0,
    cyclicConfigAliasCompile.stderr || cyclicConfigAliasCompile.stdout,
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: unresolvable tsconfig dependency alias cycle config-cycle-a\/tsconfig\.json/u,
  );

  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: { "config-base": "workspace:@digital/domain@*" },
    }),
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      extends: "config-base",
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        target: "es2023",
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(
    path.join(domain, "tsconfig.json"),
    JSON.stringify({
      extends: "config-middle",
    }),
  );
  await writeFile(
    path.join(config, "package.json"),
    JSON.stringify({ name: "@digital/config", tsconfig: "tsconfig.json" }),
  );
  await writeFile(
    path.join(config, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: { "#domain": ["@digital/domain"] },
      },
    }),
  );
  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "#domain";',
  );
  assert.deepEqual(await check(), []);

  await writeFile(
    path.join(config, "package.json"),
    JSON.stringify({
      name: "@digital/config",
      dependencies: { "config-back": "workspace:@digital/domain@*" },
      tsconfig: "tsconfig.json",
    }),
  );
  await mkdir(path.join(config, "node_modules"), { recursive: true });
  await symlink(
    domain,
    path.join(config, "node_modules", "config-back"),
    "dir",
  );
  await writeFile(
    path.join(config, "tsconfig.json"),
    JSON.stringify({ extends: "config-back" }),
  );
  await writeFile(path.join(application, "src", "index.ts"), "");
  assert.match(
    (await check()).join("\n"),
    /@digital\/config: unresolvable tsconfig extends cycle config-back/u,
  );

  await writeFile(
    path.join(config, "package.json"),
    JSON.stringify({ name: "@digital/config", tsconfig: "tsconfig.json" }),
  );
  await writeFile(
    path.join(config, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: { "#db": ["../sqlite/src/schema.ts"] },
      },
    }),
  );

  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: {
        "config-base": "workspace:config-middle@*",
        "config-middle": "npm:@digital/domain@1.2.3",
      },
    }),
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({
      extends: "config-base/tsconfig.json",
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        target: "es2023",
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(
    path.join(domain, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: { "#db": ["../sqlite/src/schema.ts"] },
      },
    }),
  );
  await writeFile(path.join(application, "src", "index.ts"), 'import "#db";');
  const chainedConfigAliasCompile = spawnSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--project",
      path.join(application, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(
    chainedConfigAliasCompile.status,
    0,
    chainedConfigAliasCompile.stderr || chainedConfigAliasCompile.stdout,
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: forbidden source import #db .* to @digital\/sqlite; cross-package imports must use declared package exports/u,
  );

  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      name: "@digital/application",
      dependencies: { "@digital/domain": "workspace:*" },
    }),
  );
  await writeFile(path.join(application, "src", "index.ts"), "");

  // Dependency aliases must resolve to their real workspace package before
  // both source-edge and persistence checks run. These are the pnpm/npm
  // spellings that package manifests expose, across every dependency field.
  await writeFile(
    path.join(aliasFixture, "package.json"),
    JSON.stringify({
      name: "@digital/alias-fixture",
      dependencies: {
        "workspace-sqlite": "workspace:@digital/sqlite@*",
      },
      devDependencies: {
        "npm-sqlite": "npm:@digital/sqlite@1.2.3",
      },
      optionalDependencies: {
        "optional-sqlite": "workspace:@digital/sqlite@^1.2.3",
      },
      peerDependencies: {
        "peer-sqlite": "npm:@digital/sqlite@~1.2.3",
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "src", "index.ts"),
    [
      'import "workspace-sqlite";',
      'import "npm-sqlite";',
      'import "optional-sqlite";',
      'import "peer-sqlite";',
    ].join("\n"),
  );
  const dependencyAliasFailures = (await check()).join("\n");
  for (const alias of [
    "workspace-sqlite",
    "npm-sqlite",
    "optional-sqlite",
    "peer-sqlite",
  ]) {
    assert.match(
      dependencyAliasFailures,
      new RegExp(
        `@digital/alias-fixture: forbidden persistence implementation import ${alias}`,
        "u",
      ),
    );
  }
  assert.doesNotMatch(
    dependencyAliasFailures,
    /undeclared workspace source import (workspace-sqlite|npm-sqlite|optional-sqlite|peer-sqlite)/u,
  );

  // A package import can hide the alias key too: resolve it recursively
  // before deciding whether the application imports persistence.
  await writeFile(
    path.join(aliasFixture, "package.json"),
    JSON.stringify({
      name: "@digital/alias-fixture",
      dependencies: {
        "catalogue-db": "workspace:@digital/sqlite@*",
      },
      imports: { "#db": "catalogue-db" },
    }),
  );
  await writeFile(path.join(aliasFixture, "src", "index.ts"), 'import "#db";');
  const importedDependencyAliasFailures = (await check()).join("\n");
  assert.match(
    importedDependencyAliasFailures,
    /@digital\/alias-fixture: forbidden persistence implementation import #db/u,
  );
  assert.doesNotMatch(
    importedDependencyAliasFailures,
    /undeclared workspace source import #db/u,
  );

  await writeFile(
    path.join(aliasFixture, "package.json"),
    JSON.stringify({
      name: "@digital/alias-fixture",
      dependencies: {
        "sqlite-first": "workspace:sqlite-second@*",
        "sqlite-second": "npm:@digital/sqlite@1.2.3",
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "src", "index.ts"),
    'import "sqlite-first";',
  );
  const dependencyChainFailures = (await check()).join("\n");
  assert.match(
    dependencyChainFailures,
    /@digital\/alias-fixture: forbidden persistence implementation import sqlite-first/u,
  );
  assert.doesNotMatch(
    dependencyChainFailures,
    /undeclared workspace source import sqlite-first/u,
  );

  await writeFile(
    path.join(aliasFixture, "package.json"),
    JSON.stringify({
      name: "@digital/alias-fixture",
      dependencies: {
        "sqlite-cycle-a": "workspace:sqlite-cycle-b@*",
        "sqlite-cycle-b": "npm:sqlite-cycle-a@1.2.3",
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "src", "index.ts"),
    'import "sqlite-cycle-a";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/alias-fixture: unresolvable source alias cycle sqlite-cycle-a/u,
  );

  await writeFile(
    path.join(aliasFixture, "package.json"),
    JSON.stringify({
      name: "@digital/alias-fixture",
      dependencies: {
        "domain-alias": "workspace:@digital/domain@*",
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "src", "index.ts"),
    'import "domain-alias";',
  );
  assert.deepEqual(await check(), []);

  // TypeScript applies multiple extends entries from left to right: the
  // latter effective config wins, and an owner's own paths wins last.
  await writeFile(
    path.join(aliasFixture, "tsconfig.precedence-a.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "#precedence": ["@digital/sqlite"] },
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "tsconfig.precedence-b.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "#precedence": ["@digital/domain"] },
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "tsconfig.json"),
    JSON.stringify({
      extends: ["./tsconfig.precedence-a.json", "./tsconfig.precedence-b.json"],
    }),
  );
  await writeFile(
    path.join(aliasFixture, "src", "index.ts"),
    'import "#precedence";',
  );
  assert.deepEqual(await check(), []);

  // A later extends entry can also hide a direct cross-package source path.
  // This mirrors a second-base configuration which supplies the SQLite map.
  await writeFile(
    path.join(aliasFixture, "tsconfig.base-compiler.json"),
    JSON.stringify({ compilerOptions: { baseUrl: "." } }),
  );
  await writeFile(
    path.join(aliasFixture, "tsconfig.base-db.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "#db": ["../sqlite/src/schema.ts"] },
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "tsconfig.json"),
    JSON.stringify({
      extends: ["./tsconfig.base-compiler.json", "./tsconfig.base-db.json"],
    }),
  );
  await writeFile(path.join(aliasFixture, "src", "index.ts"), 'import "#db";');
  assert.match(
    (await check()).join("\n"),
    /@digital\/alias-fixture: forbidden source import #db .* to @digital\/sqlite; cross-package imports must use declared package exports/u,
  );

  await writeFile(
    path.join(aliasFixture, "tsconfig.precedence-b.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "#precedence": ["@digital/sqlite"] },
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "tsconfig.json"),
    JSON.stringify({
      extends: ["./tsconfig.precedence-a.json", "./tsconfig.precedence-b.json"],
      compilerOptions: {
        baseUrl: ".",
        paths: { "#precedence": ["@digital/domain"] },
      },
    }),
  );
  await writeFile(
    path.join(aliasFixture, "src", "index.ts"),
    'import "#precedence";',
  );
  assert.deepEqual(await check(), []);

  await writeFile(
    path.join(application, "src", "index.ts"),
    'import "drizzle-orm/node-sqlite";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/application: forbidden persistence implementation import drizzle-orm\/node-sqlite/u,
  );

  await writeFile(path.join(application, "src", "index.ts"), "");
  await mkdir(path.join(delivery, "server"), { recursive: true });
  await writeFile(
    path.join(delivery, "server", "catalogue.ts"),
    'import "node:sqlite";',
  );
  assert.match(
    (await check()).join("\n"),
    /@digital\/delivery: forbidden persistence implementation import node:sqlite/u,
  );

  // Each case invokes the same top-level formal command used by CI rather
  // than a test-local inspection. Vue SFCs are intentional: scripts and
  // templates must both remain inside the renderer membrane.
  await assertFormalRendererRejected({
    label: "an aliased fetch global",
    cardBody: "const send = fetch;\nvoid send;",
    expected: /forbidden renderer effect global symbol fetch/u,
  });

  await assertFormalRendererRejected({
    label: "an action re-exported through an allowed UI path",
    cardImports: 'import { Button } from "#/components/ui/button";',
    cardTemplate: "<Button />",
    expected:
      /not a display component|outside display closure|forbidden renderer dependency/u,
    files: [
      {
        path: "apps/web/components/ui/button/index.ts",
        source: 'export { sendAction as Button } from "#/lib/catalogue";',
      },
      {
        path: "apps/web/lib/catalogue.ts",
        source: "export const sendAction = () => undefined;",
      },
    ],
  });

  await assertFormalRendererRejected({
    label: "a computed browser global in a template",
    cardTemplate: '{{ self["XML" + "HttpRequest"] }}',
    expected: /template: forbidden renderer effect global symbol self/u,
  });

  await assertFormalRendererRejected({
    label: "an injected template global",
    cardTemplate: '{{ $fetch("/assets") }}',
    expected: /template reads forbidden renderer context \$fetch/u,
  });

  await assertFormalRendererRejected({
    label: "a native form that posts a renderer subject",
    cardTemplate:
      '<form :action="`/api/refresh/${asset.id}`" method="post" enctype="text/plain"></form>',
    expected: /forbidden native template action form/u,
  });

  await assertFormalRendererRejected({
    label: "a native form-control submission override",
    cardTemplate: '<button formaction="/api/refresh">Refresh</button>',
    expected: /forbidden native template action formaction/u,
  });

  await assertFormalRendererRejected({
    label: "a native form action attribute",
    cardTemplate: '<form action="/api/refresh"></form>',
    expected: /forbidden native template action action/u,
  });

  await assertFormalRendererRejected({
    label: "a native form method attribute",
    cardTemplate: '<form method="post"></form>',
    expected: /forbidden native template action method/u,
  });

  await assertFormalRendererRejected({
    label: "a native form encoding attribute",
    cardTemplate: '<form enctype="text/plain"></form>',
    expected: /forbidden native template action enctype/u,
  });

  await assertFormalRendererRejected({
    label: "an embedded native document",
    cardTemplate: '<iframe srcdoc="<form></form>"></iframe>',
    expected: /forbidden native template action iframe/u,
  });

  await assertFormalRendererRejected({
    label: "an iframe document source",
    cardTemplate: '<iframe srcdoc="<form></form>"></iframe>',
    expected: /forbidden native template action srcdoc/u,
  });

  await assertFormalRendererRejected({
    label: "an embedded object document",
    cardTemplate: '<object data="/api/refresh"></object>',
    expected: /forbidden native template action object/u,
  });

  await assertFormalRendererRejected({
    label: "an embedded plugin document",
    cardTemplate: '<embed src="/api/refresh">',
    expected: /forbidden native template action embed/u,
  });

  await assertFormalRendererRejected({
    label: "raw HTML from the renderer projection",
    cardTemplate: '<div v-html="asset.id"></div>',
    expected: /forbidden native template action v-html/u,
  });

  await assertFormalRendererRejected({
    label: "a native inline event handler",
    cardTemplate: "<button onclick=\"fetch('/api/refresh')\">Refresh</button>",
    expected: /forbidden native template action inline handler/u,
  });

  await assertFormalRendererRejected({
    label: "a native Vue event handler",
    cardTemplate: '<button @click="asset.id">Refresh</button>',
    expected: /forbidden native template action inline handler/u,
  });

  await assertFormalRendererRejected({
    label: "a native dynamic attribute binding",
    cardTemplate:
      "<button v-bind=\"{ formaction: '/api/refresh' }\">Refresh</button>",
    expected: /forbidden native template action dynamic attribute/u,
  });

  await assertFormalRendererRejected({
    label: "a dynamic component that materializes a form",
    cardTemplate:
      '<component is="form" :action="`/api/refresh/${asset.id}`"></component>',
    expected: /forbidden native template action dynamic component/u,
  });

  await assertFormalRendererRejected({
    label: "a root native image fulfillment URL",
    cardTemplate: '<img src="/api/catalogue">',
    expected: /forbidden root native URL attribute src/u,
  });

  await assertFormalRendererRejected({
    label: "a root native video URL channel",
    cardTemplate: '<video src="/api/catalogue" poster="/api/poster"></video>',
    expected: /forbidden root native URL attribute poster/u,
  });

  await assertFormalRendererRejected({
    label: "a root native anchor ping channel",
    cardTemplate: '<a href="/assets/example" ping="/api/catalogue">Open</a>',
    expected: /forbidden root native URL attribute ping/u,
  });

  await assertFormalRendererRejected({
    label: "an SVG native href channel",
    cardTemplate: '<svg><use href="/api/catalogue"></use></svg>',
    expected: /forbidden root native URL attribute href/u,
  });

  await assertFormalRendererRejected({
    label: "an SVG native xlink href channel",
    cardTemplate: '<svg><use xlink:href="/api/catalogue"></use></svg>',
    expected: /forbidden root native URL attribute xlink:href/u,
  });

  await assertFormalRendererRejected({
    label: "a native meta refresh channel",
    cardTemplate: '<meta http-equiv="refresh" content="0;url=/api/catalogue">',
    expected: /forbidden root native URL channel meta refresh/u,
  });

  await assertFormalRendererRejected({
    label: "a root native source set channel",
    cardTemplate: '<img srcset="/api/catalogue 1x">',
    expected: /forbidden root native URL attribute srcset/u,
  });

  await assertFormalRendererRejected({
    label: "a root native download channel",
    cardTemplate: '<a href="/assets/example" download>Download</a>',
    expected: /forbidden root native URL attribute download/u,
  });

  await assertFormalRendererAccepted({
    label: "the exact root card asset navigation",
    cardTemplate: '<a :href="`/assets/${asset.id}`">Open</a>',
  });

  await assertFormalRendererRejected({
    label: "a root native link outside the card route allowlist",
    cardTemplate: '<a :href="`/api/catalogue/${asset.id}`">Open</a>',
    expected: /forbidden root native URL attribute href/u,
  });

  await assertFormalRendererRejected({
    label: "another root native URL fetch channel",
    cardTemplate: '<table background="/api/catalogue"></table>',
    expected: /forbidden root native URL attribute background/u,
  });

  await assertFormalRendererAccepted({
    label: "root presentation and accessibility attributes",
    cardTemplate:
      '<article class="rounded" aria-label="asset" role="article" data-state="ready"></article>',
  });

  await assertFormalRendererRejected({
    label: "an audited Button polymorphic fulfillment URL",
    cardTemplate: '<a :href="`/assets/${asset.id}`">Open</a>',
    detailImports: 'import { Button } from "#/components/ui/button";',
    detailTemplate: '<Button as="a" href="/api/catalogue">Open</Button>',
    expected: /forbidden renderer component usage Button/u,
    files: await auditedButtonFixtureFiles(),
  });

  await assertFormalRendererRejected({
    label: "an audited Button dynamic fulfillment URL",
    cardTemplate: '<a :href="`/assets/${asset.id}`">Open</a>',
    detailImports: 'import { Button } from "#/components/ui/button";',
    detailTemplate:
      '<Button as="a" :href="`/api/catalogue/${asset.id}`">Open</Button>',
    expected: /forbidden renderer component usage Button/u,
    files: await auditedButtonFixtureFiles(),
  });

  await assertFormalRendererRejected({
    label: "an audited AssetCover arbitrary source URL",
    cardImports: 'import AssetCover from "./AssetCover.vue";',
    cardTemplate:
      '<a :href="`/assets/${asset.id}`"><AssetCover src="/api/catalogue" :title="asset.dlsite.title" placement="card" /></a>',
    expected: /forbidden renderer component usage AssetCover/u,
    files: await auditedAssetCoverFixtureFiles(),
  });

  await assertFormalRendererRejected({
    label: "an audited AssetCover dynamic source URL",
    cardImports: 'import AssetCover from "./AssetCover.vue";',
    cardTemplate:
      '<a :href="`/assets/${asset.id}`"><AssetCover :src="`/api/catalogue/${asset.id}`" :title="asset.dlsite.title" placement="card" /></a>',
    expected: /forbidden renderer component usage AssetCover/u,
    files: await auditedAssetCoverFixtureFiles(),
  });

  await assertFormalRendererRejected({
    label: "another allowed component with polymorphic URL props",
    detailImports: 'import { ExternalLink } from "@lucide/vue";',
    detailTemplate: '<ExternalLink as="a" href="/api/catalogue" />',
    expected: /forbidden renderer component usage ExternalLink/u,
  });

  await assertFormalRendererRejected({
    label: "another allowed component with a dynamic URL prop spread",
    detailImports: 'import { ExternalLink } from "@lucide/vue";',
    detailTemplate: "<ExternalLink v-bind=\"{ href: '/api/catalogue' }\" />",
    expected: /forbidden renderer component usage ExternalLink/u,
  });

  await assertFormalRendererRejected({
    label: "an AssetCover with the wrong placement",
    cardImports: 'import AssetCover from "./AssetCover.vue";',
    cardTemplate:
      '<a :href="`/assets/${asset.id}`"><AssetCover :src="asset.dlsite.cover" :title="asset.dlsite.title" placement="detail" /></a>',
    expected: /forbidden renderer component usage AssetCover/u,
    files: await auditedAssetCoverFixtureFiles(),
  });

  await assertFormalRendererAccepted({
    label: "the exact Card AssetCover usage",
    cardImports: 'import AssetCover from "./AssetCover.vue";',
    cardTemplate:
      '<a :href="`/assets/${asset.id}`"><AssetCover :src="asset.dlsite.cover" :title="asset.dlsite.title" placement="card" /></a>',
    files: await auditedAssetCoverFixtureFiles(),
  });

  await assertFormalRendererAccepted({
    label: "the exact Detail official-page Button usage",
    cardTemplate: '<a :href="`/assets/${asset.id}`">Open</a>',
    detailImports: 'import { Button } from "#/components/ui/button";',
    detailTemplate:
      '<Button v-if="asset.officialPage" as="a" :href="asset.officialPage" target="_blank" rel="noreferrer" variant="outline">Open</Button>',
    files: await auditedButtonFixtureFiles(),
  });

  await assertFormalRendererAccepted({
    label: "a Button component event over the renderer projection",
    detailImports: 'import { Button } from "#/components/ui/button";',
    detailTemplate: '<Button @click="asset.id">Refresh</Button>',
    files: await auditedButtonFixtureFiles(),
  });

  await assertFormalRendererAccepted({
    label: "a Card component event over the renderer projection",
    cardImports: 'import { Card } from "#/components/ui/card";',
    cardTemplate:
      '<a :href="`/assets/${asset.id}`"><Card @click="asset.id">Open</Card></a>',
    files: await auditedCardFixtureFiles(),
  });

  await assertFormalRendererRejected({
    label: "a dynamic import whose export is kept through an alias",
    cardBody:
      'const loadAction = import("#/lib/catalogue").then(({ sendAction }) => sendAction);\nvoid loadAction;',
    expected: /forbidden renderer effect dynamic import/u,
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

type RendererFixture = {
  readonly cardBody?: string;
  readonly cardImports?: string;
  readonly cardTemplate?: string;
  readonly detailBody?: string;
  readonly detailImports?: string;
  readonly detailTemplate?: string;
  readonly files?: readonly {
    readonly path: string;
    readonly source: string;
  }[];
};

async function auditedButtonFixtureFiles(): Promise<
  readonly { readonly path: string; readonly source: string }[]
> {
  const paths = [
    "components/ui/button/Button.vue",
    "components/ui/button/index.ts",
    "lib/utils.ts",
  ] as const;
  return await Promise.all(
    paths.map(async (relative) => ({
      path: path.join("apps", "web", relative),
      source: await readFile(
        path.join(process.cwd(), "apps", "web", relative),
        "utf8",
      ),
    })),
  );
}

async function auditedAssetCoverFixtureFiles(): Promise<
  readonly { readonly path: string; readonly source: string }[]
> {
  const relative = path.join("components", "formal", "AssetCover.vue");
  return [
    {
      path: path.join("apps", "web", relative),
      source: await readFile(
        path.join(process.cwd(), "apps", "web", relative),
        "utf8",
      ),
    },
  ];
}

async function auditedCardFixtureFiles(): Promise<
  readonly { readonly path: string; readonly source: string }[]
> {
  const paths = [
    "components/ui/card/Card.vue",
    "components/ui/card/CardAction.vue",
    "components/ui/card/CardContent.vue",
    "components/ui/card/CardDescription.vue",
    "components/ui/card/CardFooter.vue",
    "components/ui/card/CardHeader.vue",
    "components/ui/card/CardTitle.vue",
    "components/ui/card/index.ts",
    "lib/utils.ts",
  ] as const;
  return await Promise.all(
    paths.map(async (relative) => ({
      path: path.join("apps", "web", relative),
      source: await readFile(
        path.join(process.cwd(), "apps", "web", relative),
        "utf8",
      ),
    })),
  );
}

async function assertFormalRendererRejected(
  input: RendererFixture & {
    readonly expected: RegExp;
    readonly label: string;
  },
): Promise<void> {
  const rendererBoundary = await runFormalRendererBoundary(input);
  assert.notEqual(
    rendererBoundary.status,
    0,
    `the formal boundary command must reject ${input.label}`,
  );
  assert.match(rendererBoundary.output, input.expected, input.label);
}

async function assertFormalRendererAccepted(
  input: RendererFixture & { readonly label: string },
): Promise<void> {
  const rendererBoundary = await runFormalRendererBoundary(input);
  assert.equal(
    rendererBoundary.status,
    0,
    `the formal boundary command must accept ${input.label}: ${rendererBoundary.output}`,
  );
}

async function runFormalRendererBoundary(input: RendererFixture): Promise<{
  readonly output: string;
  readonly status: number | null;
}> {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "digital-renderer-boundary-fixture-"),
  );
  try {
    const rendererDirectory = path.join(
      fixtureRoot,
      "apps",
      "web",
      "components",
      "formal",
    );
    await mkdir(rendererDirectory, { recursive: true });
    await writeFile(
      path.join(rendererDirectory, "DlsiteAssetCard.vue"),
      cardRenderer(input),
    );
    await writeFile(
      path.join(rendererDirectory, "DlsiteAssetDetail.vue"),
      detailRenderer(input),
    );
    for (const file of input.files ?? []) {
      const target = path.join(fixtureRoot, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.source);
    }

    const rendererBoundary = spawnSync("pnpm", ["boundaries"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DIGITAL_RENDERER_BOUNDARY_ROOT: fixtureRoot,
      },
    });
    return {
      output: `${rendererBoundary.stdout}\n${rendererBoundary.stderr}`,
      status: rendererBoundary.status,
    };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function cardRenderer(input: RendererFixture): string {
  return `<script setup lang="ts">
import type { DlsiteCardRendererProjection } from "@digital/presentation/renderer-contracts";
${input.cardImports ?? ""}
defineProps<{ readonly asset: DlsiteCardRendererProjection }>();
${input.cardBody ?? ""}
</script>
<template>${input.cardTemplate ?? ""}</template>`;
}

function detailRenderer(input: RendererFixture): string {
  return `<script setup lang="ts">
import type { DlsiteDetailRendererProjection } from "@digital/presentation/renderer-contracts";
${input.detailImports ?? ""}
defineProps<{ readonly asset: DlsiteDetailRendererProjection }>();
${input.detailBody ?? ""}
</script>
<template>${input.detailTemplate ?? ""}</template>`;
}
