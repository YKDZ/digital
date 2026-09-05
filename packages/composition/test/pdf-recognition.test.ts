import { mkdir, mkdtemp, rm, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteCatalogue } from "@digital/sqlite";
import { afterAll, expect, it, vi } from "vitest";

import { composeAssetRefresh } from "../src/runtime.ts";
import {
  disposePreparedCatalogueTemplate,
  preparedCatalogueRoot,
} from "./prepared-catalogue.ts";

afterAll(async () => {
  await disposePreparedCatalogueTemplate();
});

it("可信自动接受不会接受带有效 ISBN 的 PDF 反证提案", async () => {
  const productData = await preparedCatalogueRoot();
  const observed = await mkdtemp(path.join(tmpdir(), "digital-pdf-isbn-"));
  await writeFile(
    path.join(observed, "identified.pdf"),
    syntheticPdf({
      author: "Document Author",
      pageCount: 1,
      isbn: "9784049131291",
    }),
  );
  const workflow = composeAssetRefresh(productData, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "带 ISBN 的合成 PDF",
      containerPath: observed,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const result = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        relationshipTypes: [],
        artifactRoles: [],
      },
    });

    expect(result.itemResults).toMatchObject([
      {
        outcome: "proposal",
        recognition: { status: "proposed" },
      },
    ]);
    expect(result.itemResults![0]).not.toHaveProperty("accepted");

    const catalogue = SqliteCatalogue.forProductData(productData);
    try {
      const persisted = await catalogue.inspectExecution(result.execution.id);
      expect(persisted?.workItemInspections).toHaveLength(1);
      expect(persisted!.workItemInspections![0]!.accepted).toBeUndefined();
      expect(
        persisted!.workItemInspections![0]!.proposal!.ruleResults,
      ).toMatchObject([
        {
          capabilityId: "pdf.local-publication-recognizer",
          capabilityVersion: "1",
          ruleId: "pdf.valid-single-publication-revision",
          ruleVersion: "1",
          outcome: "contradicted",
          explanation: expect.stringContaining("唯一有效 ISBN"),
          evidence: [
            expect.objectContaining({
              inspection: expect.objectContaining({
                identifiers: [
                  {
                    scheme: "isbn-13",
                    value: "9784049131291",
                    locators: ["pdf:xmp/dc:identifier[1]"],
                  },
                ],
              }),
            }),
          ],
        },
      ]);
    } finally {
      catalogue.close();
    }
  } finally {
    await workflow.close();
    await rm(observed, { recursive: true, force: true });
    await rm(productData, { recursive: true, force: true });
  }
});

it("一个普通刷新把三个 PDF 文件识别为三个无来源本地资产", async () => {
  const productData = await preparedCatalogueRoot();
  const observed = await mkdtemp(path.join(tmpdir(), "digital-pdf-observed-"));
  await mkdir(path.join(observed, "nested"));
  await Promise.all([
    writeFile(
      path.join(observed, "one.pdf"),
      syntheticPdf({ author: "Document Author", pageCount: 1 }),
    ),
    writeFile(
      path.join(observed, "nested", "two.pdf"),
      syntheticPdf({ author: "Document Author", pageCount: 2 }),
    ),
    writeFile(
      path.join(observed, "nested", "three.pdf"),
      syntheticPdf({ author: "Document Author", pageCount: 3 }),
    ),
  ]);
  const workflow = composeAssetRefresh(productData, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "合成 PDF",
      containerPath: observed,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const result = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        relationshipTypes: [],
        artifactRoles: [
          {
            role: "asset.primary-cover",
            necessity: "required",
            maximum: 1,
          },
        ],
      },
    });

    expect(result.itemResults).toHaveLength(3);
    const accepted = result.itemResults!.map((item) => item.accepted!);
    expect(new Set(accepted.map((item) => item.entity.id))).toHaveProperty(
      "size",
      3,
    );
    for (const item of accepted) {
      expect(item).toMatchObject({
        entity: { kind: "digital-asset" },
        sourceAssociations: [],
        recognitionExplanation: expect.stringContaining("无有效 ISBN"),
        metadata: expect.arrayContaining([
          expect.objectContaining({
            property: "pdf.page-count",
            observedArtifactPart: expect.objectContaining({
              locator: "pdf:catalog/pages",
            }),
          }),
          expect.objectContaining({
            property: "pdf.document-author",
            value: "Document Author",
            observedArtifactPart: expect.objectContaining({
              locator: "pdf:info/Author",
            }),
          }),
        ]),
        artifactAssociations: expect.arrayContaining([
          expect.objectContaining({
            role: "asset.primary-cover",
            observedArtifactPart: expect.objectContaining({
              locator: "pdf:page[1]",
            }),
          }),
        ]),
      });
      expect(item).not.toHaveProperty("recognitionSourceAssociation");
      expect(item.metadata).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: "asset.title" }),
          expect.objectContaining({ property: "book.contributor" }),
        ]),
      );
      expect(item.relationships ?? []).toEqual([]);
    }
  } finally {
    await workflow.close();
    await rm(observed, { recursive: true, force: true });
    await rm(productData, { recursive: true, force: true });
  }
});

