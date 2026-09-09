import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";

import { assertApprovedPdfOracleSlice } from "../e2e/journeys/pdf-publication-live.journey.ts";

it("PDF live journey 只接受已审核的本地格式 oracle 切片", async () => {
  const oracle = JSON.parse(
    await readFile(
      path.resolve(
        import.meta.dirname,
        "../../../..",
        ".scratch/acceptance-corpus/references/reviewed-oracle.json",
      ),
      "utf8",
    ),
  ) as {
    pdfPublications: Array<{ pageCount: number }>;
  };

  expect(() => assertApprovedPdfOracleSlice(oracle)).not.toThrow();
  oracle.pdfPublications[0]!.pageCount += 1;
  expect(() => assertApprovedPdfOracleSlice(oracle)).toThrow(
    "PDF reviewed oracle slice digest drifted",
  );
});
