import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("正式单机 Compose 部署合同", () => {
  it("拒绝把本地机密、agent-local 与教学资料带入 Web Docker context", async () => {
    const dockerignore = await readFile(
      path.join(repositoryRoot, "apps/web/Dockerfile.dockerignore"),
      "utf8",
    );
    const requiredRules = [
      ".scratch/",
      ".agents/",
      "AGENTS.md",
      "GLOSSARY*.md",
      "docs/",
      ".env*",
      "MISSION.md",
      "RESOURCES.md",
      "lessons/",
      "reference/",
      "learning-records/",
      "assets/",
    ];

    for (const rule of requiredRules) {
      expect(dockerignore.split(/\r?\n/u), rule).toContain(rule);
    }
  });

  it("把迁移与 start-only Web 分开，并声明非 root、绝对容器路径、只读观察根和 readiness 健康检查", async () => {
    const compose = await readFile(
      path.join(repositoryRoot, "docker-compose.yml"),
      "utf8",
    );

    expect(compose).toMatch(/^\s*migrate:\s*$/mu);
    expect(compose).toMatch(/^\s*web:\s*$/mu);
    expect(compose).toMatch(/condition:\s*service_completed_successfully/u);
    expect(compose).toMatch(/target:\s*standalone/u);
    expect(compose).toMatch(/target:\s*runtime/u);
    expect(compose).toMatch(/user:\s*["']?\$\{DIGITAL_UID/u);
    expect(compose).toContain("/data");
    expect(compose).toContain("/observed/media");
    expect(compose).toMatch(/read_only:\s*true/u);
    expect(compose).toMatch(/create_host_path:\s*false/u);
    expect(compose).toMatch(/\/api\/ready/u);
    expect(compose).not.toMatch(
      /DIGITAL_HOST_PATH|HOST_TO_CONTAINER|path mapping/iu,
    );
  });

  it("把真实 Compose 场景验证纳入正式 deployment gate", async () => {
    const packageJson = await readFile(
      path.join(repositoryRoot, "apps/web/package.json"),
      "utf8",
    );
    const manifest = JSON.parse(packageJson) as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    expect(manifest.scripts.deployment).toContain(
      "check-compose-deployment.ts",
    );
  });
});
