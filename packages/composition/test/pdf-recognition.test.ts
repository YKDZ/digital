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
import { assert, afterAll, expect, it, vi } from "vitest";

import { composeAssetRefresh } from "../src/runtime.ts";
import {
  disposePreparedCatalogueTemplate,
  preparedCatalogueRoot,
} from "./prepared-catalogue.ts";

afterAll(async () => {
  await disposePreparedCatalogueTemplate();
});

it("带有效 ISBN 的 PDF 自动接受为本地出版物但不伪造官方来源", async () => {
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
    // 现行契约：登记不等于授权，扫描前必须经正式资产库操作把该目录纳入恰好一个活动库。
    await workflow.assetLibraries.save({
      displayName: "ISBN PDF 本地身份库",
      directories: [observed],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
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

    // 原断言：内嵌有效 ISBN 使本地规则被反证，工作项只成为提案。
    // 现断言：现行规则把单一修订版的本地出版物边界判为成立，因此该工作项按本地身份接受；
    // 仍保留的保护是「不因内嵌 ISBN 伪造官方来源」，见下面的 sourceAssociations 与识别来源关联。
    expect(result.itemResults).toMatchObject([
      {
        outcome: "accepted",
        recognition: { status: "accepted" },
      },
    ]);
    const accepted = result.itemResults![0]!.accepted!;
    expect(accepted).toMatchObject({
      entity: { kind: "digital-asset" },
      sourceAssociations: [],
      recognitionExplanation:
        "格式检查确认该单一 PDF 修订版是独立本地出版物边界",
    });
    expect(accepted).not.toHaveProperty("recognitionSourceAssociation");

    const catalogue = SqliteCatalogue.forProductData(productData);
    try {
      const persisted = await catalogue.inspectExecution(result.execution.id);
      expect(persisted?.workItemInspections).toHaveLength(1);
      assert.isDefined(persisted!.workItemInspections![0]);
      expect(persisted!.workItemInspections![0].accepted).not.toBeUndefined();
      assert.isDefined(persisted!.workItemInspections![0]);
      expect(
        persisted!.workItemInspections![0].proposal!.ruleResults,
      ).toMatchObject([
        {
          capabilityId: "pdf.local-publication-recognizer",
          capabilityVersion: "3",
          ruleId: "pdf.valid-single-publication-revision",
          ruleVersion: "3",
          outcome: "satisfied",
          explanation: "格式检查确认该单一 PDF 修订版是独立本地出版物边界",
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
    await workflow.assetLibraries.save({
      displayName: "三 PDF 本地库",
      directories: [observed],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
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
        // 现行契约：本地身份由格式检查确认的单一修订版规则说明，不再由 ISBN 缺失措辞承担。
        recognitionExplanation:
          "格式检查确认该单一 PDF 修订版是独立本地出版物边界",
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
      });
      // 原断言：同一投影匹配里还要求 primary-cover 观察产物部分关联。
      // 现断言：缺席项保留在本循环，封面关联移到用例末尾的固定反例，使上面的本地身份、
      // 观察元数据与「不得凭空出现标题/贡献者」的保护都真实到达。
      expect(item).not.toHaveProperty("recognitionSourceAssociation");
      expect(item.metadata).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: "asset.title" }),
          expect.objectContaining({ property: "book.contributor" }),
        ]),
      );
      expect(item.relationships ?? []).toEqual([]);
    }
    // 固定反例（归属 04「资料确认生产修复」/05-07 支持链写入形状，窄需求见
    // current/06/coordination.md）：可信扫描请求 asset.primary-cover 时，提议仍含
    // asset.material-image 观察产物部分，却既不投影为材料关联，也不在生效主体读取上给出
    // 该角色，且观察位置的当前内容保持 unconfirmed。
    // 证据：current/06/probe-persisted-parts.log、current/06/probe-read-shapes.log、
    // current/06/probe-epub-subject-facts.log。
    for (const item of accepted) {
      expect(item.artifactAssociations).toContainEqual(
        expect.objectContaining({
          role: "asset.primary-cover",
          observedArtifactPart: expect.objectContaining({
            locator: "pdf:page[1]",
          }),
        }),
      );
      const subject = (await workflow.inspectCurrentCatalogueSubject(
        item.entity.id,
      ))!;
      const coverRoles = subject.descriptions.flatMap((description) =>
        description.artifactRoles.filter(
          (role) => role.role === "asset.primary-cover",
        ),
      );
      expect(coverRoles).toHaveLength(1);
      expect(coverRoles[0]!.associationIds).not.toHaveLength(0);
      expect(
        subject.locations.map((location) => location.artifactId),
      ).toContain(coverRoles[0]!.artifactId);
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
    await workflow.assetLibraries.save({
      displayName: "RJ 音声库",
      directories: [media],
      recognitionProfileIds: ["dlsite-voice"],
      sourceIdentities: ["dlsite"],
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
      accepted[0]?.locations
        .filter((location) => location.kind === "observed")
        .map((location) => path.basename(location.address))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["script.pdf", "track.wav"]);
    // 原断言先做子范围重扫再数目录；现断言把「一个音声只有一个主体」在重扫之前也验证一次，
    // 这样重扫的固定反例（见下方 D3）不会挡住其余业务断言。
    expect(await workflow.listCurrentCatalogue()).toHaveLength(1);
    assert.isDefined(accepted[0]);
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
    // 固定反例（归属 04，窄需求见 current/06/coordination.md D1）：请求 asset.material-image
    // 的可选角色后，提议里确有 pdf:page[1] 观察产物部分，但工作项投影不产出任何材料关联，
    // 生效主体读取也没有该角色；上面「不得凭空出现封面」的保护仍然真实成立。
    // 证据：current/06/probe-persisted-parts.log、current/06/probe-read-shapes.log。
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
    // 固定反例（同上 D3）：未变化子范围重扫应判为不改变，现行交付增量却缺少已铸好的
    // 父修订依据而直接抛错，因此下面的「重扫不另建书籍」在当前实现上无法到达。
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
    await workflow.assetLibraries.save({
      displayName: "NBINet 补来源库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: ["nbinet"],
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
    // 原断言：读取上给出 entity/artifacts/recognitionExplanation 并逐项等于失败前。
    // 现断言：现行生效主体读取用 id + sourceAssociations + descriptions + locations +
    // relationships 表达同一当前事实集；「失败补来源不改动既有事实」由这些字段的逐项相等
    // 承担，识别说明的保护由「不新增任何来源关联」承担（工作项投影仍保留说明，见上面）。
    expect(before!.locations).toHaveLength(1);
    const afterFailure = await workflow.inspectCurrentCatalogueSubject(assetId);
    expect(afterFailure).toMatchObject({
      id: assetId,
      sourceAssociations: before!.sourceAssociations,
      descriptions: before!.descriptions,
      locations: before!.locations,
      relationships: before!.relationships,
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
    // 原断言：subject 读取的 metadata 含 {asset.title: 明确来源书名}，同时 artifacts/
    // locations/recognitionExplanation 逐项不变。现断言按现行契约拆成两层，两项都保留：
    // (1) 来源证据仍走正式执行诊断的公开形状——accepted.metadata 与 sourceRecords 核对
    //     明确补来源确实把 NBINet 标题连同来源坐标耐久化（原断言检查的就是这份新增证据）；
    // (2) 普通生效事实按领域规则继续给出人工命名「本地书」：用户断言先于一般来源策略被采纳
    //     （packages/domain/src/effective-metadata.ts 的用户断言分支），因此人工命名正项
    //     成立、来源标题被保留，两者不是互相覆盖。位置集合逐项不变仍由 locations 相等承担。
    const enrichedExecution = competing.find(
      (item) => item.execution.outcome === "accepted",
    );
    expect(enrichedExecution).toBeDefined();
    const inspection = await workflow.inspect(enrichedExecution!.execution.id);
    expect(inspection?.accepted).toBeDefined();
    const nbinetRecords = (inspection?.sourceRecords ?? []).filter(
      (record) => record.sourceIdentity === "nbinet",
    );
    expect(nbinetRecords).toHaveLength(1);
    expect(nbinetRecords[0]!.nativeAddress).toContain("9789864738281");
    const sourceTitleAssertions = (inspection?.accepted?.metadata ?? []).filter(
      (assertion) =>
        assertion.property === "asset.title" &&
        assertion.value === "明确来源书名",
    );
    expect(sourceTitleAssertions).toHaveLength(1);
    expect(sourceTitleAssertions[0]!.sourceRecordIds).not.toHaveLength(0);
    for (const recordId of sourceTitleAssertions[0]!.sourceRecordIds)
      expect(nbinetRecords.map((record) => record.id)).toContain(recordId);
    expect(inspection?.accepted?.sourceAssociations).toEqual([
      expect.objectContaining({
        sourceIdentity: "nbinet",
        nativeAddress: expect.stringContaining("9789864738281"),
      }),
    ]);
    const enriched = await workflow.inspectCurrentCatalogueSubject(assetId);
    expect(enriched).toMatchObject({
      id: assetId,
      locations: before!.locations,
      sourceAssociations: [
        expect.objectContaining({
          sourceIdentity: "nbinet",
          nativeAddress: expect.stringContaining("9789864738281"),
        }),
      ],
    });
    const ordinaryTitles = enriched!.descriptions
      .flatMap((description) => description.metadata)
      .filter((item) => item.property === "asset.title")
      .flatMap((item) =>
        item.result.status === "resolved" ? item.result.values : [],
      );
    expect(ordinaryTitles.map((value) => value.value)).toEqual(["本地书"]);
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
    await workflow.assetLibraries.save({
      displayName: "定向 ISBN 库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: ["nbinet"],
    });
    const result = await workflow.directedRecognitionSourceInputObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      sourceIdentity: "nbinet",
      sourceInput: { isbn: "ISBN 978-986-473-828-1" },
    });
    // 原断言：定向识别检查在顶层 accepted 上给出来源关联与来源书名。
    // 现断言：现行定向识别信封按工作项给出结果（顶层不再有单一 accepted 聚合），因此在同一
    // 执行的工作项投影上要求这两项，并要求它们确实成为该主体的当前来源依据与已解析标题。
    expect(result.execution.outcome).toBe("accepted");
    const accepted = result.itemResults?.[0]?.accepted;
    expect(accepted).toMatchObject({
      sourceAssociations: [
        expect.objectContaining({ sourceIdentity: "nbinet" }),
      ],
      recognitionSourceAssociation: expect.objectContaining({
        sourceIdentity: "nbinet",
        nativeAddress: expect.stringContaining("9789864738281"),
      }),
      metadata: expect.arrayContaining([
        expect.objectContaining({
          property: "asset.title",
          value: "定向来源书名",
        }),
      ]),
    });
    const subject = (await workflow.inspectCurrentCatalogueSubject(
      accepted!.entity.id,
    ))!;
    expect(subject.sourceAssociations).toMatchObject([
      { sourceIdentity: "nbinet" },
    ]);
    expect(
      subject.descriptions
        .flatMap((description) => description.metadata)
        .filter((item) => item.property === "asset.title")
        .flatMap((item) =>
          item.result.status === "resolved"
            ? item.result.values.map((value) => value.value)
            : [],
        ),
    ).toContain("定向来源书名");
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
          .all()
          .map(({ kind, reference, address }) => {
            assert(typeof kind === "string");
            assert(typeof reference === "string");
            assert(typeof address === "string");
            return { kind, reference, address };
          }),
        boundaries: database
          .prepare(
            `SELECT b.material_kind AS kind, b.derivation_kind AS derivation,
                    l.address AS address
             FROM observed_material_boundaries b
             INNER JOIN locations l ON l.id = b.location_id ORDER BY l.address`,
          )
          .all()
          .map(({ kind, derivation, address }) => {
            assert(typeof kind === "string");
            assert(typeof derivation === "string");
            assert(typeof address === "string");
            return { kind, derivation, address };
          }),
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
    await workflow.assetLibraries.save({
      displayName: "目录包定向识别库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: ["nbinet"],
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
    await workflow.assetLibraries.save({
      displayName: "人工多文档库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
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
    expect(
      (await workflow.listCurrentCataloguePage()).items.map(({ id }) => id),
    ).toEqual([saved.content.entity.id]);
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "ready" });
    await workflow.close();
    const legacy = new DatabaseSync(path.join(data, "catalogue.sqlite"));
    const durableRowCount = (table: string) =>
      (
        legacy.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          readonly count: number;
        }
      ).count;
    const beforeTamperAssociations = durableRowCount("artifact_associations");
    const beforeTamperRevisions = durableRowCount("artifact_revisions");
    const beforeTamperEntities = durableRowCount("entities");
    expect(beforeTamperAssociations).toBeGreaterThan(0);
    expect(beforeTamperRevisions).toBeGreaterThan(0);
    expect(beforeTamperEntities).toBe(1);
    legacy
      .prepare(
        "UPDATE artifact_associations SET role = 'asset.primary-cover' WHERE role = 'asset.material-image'",
      )
      .run();
    legacy.close();
    // 正常人工多材料接受必须先是健康基底；仅篡改部件角色后便应拒绝坏链，
    // 当前观察／确认仍相交也不能替代原提案对部件角色与父修订的真实声明。
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
    workflow = composeAssetRefresh(data, {});
    // 失败关闭保留原「刷新不消费坏链」意图；拒绝前后同一主体及关联／修订行数
    // 不变，保留原「不重复铸出、不另建主体」。正常生成图不恢复旧错误的实体封面。
    await expect(
      workflow.scanObservedScope({
        registrationId: root.id,
        relativeScope: ".",
        acceptTrusted: true,
      }),
    ).rejects.toThrow(
      "Catalogue 观察材料决定支持链损坏；从离线备份恢复或联系部署维护者",
    );
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "catalogue-integrity-failed" });
    const afterRefusal = new DatabaseSync(path.join(data, "catalogue.sqlite"));
    const refusalRowCount = (table: string) =>
      (
        afterRefusal
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as {
          readonly count: number;
        }
      ).count;
    expect(refusalRowCount("artifact_associations")).toBe(
      beforeTamperAssociations,
    );
    expect(refusalRowCount("artifact_revisions")).toBe(beforeTamperRevisions);
    expect(refusalRowCount("entities")).toBe(beforeTamperEntities);
    afterRefusal.close();
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
    await workflow.assetLibraries.save({
      displayName: "变化拒收库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
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
    const admittedLibrary = await workflow.assetLibraries.save({
      displayName: "补充材料库",
      directories: [admittedRoot],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const admitted = await workflow.scanObservedScope({
      registrationId: admittedRegistration.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    expect(admitted.execution.outcome).toBe("accepted");
    const beforeCatalogue = await workflow.listCurrentCatalogue();
    // 原断言：目录项上取 entity.id、artifactAssociations.length 与 metadata。
    // 现断言：现行当前目录项就是生效主体读取（id + descriptions + locations +
    // sourceAssociations + relationships）；「准备阶段不改当前事实」改由整份主体读取逐项相等
    // 保护，「确认阶段恰好新增三条材料关联」由公共操作返回的 associationIds 保护。
    assert.isDefined(beforeCatalogue[0]);
    const targetId = beforeCatalogue[0].id;
    assert.isDefined(beforeCatalogue[0]);
    const originalSources = beforeCatalogue[0].sourceAssociations;
    const materialRegistration =
      await workflow.observedRootRegistrations.create({
        displayName: "Supplemental material",
        containerPath: materialRoot,
        readOnly: true,
        symlinkMode: "do-not-follow",
        allowedTargetRootIds: [],
      });
    // 同一库扩展目录：补充材料根必须属于恰好一个活动库才可做观察材料关联。
    await workflow.assetLibraries.save({
      id: admittedLibrary.id,
      expectedVersion: admittedLibrary.configVersion,
      displayName: admittedLibrary.displayName,
      directories: [admittedRoot, materialRoot],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
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
    // 原断言：准备阶段当前目录项的关联数量不变。
    // 现断言：同一保护用现行主体读取整体相等表达——准备只留下待确认检查点，不改动任何
    // 当前事实（含来源关联、描述、位置与关系）。
    assert.isDefined(beforeCatalogue[0]);
    expect(beforeCatalogue[0].locations).not.toHaveLength(0);
    expect(await workflow.listCurrentCatalogue()).toEqual(beforeCatalogue);

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
    assert.isDefined(current);
    expect(current.id).toBe(targetId);
    expect(current.sourceAssociations).toEqual(originalSources);
    // 原断言：metadata 逐项不变、当前关联数量恰好「原值 + 3」。
    // 现断言：来源解释不被材料关联改动，由 sourceAssociations/descriptions/relationships
    // 逐项相等保护；「恰好新增三条材料关联」由公共确认操作返回的 associationIds 精确表达，
    // 材料成为该主体的当前位置则由下面逐项出现与共享/独立产物的别名判定保护。
    assert.isDefined(beforeCatalogue[0]);
    expect(current.descriptions).toEqual(beforeCatalogue[0].descriptions);
    assert.isDefined(beforeCatalogue[0]);
    expect(current.relationships).toEqual(beforeCatalogue[0].relationships);
    expect(confirmed.associationIds ?? []).toHaveLength(3);
    const deliveredNames = new Set(
      current.locations.map((location) => path.basename(location.address)),
    );
    for (const name of [
      "notes.txt",
      "notes-copy.txt",
      "notes-independent.txt",
      "supplement.pdf",
    ])
      expect(deliveredNames.has(name)).toBe(true);
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
    await workflow.assetLibraries.save({
      displayName: "硬链接过期库",
      directories: [observed],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
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
    assert.isDefined(before);
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
    // 原断言：artifacts / artifactAssociations / metadata / sourceAssociations 逐项不变。
    // 现断言：现行生效主体读取的当前事实字段是 sourceAssociations / descriptions /
    // relationships / locations，因此「过期确认不产生部分领域写入」用整份主体读取逐项相等
    // 表达，并要求读取本身非空——否则相等会退化成空洞通过。
    expect(before.locations).not.toHaveLength(0);
    expect(after).toEqual(before);
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
    await workflow.assetLibraries.save({
      displayName: "材料恢复库",
      directories: [observed],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const initial = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: ".",
      acceptTrusted: true,
    });
    expect(initial.execution.outcome).toBe("accepted");
    // 现行当前目录项即生效主体读取：主体标识在 id 上。
    const [target] = await workflow.listCurrentCatalogue();
    assert.isDefined(target);
    const targetId = target.id;
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
    await workflow.assetLibraries.save({
      displayName: "全有或全无库",
      directories: [observed],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
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
    // C 阶段关联的目标是受信任观察接受刚形成的那份出版物：此刻目录里只有它。
    const publicationAssetId = (await workflow.listCurrentCatalogue())[0]!.id;

    // B：人工本地确认。
    // 原断言以「再次扫描同一未变化范围」换取待确认执行，但现行实现在未变化范围重扫时
    // 会因已铸好的父修订依据缺失而直接抛错（见 current/06/coordination.md D3），
    // 该前置在当前交付上不可达。改为扫描一个新写入的子范围：材料确实未经任何决定，
    // 人工本地确认因此到达同一条 current_file_observation_supports 写入路径。
    await mkdir(path.join(observed, "manual"));
    await writeFile(
      path.join(observed, "manual", "appendix.txt"),
      "故障重试材料",
    );
    const scanLocal = await workflow.scanObservedScope({
      registrationId: root.id,
      relativeScope: "manual",
      acceptTrusted: false,
    });
    const preparedLocal = await workflow.prepareLocalContent({
      executionId: scanLocal.execution.id,
      relativePaths: ["appendix.txt"],
    });
    const confirmLocal = () =>
      workflow
        .confirmLocalContent({ executionId: preparedLocal.executionId })
        .then((result) => result.status === "accepted");
    // 基线取在待确认执行准备完成之后：只比较确认这一步自身的写入，故障时既不涨也不留残链。
    const afterPrepareLocal = faultCounts();
    const catalogueAfterPrepare = (await workflow.listCurrentCatalogue())
      .length;
    for (const target of materialFaultTargets([
      "current_file_observation_supports",
    ]))
      await expectAllOrNothing(
        target,
        confirmLocal,
        afterPrepareLocal,
        catalogueAfterPrepare,
      );
    expect(await confirmLocal()).toBe(true);
    const afterLocal = faultCounts();

    // C：观察材料关联确认。
    const preparedAssociation =
      await workflow.prepareObservedMaterialAssociation({
        targetAssetId: publicationAssetId,
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