it("从上级检查 RJ 目录时台本与音轨属于同一音声，重扫不另建书籍", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-rj-boundary-"));
  await mkdir(path.join(media, "RJ01668691", "台本"), { recursive: true });
  await writeFile(
    path.join(media, "RJ01668691", "台本", "script.pdf"),
    syntheticPdf({ author: "Script Writer", pageCount: 1 }),
  );
  await writeFile(
    path.join(media, "RJ01668691", "track.wav"),
    new Uint8Array(44),
  );
  await writeFile(path.join(media, "notes.txt"), "没有明确身份的独立观察");
  vi.stubGlobal(
    "fetch",
    async (address: string) =>
      new Response(
        address.includes("ajax")
          ? JSON.stringify({
              RJ01668691: {
                site_id: "maniax",
                work_name: "雨夜的来信",
                regist_date: "2025-01-02",
              },
            })
          : "<html></html>",
        {
          headers: {
            "content-type": address.includes("ajax")
              ? "application/json"
              : "text/html",
          },
        },
      ),
  );
  const workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "音声目录",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const first = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const accepted =
      first.itemResults?.flatMap((item) =>
        item.accepted === undefined ? [] : [item.accepted],
      ) ?? [];
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.sourceAssociations).toEqual([
      expect.objectContaining({ sourceIdentity: "dlsite" }),
    ]);
    expect(accepted[0]?.artifactAssociations).toHaveLength(2);
    expect(
      accepted[0]?.locations
        .map((location) => path.basename(location.address))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["script.pdf", "track.wav"]);
    await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: "RJ01668691",
      acceptTrusted: true,
    });
    expect(await workflow.listCurrentCatalogue()).toHaveLength(1);
  } finally {
    await workflow.close();
    vi.unstubAllGlobals();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("人工把两个合法文档保留为一项内容，重扫不会覆盖人工范围或丢失格式事实", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-manual-pdf-"));
  await writeFile(
    path.join(media, "one.pdf"),
    syntheticPdf({ author: "One", pageCount: 1, title: "Document Title" }),
  );
  await writeFile(
    path.join(media, "two.pdf"),
    syntheticPdf({ author: "Two", pageCount: 2 }),
  );
  const workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "文档",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: false,
    });
    const review = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["one.pdf", "two.pdf"],
      name: "共同记录",
      classification: "book",
    });
    expect(review.content.artifactRevisions).toHaveLength(2);
    const saved = await workflow.confirmLocalContent({
      executionId: review.executionId,
    });
    expect((await workflow.listCurrentAttentionPage()).items).toEqual([]);
    const rescan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    expect(rescan.execution.outcome).toBe("no-change");
    const contents = await workflow.listCurrentCatalogue();
    expect(contents).toHaveLength(1);
    expect(contents[0]?.entity.id).toBe(saved.content.entity.id);
    expect(contents[0]?.artifactAssociations).toHaveLength(2);
    expect(contents[0]?.artifactRevisions).toHaveLength(2);
    expect(contents[0]?.effectiveMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "共同记录",
          sourceIdentity: "user",
        }),
      ]),
    );
    expect(
      contents[0]?.effectiveMetadata
        .filter((item) => item.property === "asset.title")
        .map((item) => item.value),
    ).toEqual(["共同记录"]);
    const previousFile = await stat(path.join(media, "one.pdf"));
    await writeFile(
      path.join(media, "one.pdf"),
      syntheticPdf({ author: "Six", pageCount: 1, title: "Document Title" }),
    );
    await utimes(
      path.join(media, "one.pdf"),
      previousFile.atime,
      previousFile.mtime,
    );
    const updated = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    expect(updated.execution.outcome).toBe("accepted");
    const [revised] = await workflow.listCurrentCatalogue();
    expect(revised?.entity.id).toBe(saved.content.entity.id);
    expect(revised?.artifactAssociations).toHaveLength(2);
    expect(
      revised?.effectiveMetadata
        .filter((item) => item.property === "pdf.document-author")
        .map((item) => item.value)
        .toSorted(),
    ).toEqual(["Six", "Two"]);
    expect(
      (
        await workflow.scanObservedScope({
          registrationId: root.id,
          relativeScope: ".",
          acceptTrusted: true,
        })
      ).execution.outcome,
    ).toBe("no-change");
    await rm(path.join(media, "one.pdf"));
    await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    const missing = await workflow.inspectLocalIntake({
      registrationId: root.id,
    });
    expect(missing.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "one.pdf",
          problem: expect.any(String),
        }),
      ]),
    );
    expect(missing.contents.map((item) => item.entity.id)).toEqual([
      saved.content.entity.id,
    ]);
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("确认时拒绝大小与修改时间不变但内容已变化的文档", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-changed-pdf-"));
  const file = path.join(media, "one.pdf");
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  const workflow = composeAssetRefresh(data, {});
  try {
    await writeFile(file, syntheticPdf({ author: "One", pageCount: 1 }));
    await utimes(file, timestamp, timestamp);
    const root = await workflow.observedRootRegistrations.create({
      displayName: "文档",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: false,
    });
    const review = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["one.pdf"],
    });
    await writeFile(file, syntheticPdf({ author: "Two", pageCount: 1 }));
    await utimes(file, timestamp, timestamp);
    await expect(
      workflow.confirmLocalContent({ executionId: review.executionId }),
    ).rejects.toThrow("所选文件已变化");
    expect(await workflow.listCurrentCatalogue()).toHaveLength(0);
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

function syntheticPdf(input: {
  readonly author: string;
  readonly pageCount: number;
  readonly isbn?: string;
  readonly title?: string;
}): Uint8Array {
  const xmp =
    input.isbn === undefined
      ? undefined
      : [
          '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
          '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">',
          `<dc:identifier>${input.isbn}</dc:identifier>`,
          "</rdf:Description></rdf:RDF>",
        ].join("");
  const metadataId = input.pageCount + 3;
  const infoId = metadataId + (xmp === undefined ? 0 : 1);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${xmp === undefined ? "" : ` /Metadata ${metadataId} 0 R`} >>`,
    `<< /Type /Pages /Kids [${Array.from({ length: input.pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${input.pageCount} >>`,
    ...Array.from(
      { length: input.pageCount },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>",
    ),
    ...(xmp === undefined
      ? []
      : [
          `<< /Type /Metadata /Subtype /XML /Length ${new TextEncoder().encode(xmp).byteLength} >>\nstream\n${xmp}\nendstream`,
        ]),
    `<< /Author (${input.author})${input.title === undefined ? "" : ` /Title (${input.title})`} >>`,
  ];
  let source = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}
