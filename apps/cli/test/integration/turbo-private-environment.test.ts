import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("root Turbo private integration environment", () => {
  it("passes credentials only to the live E2E task that needs them", async () => {
    const configuration = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, "../../../../turbo.json"),
        "utf8",
      ),
    ) as {
      readonly tasks?: {
        readonly "test:e2e"?: {
          readonly cache?: boolean;
          readonly passThroughEnv?: readonly string[];
        };
        readonly "test:e2e:tmdb-omdb-live"?: {
          readonly cache?: boolean;
          readonly dependsOn?: readonly string[];
          readonly passThroughEnv?: readonly string[];
        };
        readonly "test:e2e:bangumi-live"?: {
          readonly cache?: boolean;
          readonly dependsOn?: readonly string[];
          readonly passThroughEnv?: readonly string[];
        };
      };
    };

    expect("globalPassThroughEnv" in configuration).toBe(false);
    expect(configuration.tasks?.["test:e2e"]).toEqual({
      dependsOn: ["build"],
      cache: false,
      passThroughEnv: ["DIGITAL_TMDB_ACCESS_TOKEN", "DIGITAL_OMDB_API_KEY"],
    });
    expect(configuration.tasks?.["test:e2e:tmdb-omdb-live"]).toEqual({
      dependsOn: ["build"],
      cache: false,
      passThroughEnv: ["DIGITAL_TMDB_ACCESS_TOKEN", "DIGITAL_OMDB_API_KEY"],
    });
    expect(configuration.tasks?.["test:e2e:bangumi-live"]).toEqual({
      dependsOn: ["build"],
      cache: false,
      passThroughEnv: [
        "DIGITAL_BANGUMI_LIVE_PRODUCT_DATA",
        "DIGITAL_BANGUMI_CLIENT_ID",
        "DIGITAL_BANGUMI_CLIENT_SECRET",
        "DIGITAL_BANGUMI_REDIRECT_URI",
      ],
    });

    const cliPackage = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf8",
      ),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    expect(cliPackage.scripts?.["test:e2e:tmdb-omdb-live"]).toBe(
      "DIGITAL_E2E_JOURNEY=tmdb-omdb-live node --conditions=source test/e2e/run-journeys.ts source distribution",
    );
    expect(cliPackage.scripts?.["test:e2e:bangumi-live"]).toBe(
      "DIGITAL_E2E_JOURNEY=bangumi-episodic-live node --conditions=source test/e2e/run-journeys.ts source distribution",
    );
  });
});
