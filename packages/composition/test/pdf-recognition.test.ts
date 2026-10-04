import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
      expect(persisted!.workItemInspections![0].accepted).toBeUndefined();
      expect(
        persisted!.workItemInspections![0].proposal!.ruleResults,
      ).toMatchObject([
        {
          capabilityId: "pdf.local-publication-recognizer",
          capabilityVersion: "2",
          ruleId: "pdf.valid-single-publication-revision",
          ruleVersion: "2",
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
      informationRequirement: {
        metadataUsageContext: "asset.ordinary",
        metadata: [],
        relationshipTypes: [],
        artifactRoles: [
          { role: "asset.material-image", necessity: "optional" },
        ],
      },
    });
    const accepted =
      first.itemResults?.flatMap((item) =>
        item.accepted === undefined ? [] : [item.accepted],
      ) ?? [];
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.sourceAssociations).toEqual([
      expect.objectContaining({ sourceIdentity: "dlsite" }),
    ]);
    expect(
      accepted[0]?.artifactAssociations.filter(
        (association) => association.role === "asset.primary-cover",
      ),
    ).toEqual([]);
    expect(
      accepted[0]?.artifactAssociations.filter(
        (association) => association.role === "asset.material-image",
      ),
    ).toEqual([
      expect.objectContaining({
        observedArtifactPart: expect.objectContaining({
          locator: "pdf:page[1]",
        }),
      }),
    ]);
    expect(accepted[0]?.artifactAssociations).toHaveLength(3);
    expect(
      accepted[0]?.locations
        .filter((location) => location.kind === "observed")
        .map((location) => path.basename(location.address))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["script.pdf", "track.wav"]);
    await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: "RJ01668691",
      acceptTrusted: true,
    });
    expect(await workflow.listCurrentCatalogue()).toHaveLength(1);
    const refreshed = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: accepted[0].entity.id,
            explanations: [{ path: ["test", "rj-directory"] }],
          },
        ],
        filesystemScopes: [],
      },
    });
    expect(refreshed.execution.outcome).toBe("accepted");
  } finally {
    await workflow.close();
    vi.unstubAllGlobals();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("无内嵌 ISBN 的已接受 PDF 经明确 NBINet 输入补来源，失败重开后可正式重试", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-pdf-enrichment-"));
  await writeFile(
    path.join(media, "manual.pdf"),
    syntheticPdf({ author: "Local Author", pageCount: 1 }),
  );
  let failTransport = true;
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (address: string) => {
    requested.push(address);
    if (failTransport) throw new Error("controlled network failure");
    return new Response(
      JSON.stringify({
        docs: [
          {
            pnx: {
              display: { title: ["明确来源书名"], creator: ["书目作者"] },
              addata: { isbn: ["9789864738281"] },
            },
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  let workflow = composeAssetRefresh(data, {});
  try {
    expect(workflow.sourceInputRequirements()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: "nbinet",
          fields: [expect.objectContaining({ key: "isbn", required: true })],
        }),
      ]),
    );
    const root = await workflow.observedRootRegistrations.create({
      displayName: "无 ISBN PDF",
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
      relativePaths: ["manual.pdf"],
      name: "本地书",
      classification: "book",
    });
    const accepted = await workflow.confirmLocalContent({
      executionId: review.executionId,
    });
    const assetId = accepted.content.entity.id;
    const before = await workflow.inspectCurrentCatalogueSubject(assetId);
    const failed = await workflow.enrichSource({
      subjectId: assetId,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "ISBN 978-986-473-828-1" },
    });
    expect(failed.execution).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("保持有效"),
    });
    expect(
      await workflow.inspectCurrentCatalogueSubject(assetId),
    ).toMatchObject({
      entity: { id: assetId },
      sourceAssociations: before!.sourceAssociations,
      artifacts: before!.artifacts,
      locations: before!.locations,
      recognitionExplanation: before!.recognitionExplanation,
    });

    await workflow.close();
    failTransport = false;
    workflow = composeAssetRefresh(data, {});
    await expect(workflow.inspect(failed.execution.id)).resolves.toMatchObject({
      execution: {
        outcome: "failed",
        acceptedAssetId: assetId,
        selection: { intent: "source-enrichment" },
      },
      sourceEnrichments: [
        {
          sourceIdentity: "nbinet",
          input: { isbn: "9789864738281" },
          status: "failed",
          canRetry: true,
        },
      ],
    });
    const competing = await Promise.all([
      workflow.enrichSource({
        subjectId: assetId,
        sourceIdentity: "nbinet",
        sourceInput: { isbn: "9789864738281" },
      }),
      workflow.enrichSource({
        subjectId: assetId,
        sourceIdentity: "nbinet",
        sourceInput: { isbn: "9789864738281" },
      }),
    ]);
    const competingOutcomes = competing.map((item) => item.execution.outcome);
    expect(
      competingOutcomes.filter((outcome) => outcome === "accepted"),
    ).toHaveLength(1);
    expect(competingOutcomes).toEqual(
      expect.arrayContaining([expect.stringMatching(/failed|no-change/u)]),
    );
    const enriched = await workflow.inspectCurrentCatalogueSubject(assetId);
    expect(enriched).toMatchObject({
      entity: { id: assetId },
      artifacts: before!.artifacts,
      locations: before!.locations,
      recognitionExplanation: before!.recognitionExplanation,
      sourceAssociations: [
        expect.objectContaining({
          sourceIdentity: "nbinet",
          nativeAddress: expect.stringContaining("9789864738281"),
        }),
      ],
      metadata: expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "明确来源书名",
        }),
      ]),
    });
    const requestsBeforeOrdinaryRefresh = requested.length;
    const refreshed = await workflow.refreshMetadata({
      selection: {
        version: "asset-refresh-selection/1",
        subjects: [
          {
            subjectId: assetId,
            explanations: [{ path: ["test", "current-source-only"] }],
          },
        ],
        filesystemScopes: [],
      },
    });
    expect(refreshed.execution.outcome).toBe("accepted");
    expect(requested).toHaveLength(requestsBeforeOrdinaryRefresh + 1);
    expect(requested.at(-1)).toContain("9789864738281");
    const repeated = await workflow.enrichSource({
      subjectId: assetId,
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "9789864738281" },
    });
    expect(repeated.execution.outcome).toBe("no-change");
    expect(requested).toHaveLength(requestsBeforeOrdinaryRefresh + 1);
  } finally {
    await workflow.close();
    vi.unstubAllGlobals();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("无内嵌 ISBN 的新 PDF 通过同一 NBINet 输入能力完成定向识别", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(
    path.join(tmpdir(), "digital-pdf-directed-isbn-"),
  );
  await writeFile(
    path.join(media, "new.pdf"),
    syntheticPdf({ author: "Local Author", pageCount: 1 }),
  );
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          docs: [
            {
              pnx: {
                display: { title: ["定向来源书名"] },
                addata: { isbn: ["9789864738281"] },
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "新 PDF",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const result = await workflow.directedRecognitionSourceInputObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "ISBN 978-986-473-828-1" },
    });
    expect(result).toMatchObject({
      execution: { outcome: "accepted" },
      accepted: {
        sourceAssociations: [
          expect.objectContaining({ sourceIdentity: "nbinet" }),
        ],
        metadata: expect.arrayContaining([
          expect.objectContaining({
            property: "asset.title",
            value: "定向来源书名",
          }),
        ]),
      },
    });
  } finally {
    await workflow.close();
    vi.unstubAllGlobals();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("运行时目录包上的识别取代预演不会伪造包内文件位置与接受映射", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(
    path.join(tmpdir(), "digital-package-preview-isbn-"),
  );
  const packagePath = path.join(media, "film");
  await mkdir(path.join(packagePath, "BDMV", "PLAYLIST"), { recursive: true });
  await mkdir(path.join(packagePath, "BDMV", "STREAM"), { recursive: true });
  await writeFile(path.join(packagePath, "BDMV", "index.bdmv"), "index");
  await writeFile(
    path.join(packagePath, "BDMV", "MovieObject.bdmv"),
    "movie-object",
  );
  await writeFile(
    path.join(packagePath, "BDMV", "STREAM", "00000.m2ts"),
    "stream",
  );
  let requests = 0;
  const documents = [
    { isbn: "9789864738281", title: "初始书名" },
    { isbn: "9787000000001", title: "取代书名" },
  ];
  vi.stubGlobal("fetch", async () => {
    const document = documents[Math.min(requests, documents.length - 1)]!;
    requests += 1;
    return new Response(
      JSON.stringify({
        docs: [
          {
            pnx: {
              display: { title: [document.title] },
              addata: { isbn: [document.isbn] },
            },
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const workflow = composeAssetRefresh(data, {});
  const catalogue = SqliteCatalogue.forProductData(data);
  const readMaterialFacts = () => {
    const database = new DatabaseSync(path.join(data, "catalogue.sqlite"), {
      readOnly: true,
    });
    try {
      return {
        acceptances: database
          .prepare(
            `SELECT a.acceptance_kind AS kind, a.observed_reference AS reference,
                    l.address AS address
             FROM observed_material_acceptances a
             INNER JOIN locations l ON l.id = a.location_id ORDER BY l.address, a.acceptance_kind`,
          )
          .all() as readonly {
          kind: string;
          reference: string;
          address: string;
        }[],
        boundaries: database
          .prepare(
            `SELECT b.material_kind AS kind, b.derivation_kind AS derivation,
                    l.address AS address
             FROM observed_material_boundaries b
             INNER JOIN locations l ON l.id = b.location_id ORDER BY l.address`,
          )
          .all() as readonly {
          kind: string;
          derivation: string;
          address: string;
        }[],
        supportCount: (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM current_observed_material_supports",
            )
            .get() as { readonly count: number }
        ).count,
      };
    } finally {
      database.close();
    }
  };
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "定向识别的目录包",
      containerPath: media,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const directed = {
      registrationId: root.id,
      relativeScope: "film",
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "ISBN 978-986-473-828-1" },
    };
    const first =
      await workflow.directedRecognitionSourceInputObservedScope(directed);
    expect(first.execution.outcome).toBe("accepted");
    const initial = readMaterialFacts();
    // 目录包由包边界本身支持，而不是借一条伪造的包内文件观察。
    expect(
      initial.boundaries.map(
        ({ address, kind, derivation }) => `${address}:${kind}:${derivation}`,
      ),
    ).toEqual([`${packagePath}:directory:accepted-exact`]);
    expect(
      initial.acceptances.map(
        ({ address, kind, reference }) => `${address}:${kind}:${reference}`,
      ),
    ).toEqual([`${packagePath}:a-work-item:.`]);
    expect(initial.supportCount).toBe(1);

    const second = await workflow.directedRecognitionSourceInputObservedScope({
      ...directed,
      sourceInput: { isbn: "9787000000001" },
    });
    expect(second.execution.outcome).toBe("proposal");
    const preview = await catalogue.inspectChangeImpactPreviewForExecution(
      second.execution.id,
    );
    if (preview === undefined) throw new Error("缺少目录包识别取代预演");
    expect(
      await workflow.applyChangeImpactPreview({
        previewId: preview.id,
        confirmedBy: "user:甲",
      }),
    ).toMatchObject({ status: "applied" });

    const after = readMaterialFacts();
    // 取代只改写来源解释；没有新的完整材料事件，就不许凭空造出位置、边界或接受映射。
    expect(after.boundaries).toEqual(initial.boundaries);
    expect(after.acceptances).toEqual(initial.acceptances);
    expect(after.supportCount).toBe(initial.supportCount);
    const current = (await catalogue.listCurrentCataloguePage()).items;
    expect(current).toHaveLength(1);
    expect(current[0]?.locations.map(({ address }) => address)).toEqual([
      packagePath,
    ]);
  } finally {
    await workflow.close();
    catalogue.close();
    vi.unstubAllGlobals();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 60000);

it("人工多文档的持久 support 投影被篡改后刷新不消费坏链", async () => {
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
  let workflow = composeAssetRefresh(data, {});
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
    expect(
      saved.content.artifactAssociations.filter(
        (association) => association.role === "asset.primary-cover",
      ),
    ).toEqual([]);
    expect(
      saved.content.artifactAssociations.filter(
        (association) => association.role === "asset.material-image",
      ),
    ).toHaveLength(2);
    expect((await workflow.listCurrentAttentionPage()).items).toEqual([]);
    await workflow.close();
    const legacy = new DatabaseSync(path.join(data, "catalogue.sqlite"));
    legacy
      .prepare(
        "UPDATE artifact_associations SET role = 'asset.primary-cover' WHERE role = 'asset.material-image'",
      )
      .run();
    legacy.close();
    workflow = composeAssetRefresh(data, {});
    const rescan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    expect(rescan.execution.outcome).toBe("accepted");
    const contents = await workflow.listCurrentCatalogue();
    expect(contents).toHaveLength(1);
    expect(contents[0]?.entity.id).toBe(saved.content.entity.id);
    expect(
      contents[0]?.artifactAssociations.filter(
        (association) => association.role === "asset.primary-cover",
      ),
    ).toEqual([]);
    expect(
      contents[0]?.artifactAssociations.filter(
        (association) => association.role === "asset.material-image",
      ),
    ).toHaveLength(2);
    expect(contents[0]?.artifactAssociations).toHaveLength(6);
    expect(contents[0]?.artifactRevisions).toHaveLength(6);
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

it("通过真实产品把另一观察根的完整普通文件和 PDF 关联到既有数字资产", async () => {
  const data = await preparedCatalogueRoot();
  const admittedRoot = await mkdtemp(
    path.join(tmpdir(), "digital-material-target-"),
  );
  const materialRoot = await mkdtemp(
    path.join(tmpdir(), "digital-material-source-"),
  );
  const admittedBytes = syntheticPdf({ author: "Initial", pageCount: 1 });
  const supplementalPdf = syntheticPdf({ author: "Supplement", pageCount: 2 });
  await writeFile(path.join(admittedRoot, "initial.pdf"), admittedBytes);
  await writeFile(path.join(materialRoot, "supplement.pdf"), supplementalPdf);
  await writeFile(path.join(materialRoot, "notes.txt"), "whole material notes");
  await link(
    path.join(materialRoot, "notes.txt"),
    path.join(materialRoot, "notes-copy.txt"),
  );
  await writeFile(
    path.join(materialRoot, "notes-independent.txt"),
    "whole material notes",
  );
  const before = await Promise.all([
    readFile(path.join(materialRoot, "supplement.pdf")),
    readFile(path.join(materialRoot, "notes.txt")),
    readFile(path.join(materialRoot, "notes-copy.txt")),
    readFile(path.join(materialRoot, "notes-independent.txt")),
  ]);
  let workflow = composeAssetRefresh(data, {});
  try {
    const admittedRegistration =
      await workflow.observedRootRegistrations.create({
        displayName: "Initial material",
        containerPath: admittedRoot,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      });
    const admitted = await workflow.scanObservedScope({
      registrationId: admittedRegistration.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    expect(admitted.execution.outcome).toBe("accepted");
    const beforeCatalogue = await workflow.listCurrentCatalogue();
    const targetId = beforeCatalogue[0].entity.id;
    const originalAssociations = beforeCatalogue[0].artifactAssociations.length;
    const originalSources = beforeCatalogue[0].sourceAssociations;
    const originalMetadata = beforeCatalogue[0].metadata;
    const materialRegistration =
      await workflow.observedRootRegistrations.create({
        displayName: "Supplemental material",
        containerPath: materialRoot,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      });

    const prepared = await workflow.prepareObservedMaterialAssociation({
      targetAssetId: targetId,
      registrationId: materialRegistration.id,
      relativeScope: ".",
      relativePaths: [
        "supplement.pdf",
        "notes.txt",
        "notes-copy.txt",
        "notes-independent.txt",
      ],
      initiatedBy: "person-prepare",
    });

    expect(prepared).toMatchObject({
      status: "awaiting-confirmation",
      target: { id: targetId },
      observedRoot: {
        id: materialRegistration.id,
        displayName: "Supplemental material",
      },
      proposal: {
        proposedBy: "person-prepare",
        materials: [
          {
            relativePath: "notes-copy.txt",
            role: "asset.material-delivered",
          },
          {
            relativePath: "notes-independent.txt",
            role: "asset.material-delivered",
          },
          { relativePath: "notes.txt", role: "asset.material-delivered" },
          {
            relativePath: "supplement.pdf",
            role: "asset.material-delivered",
          },
        ],
      },
    });
    expect(prepared.files).toHaveLength(4);
    expect(
      (await workflow.listCurrentCatalogue())[0].artifactAssociations,
    ).toHaveLength(originalAssociations);

    const confirmed = await workflow.confirmObservedMaterialAssociation({
      executionId: prepared.executionId,
      confirmedBy: "person-confirm",
    });
    expect(confirmed).toMatchObject({
      status: "accepted",
      confirmedBy: "person-confirm",
      decisionId: expect.any(String),
      associationIds: [
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ],
    });
    await workflow.close();
    workflow = composeAssetRefresh(data, {});
    expect(
      (await workflow.inspectObservedMaterialAssociation(prepared.executionId))
        .status,
    ).toBe("accepted");
    const [current] = await workflow.listCurrentCatalogue();
    expect(current.entity.id).toBe(targetId);
    expect(current.sourceAssociations).toEqual(originalSources);
    expect(current.metadata).toEqual(originalMetadata);
    expect(current.artifactAssociations).toHaveLength(originalAssociations + 3);
    const copiedMaterials = current.locations
      .filter(
        (location) =>
          location.address.endsWith("/notes.txt") ||
          location.address.endsWith("/notes-copy.txt"),
      )
      .map((location) => location.artifactId);
    expect(copiedMaterials).toHaveLength(2);
    expect(new Set(copiedMaterials).size).toBe(1);
    expect(
      new Set([
        ...copiedMaterials,
        ...current.locations
          .filter((location) =>
            location.address.endsWith("/notes-independent.txt"),
          )
          .map((location) => location.artifactId),
      ]).size,
    ).toBe(2);
    expect(
      (
        await workflow.confirmObservedMaterialAssociation({
          executionId: prepared.executionId,
          confirmedBy: "person-confirm",
        })
      ).status,
    ).toBe("accepted");
    const duplicate = await workflow.prepareObservedMaterialAssociation({
      targetAssetId: targetId,
      registrationId: materialRegistration.id,
      relativeScope: ".",
      relativePaths: [
        "supplement.pdf",
        "notes.txt",
        "notes-copy.txt",
        "notes-independent.txt",
      ],
      initiatedBy: "person-prepare-again",
    });
    expect(
      (
        await workflow.confirmObservedMaterialAssociation({
          executionId: duplicate.executionId,
          confirmedBy: "person-confirm-again",
        })
      ).status,
    ).toBe("no-change");
    const after = await Promise.all([
      readFile(path.join(materialRoot, "supplement.pdf")),
      readFile(path.join(materialRoot, "notes.txt")),
      readFile(path.join(materialRoot, "notes-copy.txt")),
      readFile(path.join(materialRoot, "notes-independent.txt")),
    ]);
    expect(after).toEqual(before);
    const verifier = SqliteCatalogue.forProductData(data);
    const durableExecution = await verifier.inspectExecution(
      prepared.executionId,
    );
    const projections =
      durableExecution?.execution.materialAssociation?.submission?.projections;
    expect(projections).toBeDefined();
    await workflow.close();
    const proposalMismatch = new DatabaseSync(
      path.join(data, "catalogue.sqlite"),
    );
    proposalMismatch
      .prepare(
        "UPDATE recognition_proposals SET observed_material_interpretation_json = json_set(observed_material_interpretation_json, '$.observedArtifactRevisions[0].blob.byteLength', json_extract(observed_material_interpretation_json, '$.observedArtifactRevisions[0].blob.byteLength') + 1) WHERE id = (SELECT proposal_id FROM recognition_decisions WHERE id = ?)",
      )
      .run(confirmed.decisionId!);
    proposalMismatch.close();
    await expect(
      verifier.auditObservedMaterialAssociations(projections!),
    ).rejects.toThrow("观察材料关联审计材料事实不存在");
    const corrupted = new DatabaseSync(path.join(data, "catalogue.sqlite"));
    corrupted
      .prepare(
        "UPDATE recognition_proposals SET observed_material_interpretation_json = json_set(observed_material_interpretation_json, '$.observedArtifactRevisions[0].blob.byteLength', json_extract(observed_material_interpretation_json, '$.observedArtifactRevisions[0].blob.byteLength') - 1) WHERE id = (SELECT proposal_id FROM recognition_decisions WHERE id = ?)",
      )
      .run(confirmed.decisionId!);
    corrupted
      .prepare(
        "UPDATE workflow_executions SET material_association_json = json_set(material_association_json, '$.unexpected', true) WHERE id = ?",
      )
      .run(prepared.executionId);
    corrupted.close();
    await expect(
      verifier.auditObservedMaterialAssociations(projections!),
    ).rejects.toThrow("观察材料关联审计检查点无效");
    verifier.close();
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
  } finally {
    await workflow.close();
    await rm(admittedRoot, { recursive: true, force: true });
    await rm(materialRoot, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}, 60000);

it("确认期硬链接 alias 拆分使观察材料关联过期且不产生部分领域写入", async () => {
  const data = await preparedCatalogueRoot();
  const observed = await mkdtemp(
    path.join(tmpdir(), "digital-material-stale-"),
  );
  await writeFile(
    path.join(observed, "initial.pdf"),
    syntheticPdf({ author: "Initial", pageCount: 1 }),
  );
  await writeFile(path.join(observed, "later.txt"), "before");
  await link(
    path.join(observed, "later.txt"),
    path.join(observed, "later-copy.txt"),
  );
  const workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "Material stale",
      containerPath: observed,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scan = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: false,
    });
    const initialReview = await workflow.prepareLocalContent({
      executionId: scan.execution.id,
      relativePaths: ["initial.pdf"],
    });
    const accepted = await workflow.confirmLocalContent({
      executionId: initialReview.executionId,
    });
    const before = (await workflow.listCurrentCatalogue())[0];
    const prepared = await workflow.prepareObservedMaterialAssociation({
      targetAssetId: accepted.content.entity.id,
      registrationId: root.id,
      relativeScope: ".",
      relativePaths: ["later.txt", "later-copy.txt"],
      initiatedBy: "prepare-person",
    });
    await unlink(path.join(observed, "later-copy.txt"));
    await writeFile(path.join(observed, "later-copy.txt"), "before");
    const result = await workflow.confirmObservedMaterialAssociation({
      executionId: prepared.executionId,
      confirmedBy: "confirm-person",
    });
    expect(result.status).toBe("stale");
    const after = (await workflow.listCurrentCatalogue())[0];
    expect(after.artifacts).toEqual(before.artifacts);
    expect(after.artifactAssociations).toEqual(before.artifactAssociations);
    expect(after.metadata).toEqual(before.metadata);
    expect(after.sourceAssociations).toEqual(before.sourceAssociations);
  } finally {
    await workflow.close();
    await rm(observed, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}, 60000);

it("观察材料等待确认在重开后保持，确认恢复续行且畸形检查点阻断启动", async () => {
  const data = await preparedCatalogueRoot();
  const observed = await mkdtemp(
    path.join(tmpdir(), "digital-material-recovery-"),
  );
  await writeFile(
    path.join(observed, "initial.pdf"),
    syntheticPdf({ author: "Initial", pageCount: 1 }),
  );
  let workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "Material recovery",
      containerPath: observed,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const initial = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    expect(initial.execution.outcome).toBe("accepted");
    const targetId = (await workflow.listCurrentCatalogue())[0].entity.id;
    await writeFile(path.join(observed, "appendix.txt"), "recovery material");
    const prepared = await workflow.prepareObservedMaterialAssociation({
      targetAssetId: targetId,
      registrationId: root.id,
      relativeScope: ".",
      relativePaths: ["appendix.txt"],
      initiatedBy: "prepare-person",
    });
    await workflow.close();
    workflow = composeAssetRefresh(data, {});
    const waiting = new Set<string>();
    await workflow.recoverRunningExecutions({
      onWaitingExecution: (executionId) => waiting.add(executionId),
    });
    expect(waiting).toEqual(new Set([prepared.executionId]));
    expect(
      (await workflow.inspectObservedMaterialAssociation(prepared.executionId))
        .status,
    ).toBe("awaiting-confirmation");
    await expect(
      workflow.confirmObservedMaterialAssociation({
        executionId: prepared.executionId,
        confirmedBy: "confirm-person",
        onHostCheckpoint: () => {
          throw new Error("simulated shutdown");
        },
      }),
    ).rejects.toThrow("simulated shutdown");
    await workflow.close();
    workflow = composeAssetRefresh(data, {});
    await workflow.recoverRunningExecutions();
    expect(
      (await workflow.inspectObservedMaterialAssociation(prepared.executionId))
        .status,
    ).toBe("accepted");
    await writeFile(path.join(observed, "appendix-2.txt"), "invalid recovery");
    const malformed = await workflow.prepareObservedMaterialAssociation({
      targetAssetId: targetId,
      registrationId: root.id,
      relativeScope: ".",
      relativePaths: ["appendix-2.txt"],
      initiatedBy: "prepare-malformed",
    });
    await expect(
      workflow.confirmObservedMaterialAssociation({
        executionId: malformed.executionId,
        confirmedBy: "confirm-malformed",
        onHostCheckpoint: () => {
          throw new Error("simulated malformed shutdown");
        },
      }),
    ).rejects.toThrow("simulated malformed shutdown");
    const failClosedVerifier = SqliteCatalogue.forProductData(data);
    const beforeMalformedRecovery = await failClosedVerifier.inspectExecution(
      prepared.executionId,
    );
    await workflow.close();
    const corrupted = new DatabaseSync(path.join(data, "catalogue.sqlite"));
    const validCheckpoint = corrupted
      .prepare(
        "SELECT material_association_json AS raw FROM workflow_executions WHERE id = ?",
      )
      .get(malformed.executionId) as { readonly raw: string };
    for (const raw of [
      "{}",
      '{"version":null}',
      '{"version":"observed-material-association-checkpoint/1"}',
    ]) {
      corrupted
        .prepare(
          "UPDATE workflow_executions SET material_association_json = ? WHERE id = ?",
        )
        .run(raw, malformed.executionId);
      await expect(
        SqliteCatalogue.inspectProductionReadiness({
          productDataDirectory: data,
        }),
      ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
    }
    corrupted
      .prepare(
        "UPDATE workflow_executions SET material_association_json = ? WHERE id = ?",
      )
      .run(validCheckpoint.raw, malformed.executionId);
    corrupted
      .prepare(
        "UPDATE workflow_executions SET material_association_json = json_set(material_association_json, '$.submission.proposal.basis.evidence[0].producer.capabilityId', 7, '$.registrationDisplayName', 7) WHERE id = ?",
      )
      .run(malformed.executionId);
    corrupted.close();
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
    expect(
      await failClosedVerifier.inspectExecution(prepared.executionId),
    ).toEqual(beforeMalformedRecovery);
    failClosedVerifier.close();
  } finally {
    await workflow.close();
    await rm(observed, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}, 60000);

it("观察材料接受在任一写入目标故障时全有或全无", async () => {
  const data = await preparedCatalogueRoot();
  const observed = await mkdtemp(
    path.join(tmpdir(), "digital-material-all-or-nothing-"),
  );
  await writeFile(
    path.join(observed, "initial.pdf"),
    syntheticPdf({ author: "Fault Author", pageCount: 1 }),
  );
  await writeFile(path.join(observed, "appendix.txt"), "故障重试材料");
  const faultCounts = () => {
    const database = new DatabaseSync(path.join(data, "catalogue.sqlite"), {
      readOnly: true,
    });
    const countOf = (table: string) =>
      (
        database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    try {
      return {
        domain: countOf("artifact_association_recognition_supports"),
        hotObservations: countOf("current_file_observation_supports"),
        boundaries: countOf("observed_material_boundaries"),
        acceptances: countOf("observed_material_acceptances"),
        supports: countOf("current_observed_material_supports"),
      };
    } finally {
      database.close();
    }
  };
  const injectFault = (target: MaterialFaultTarget) => {
    const database = new DatabaseSync(path.join(data, "catalogue.sqlite"));
    try {
      database.exec(`
        CREATE TRIGGER reject_observed_material_fault
        BEFORE ${target.event} ON ${target.table}
        BEGIN SELECT RAISE(ABORT, 'injected observed material fault'); END;
      `);
    } finally {
      database.close();
    }
  };
  const healFault = () => {
    const database = new DatabaseSync(path.join(data, "catalogue.sqlite"));
    try {
      database.exec("DROP TRIGGER IF EXISTS reject_observed_material_fault");
    } finally {
      database.close();
    }
  };
  const workflow = composeAssetRefresh(data, {});
  try {
    const root = await workflow.observedRootRegistrations.create({
      displayName: "Fault acceptance",
      containerPath: observed,
      readOnly: true,
      symlinkMode: "do-not-follow",
      allowedTargetRootIds: [],
    });
    const scanFaultedMaterial = () =>
      workflow.scanObservedScope({
        registrationId: root.id,
        relativeScope: ".",
        acceptTrusted: true,
      });
    // 任一写入目标失败时接受必须整体不生效：既不写材料事实，也不留下已接受执行。
    // 早期 checkpoint 故障直接抛出，接受事务故障则被记为该次操作的失败结果。
    const expectAllOrNothing = async (
      target: MaterialFaultTarget,
      attempt: () => Promise<boolean>,
      baseline: ReturnType<typeof faultCounts>,
      currentLength: number,
    ) => {
      injectFault(target);
      let accepted = false;
      try {
        accepted = await attempt();
      } catch {
        accepted = false;
      }
      healFault();
      expect(accepted, target.table).toBe(false);
      expect(faultCounts(), target.table).toEqual(baseline);
      expect((await workflow.listCurrentCatalogue()).length, target.table).toBe(
        currentLength,
      );
    };
    const emptyCounts = faultCounts();
    // A：受信任观察接受。
    const acceptByWorkItem = () =>
      scanFaultedMaterial().then(
        (result) => result.itemResults?.[0]?.accepted !== undefined,
      );
    for (const target of materialFaultTargets([
      "artifact_association_recognition_supports",
      "current_file_observation_supports",
    ]))
      await expectAllOrNothing(target, acceptByWorkItem, emptyCounts, 0);
    expect((await scanFaultedMaterial()).execution.outcome).toBe("accepted");
    const afterWorkItem = faultCounts();
    expect(afterWorkItem.acceptances).toBeGreaterThan(0);

    // B：人工本地确认。
    const preparedLocal = await workflow.prepareLocalContent({
      executionId: (await scanFaultedMaterial()).execution.id,
      relativePaths: ["appendix.txt"],
    });
    const confirmLocal = () =>
      workflow
        .confirmLocalContent({ executionId: preparedLocal.executionId })
        .then((result) => result.status === "accepted");
    for (const target of materialFaultTargets([
      "current_file_observation_supports",
    ]))
      await expectAllOrNothing(target, confirmLocal, afterWorkItem, 1);
    expect(await confirmLocal()).toBe(true);
    const afterLocal = faultCounts();

    // C：观察材料关联确认。
    const preparedAssociation =
      await workflow.prepareObservedMaterialAssociation({
        targetAssetId: (await workflow.listCurrentCatalogue())[0]!.entity.id,
        registrationId: root.id,
        relativeScope: ".",
        relativePaths: ["appendix.txt"],
        initiatedBy: "prepare-person",
      });
    const confirmAssociation = () =>
      workflow
        .confirmObservedMaterialAssociation({
          executionId: preparedAssociation.executionId,
          confirmedBy: "confirm-person",
        })
        .then((result) => result.status === "accepted");
    const currentAfterLocal = (await workflow.listCurrentCatalogue()).length;
    for (const target of materialFaultTargets([
      "artifact_association_recognition_supports",
    ]))
      await expectAllOrNothing(
        target,
        confirmAssociation,
        afterLocal,
        currentAfterLocal,
      );
    expect(await confirmAssociation()).toBe(true);
    expect(faultCounts().acceptances).toBeGreaterThan(afterLocal.acceptances);
  } finally {
    await workflow.close();
    healFault();
    await rm(observed, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}, 60_000);

/**
 * 材料接受写入的目标：该载体的领域正项、私有边界、私有绑定、当前正项与执行生命周期。
 */
type MaterialFaultTarget = {
  readonly table: string;
  readonly event: "INSERT" | "UPDATE";
};
const materialFaultTargets = (
  domainTables: readonly string[],
): readonly MaterialFaultTarget[] => [
  ...domainTables.map(
    (table): MaterialFaultTarget => ({ table, event: "INSERT" }),
  ),
  { table: "observed_material_boundaries", event: "INSERT" },
  { table: "observed_material_acceptances", event: "INSERT" },
  { table: "current_observed_material_supports", event: "INSERT" },
  { table: "workflow_executions", event: "UPDATE" },
];

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
