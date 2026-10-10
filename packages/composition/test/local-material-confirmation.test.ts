/**
 * 票04 原端口证据：本地材料确认走真实组合缝隙（真实资产库目录授权 + 真实 SQLite 持久化 +
 * 真实字节访问确认），不是模拟协调器。正向由正常可信接受与真实确认建立，损坏负项只注入
 * 隔离副本。这里覆盖第 5/6/8 节：等大小同修改时间的内容变更重扫、终态与投影同事务、
 * 冻结授权代际与已接受支持重核，以及两个耐久中断窗口之后的恢复。
 */
import { copyFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  WorkflowLifecycleInterruption,
  type WorkflowExecution,
} from "@digital/application";
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

const coverRequirement = {
  metadataUsageContext: "asset.ordinary" as const,
  metadata: [],
  relationshipTypes: [],
  artifactRoles: [
    { role: "asset.primary-cover", necessity: "required" as const, maximum: 1 },
  ],
};

// 当前读取用同一正式信息需求接缝，额外点名内容事实，证明重扫后的资料仍生效。
const readRequirement = {
  metadataUsageContext: "asset.ordinary" as const,
  metadata: [
    { property: "pdf.document-author", necessity: "optional" as const },
  ],
  relationshipTypes: [],
  artifactRoles: [
    { role: "asset.primary-cover", necessity: "required" as const, maximum: 1 },
  ],
};

it("等大小同修改时间的内容变更重扫不伪造来源溯源且保留已接受身份", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(
    path.join(tmpdir(), "digital-rescan-provenance-"),
  );
  const file = path.join(media, "one.pdf");
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  const workflow = composeAssetRefresh(data, {});
  try {
    await writeFile(file, syntheticPdf({ author: "One", pageCount: 1 }));
    await utimes(file, timestamp, timestamp);
    // 正式公开入口：库配置先为目录建立授权，扫描只按该库解析权威；本测试不选任何资料来源。
    const libraries = workflow.assetLibraries;
    const library = await libraries.save({
      displayName: "文档库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const registrationId = library.rootIds[0]!;
    const first = await workflow.scanObservedScope({
      registrationId,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: coverRequirement,
    });
    expect(first.itemResults).toHaveLength(1);
    const assetId = first.itemResults![0].accepted!.entity.id;
    expect(
      first.itemResults![0].accepted!.artifactAssociations.some(
        (association) =>
          association.role === "asset.primary-cover" &&
          association.observedArtifactPart !== undefined &&
          association.sourceRecordIds === undefined,
      ),
    ).toBe(true);

    // 同长度同修改时间、内容不同：冻结坐标按摘要判定已变化，但尺寸/时间门不投递任何新文件。
    await writeFile(file, syntheticPdf({ author: "Two", pageCount: 1 }));
    await utimes(file, timestamp, timestamp);

    const second = await workflow.scanObservedScope({
      registrationId,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: coverRequirement,
    });

    expect(second.itemResults).toHaveLength(1);
    expect(second.itemResults![0].accepted!.entity.id).toBe(assetId);
    expect(
      second.execution.outcome,
      JSON.stringify(second.execution.dispositions),
    ).toBe("accepted");
    expect(
      second.itemResults![0].accepted!.metadata.find(
        (assertion) => assertion.property === "pdf.document-author",
      )?.value,
    ).toBe("Two");
    expect(
      second.itemResults![0].accepted!.artifactAssociations.some(
        (association) =>
          association.role === "asset.primary-cover" &&
          association.observedArtifactPart !== undefined &&
          association.sourceRecordIds === undefined,
      ),
    ).toBe(true);
    // 变化后的耐久状态必须仍然读得出来：出处/支持链断了就是数据未就绪，不能靠放宽核对继续。
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "ready" });
    const catalogue = SqliteCatalogue.forProductData(data);
    try {
      const persisted = await catalogue.inspectExecution(second.execution.id);
      expect(persisted?.execution.status).toBe("completed");
    } finally {
      catalogue.close();
    }
    const current = await workflow.listCurrentCataloguePage({
      subjectIds: [assetId],
      informationRequirement: readRequirement,
    });
    expect(current.items).toHaveLength(1);
    const description = current.items[0]!.descriptions.find(
      (item) =>
        item.target.kind === "entity" && item.target.entityId === assetId,
    );
    // 当前读取仍承认这条刷新后派生封面的当前角色，并读到变化后的内容事实。
    expect(
      description?.artifactRoles.some(
        (role) => role.role === "asset.primary-cover",
      ),
    ).toBe(true);
    // PDF 格式事实属于精确载体修订，不属于资产实体；普通读取必须在新修订目标下读取它。
    const revision = second.itemResults![0].accepted!.metadata.find(
      (assertion) => assertion.property === "pdf.document-author",
    )!.target;
    const revisionDescription = current.items[0]!.descriptions.find(
      (item) =>
        item.target.kind === "artifact-revision" &&
        revision.kind === "artifact-revision" &&
        item.target.artifactId === revision.artifactId &&
        item.target.revisionId === revision.revisionId,
    );
    const author = revisionDescription?.metadata.find(
      (item) => item.property === "pdf.document-author",
    );
    expect(
      author?.result.status === "resolved"
        ? author.result.values.map((value) => value.value)
        : [],
    ).toEqual(["Two"]);

    // 后续刷新仍能识别同一材料：无变化的第三次重扫既不投递也不损坏。
    const third = await workflow.scanObservedScope({
      registrationId,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: coverRequirement,
    });
    expect(third.itemResults).toHaveLength(1);
    expect(third.execution.outcome).toBe("no-change");
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "ready" });
    const after = await workflow.listCurrentCataloguePage({
      subjectIds: [assetId],
      informationRequirement: readRequirement,
    });
    expect(after.items).toHaveLength(1);
    expect(
      after.items[0]!.descriptions.some((item) =>
        item.artifactRoles.some((role) => role.role === "asset.primary-cover"),
      ),
    ).toBe(true);
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 120000);

it("真实 proof 提交后进度未提交，重开只复用原冻结目标且不重复读字节", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(
    path.join(tmpdir(), "digital-material-recovery-"),
  );
  let workflow = composeAssetRefresh(data, {});
  let execution: WorkflowExecution | undefined;
  const checkpoint =
    SqliteCatalogue.prototype.checkpointRequestedLocalMaterialConfirmations;
  const checkpointSpy = vi
    .spyOn(
      SqliteCatalogue.prototype,
      "checkpointRequestedLocalMaterialConfirmations",
    )
    .mockImplementation(async function (this: SqliteCatalogue, input) {
      const result = await checkpoint.call(this, input);
      execution = result.execution;
      return result;
    });
  let proofCommitted = false;
  const confirm =
    workflow.artifactByteAccess.confirmExpectedObservedRevision.bind(
      workflow.artifactByteAccess,
    );
  const confirmationSpy = vi
    .spyOn(workflow.artifactByteAccess, "confirmExpectedObservedRevision")
    .mockImplementation(async (input) => {
      const result = await confirm(input);
      expect(result.kind).toBe("exact-confirmed");
      proofCommitted = true;
      throw new WorkflowLifecycleInterruption(
        new Error("已提交 proof，模拟进程中断"),
      );
    });
  try {
    await writeFile(
      path.join(media, "one.pdf"),
      syntheticPdf({ author: "One", pageCount: 1 }),
    );
    const library = await workflow.assetLibraries.save({
      displayName: "恢复库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    await expect(
      workflow.scanObservedScope({
        registrationId: library.rootIds[0]!,
        relativeScope: ".",
        acceptTrusted: true,
        informationRequirement: coverRequirement,
      }),
    ).rejects.toThrow("已提交 proof");
    expect(proofCommitted).toBe(true);
    expect(execution).toBeDefined();
    const original = execution!.dispositions.find(
      (item) => item.observedMaterialConfirmation !== undefined,
    )!.observedMaterialConfirmation!;
    expect(original.targets).toHaveLength(1);
    expect(original.targets[0]!.status).toBe("pending");
    confirmationSpy.mockRestore();
    checkpointSpy.mockRestore();
    await workflow.close();
    await writeFile(
      path.join(media, "new.pdf"),
      syntheticPdf({ author: "New", pageCount: 1 }),
    );
    workflow = composeAssetRefresh(data, {});
    const realConfirm =
      workflow.artifactByteAccess.confirmExpectedObservedRevision.bind(
        workflow.artifactByteAccess,
      );
    const resumedReads = vi
      .spyOn(workflow.artifactByteAccess, "confirmExpectedObservedRevision")
      .mockImplementation(realConfirm);
    const resumed = await workflow.resume({ executionId: execution!.id });
    expect(resumed.execution.status).toBe("completed");
    expect(resumed.execution.outcome).toBe("accepted");
    const settled = resumed.execution.dispositions.find(
      (item) => item.observedMaterialConfirmation !== undefined,
    )!.observedMaterialConfirmation!;
    expect(settled.targets).toEqual(
      original.targets.map((target) => ({ ...target, status: "confirmed" })),
    );
    expect(resumedReads).not.toHaveBeenCalled();
    resumedReads.mockRestore();
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "ready" });
  } finally {
    confirmationSpy.mockRestore();
    checkpointSpy.mockRestore();
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 120000);

it("目标和观察已真实提交而字节未读，重开恢复沿原目标确认", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-material-pending-"));
  let workflow = composeAssetRefresh(data, {});
  let execution: WorkflowExecution | undefined;
  const checkpoint =
    SqliteCatalogue.prototype.checkpointRequestedLocalMaterialConfirmations;
  const spy = vi
    .spyOn(
      SqliteCatalogue.prototype,
      "checkpointRequestedLocalMaterialConfirmations",
    )
    .mockImplementation(async function (this: SqliteCatalogue, input) {
      const result = await checkpoint.call(this, input);
      execution = result.execution;
      expect(result.outcomes[0]!.kind).toBe("needs-confirmation");
      throw new WorkflowLifecycleInterruption(
        new Error("观察已耐久，字节尚未读"),
      );
    });
  try {
    await writeFile(
      path.join(media, "one.pdf"),
      syntheticPdf({ author: "One", pageCount: 1 }),
    );
    const library = await workflow.assetLibraries.save({
      displayName: "待确认库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    await expect(
      workflow.scanObservedScope({
        registrationId: library.rootIds[0]!,
        relativeScope: ".",
        acceptTrusted: true,
        informationRequirement: coverRequirement,
      }),
    ).rejects.toThrow("字节尚未读");
    const original = execution!.dispositions.find(
      (item) => item.observedMaterialConfirmation !== undefined,
    )!.observedMaterialConfirmation!;
    expect(original.targets[0]!.status).toBe("pending");
    expect(original.targets[0]!.observation).toBeDefined();
    spy.mockRestore();
    await workflow.close();
    await writeFile(
      path.join(media, "new.pdf"),
      syntheticPdf({ author: "New", pageCount: 1 }),
    );
    workflow = composeAssetRefresh(data, {});
    const confirm =
      workflow.artifactByteAccess.confirmExpectedObservedRevision.bind(
        workflow.artifactByteAccess,
      );
    const reads = vi
      .spyOn(workflow.artifactByteAccess, "confirmExpectedObservedRevision")
      .mockImplementation(confirm);
    const resumed = await workflow.resume({ executionId: execution!.id });
    expect(resumed.execution.outcome).toBe("accepted");
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]![0].expectedRevisionId).toBe(
      original.targets[0]!.expectedRevisionId,
    );
    expect(
      resumed.execution.dispositions.find(
        (item) => item.observedMaterialConfirmation !== undefined,
      )!.observedMaterialConfirmation!.targets,
    ).toEqual(
      original.targets.map((target) => ({ ...target, status: "confirmed" })),
    );
    reads.mockRestore();
  } finally {
    spy.mockRestore();
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 120000);

it("真实确认后撤销本库授权，终态诚实 partial 且保留已接受身份", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(
    path.join(tmpdir(), "digital-material-authority-"),
  );
  const workflow = composeAssetRefresh(data, {});
  let removed = false;
  try {
    await writeFile(
      path.join(media, "one.pdf"),
      syntheticPdf({ author: "One", pageCount: 1 }),
    );
    const library = await workflow.assetLibraries.save({
      displayName: "撤权库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const confirm =
      workflow.artifactByteAccess.confirmExpectedObservedRevision.bind(
        workflow.artifactByteAccess,
      );
    const spy = vi
      .spyOn(workflow.artifactByteAccess, "confirmExpectedObservedRevision")
      .mockImplementation(async (input) => {
        const result = await confirm(input);
        expect(result.kind).toBe("exact-confirmed");
        await workflow.assetLibraries.remove({
          id: library.id,
          expectedVersion: library.configVersion,
        });
        removed = true;
        return result;
      });
    try {
      const result = await workflow.scanObservedScope({
        registrationId: library.rootIds[0]!,
        relativeScope: ".",
        acceptTrusted: true,
        informationRequirement: coverRequirement,
      });
      expect(removed).toBe(true);
      expect(result.execution.status).toBe("completed");
      expect(result.execution.outcome).toBe("partially-succeeded");
      expect(result.execution.workItems![0]!.outcome).toBe("accepted");
      expect(
        result.execution.dispositions.find(
          (item) => item.observedMaterialConfirmation !== undefined,
        )!.observedMaterialConfirmation!.targets[0],
      ).toMatchObject({
        status: "failed",
        failureCode: "local-material-observation-stale",
      });
      await expect(
        SqliteCatalogue.inspectProductionReadiness({
          productDataDirectory: data,
        }),
      ).resolves.toMatchObject({ state: "ready" });
    } finally {
      spy.mockRestore();
    }
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 120000);

it("终态预查询后较新真实观察抢先提交，旧确认不覆盖新观察", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-material-race-"));
  const workflow = composeAssetRefresh(data, {});
  const catalogue = SqliteCatalogue.forProductData(data);
  const verify =
    SqliteCatalogue.prototype.verifyRequestedLocalMaterialConfirmationTerminals;
  let raced = false;
  let latestSnapshot: string | undefined;
  let locationId: string | undefined;
  let registrationId: string;
  const spy = vi
    .spyOn(
      SqliteCatalogue.prototype,
      "verifyRequestedLocalMaterialConfirmationTerminals",
    )
    .mockImplementation(async function (this: SqliteCatalogue, input) {
      const result = await verify.call(this, input);
      const target = input.execution.dispositions.find(
        (item) => item.observedMaterialConfirmation !== undefined,
      )?.observedMaterialConfirmation?.targets[0];
      if (!raced && target?.status === "confirmed") {
        raced = true;
        locationId = target.locationId;
        expect(result).toEqual([]);
        const newer = await workflow.scanObservedScope({
          registrationId,
          relativeScope: ".",
          acceptTrusted: true,
        });
        expect(newer.execution.status).toBe("completed");
        latestSnapshot = newer.execution.snapshot!.id;
        const selection =
          await catalogue.observedFileSelectionForLocation(locationId);
        const facts = await catalogue.readObservedFileConfirmationFacts(
          selection!,
        );
        expect(facts!.observation.snapshotId).toBe(latestSnapshot);
      }
      return result;
    });
  try {
    await writeFile(
      path.join(media, "one.pdf"),
      syntheticPdf({ author: "One", pageCount: 1 }),
    );
    const library = await workflow.assetLibraries.save({
      displayName: "竞争库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    registrationId = library.rootIds[0]!;
    const result = await workflow.scanObservedScope({
      registrationId,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: coverRequirement,
    });
    expect(raced).toBe(true);
    expect(result.execution.outcome).toBe("partially-succeeded");
    expect(result.execution.workItems![0]!.outcome).toBe("accepted");
    expect(
      result.execution.dispositions.find(
        (item) => item.observedMaterialConfirmation !== undefined,
      )!.observedMaterialConfirmation!.targets[0],
    ).toMatchObject({
      status: "failed",
      failureCode: "local-material-observation-stale",
    });
    const selection = await catalogue.observedFileSelectionForLocation(
      locationId!,
    );
    expect(
      (await catalogue.readObservedFileConfirmationFacts(selection!))!
        .observation.snapshotId,
    ).toBe(latestSnapshot);
  } finally {
    spy.mockRestore();
    catalogue.close();
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 120000);

it("maximum 1 对每个主体选一张材料图，两个主体都得到真实确认", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(
    path.join(tmpdir(), "digital-material-subjects-"),
  );
  const workflow = composeAssetRefresh(data, {});
  try {
    await writeFile(
      path.join(media, "one.pdf"),
      syntheticPdf({ author: "One", pageCount: 1 }),
    );
    await writeFile(
      path.join(media, "two.pdf"),
      syntheticPdf({ author: "Two", pageCount: 1 }),
    );
    const library = await workflow.assetLibraries.save({
      displayName: "双主体库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const result = await workflow.scanObservedScope({
      registrationId: library.rootIds[0]!,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: coverRequirement,
    });
    expect(result.execution.outcome).toBe("accepted");
    expect(result.itemResults).toHaveLength(2);
    const targets = result.execution.dispositions.find(
      (item) => item.observedMaterialConfirmation !== undefined,
    )!.observedMaterialConfirmation!.targets;
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((target) => target.subjectId)).size).toBe(2);
    expect(targets.map((target) => target.status)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    const page = await workflow.listCurrentCataloguePage({
      informationRequirement: coverRequirement,
    });
    expect(page.items).toHaveLength(2);
    for (const item of page.items)
      expect(
        item.descriptions.some((description) =>
          description.artifactRoles.some(
            (role) => role.role === "asset.primary-cover",
          ),
        ),
      ).toBe(true);
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 120000);

it("检查点之后等大小同时间真实改字节，只局部失败并能在下一次正式重扫恢复", async () => {
  const data = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-material-digest-"));
  const file = path.join(media, "one.pdf");
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  const workflow = composeAssetRefresh(data, {});
  try {
    await writeFile(file, syntheticPdf({ author: "One", pageCount: 1 }));
    await utimes(file, timestamp, timestamp);
    const library = await workflow.assetLibraries.save({
      displayName: "摘要库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const confirm =
      workflow.artifactByteAccess.confirmExpectedObservedRevision.bind(
        workflow.artifactByteAccess,
      );
    const spy = vi
      .spyOn(workflow.artifactByteAccess, "confirmExpectedObservedRevision")
      .mockImplementation(async (input) => {
        await writeFile(file, syntheticPdf({ author: "Two", pageCount: 1 }));
        await utimes(file, timestamp, timestamp);
        return await confirm(input);
      });
    let assetId: string;
    try {
      const result = await workflow.scanObservedScope({
        registrationId: library.rootIds[0]!,
        relativeScope: ".",
        acceptTrusted: true,
        informationRequirement: coverRequirement,
      });
      expect(result.execution.outcome).toBe("partially-succeeded");
      assetId = result.itemResults![0]!.accepted!.entity.id;
      expect(
        result.execution.dispositions.find(
          (item) => item.observedMaterialConfirmation !== undefined,
        )!.observedMaterialConfirmation!.targets[0],
      ).toMatchObject({
        status: "failed",
        failureCode: "artifact-bytes-changed",
      });
    } finally {
      spy.mockRestore();
    }
    const retry = await workflow.scanObservedScope({
      registrationId: library.rootIds[0]!,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: coverRequirement,
    });
    expect(retry.execution.outcome).toBe("accepted");
    expect(retry.itemResults![0]!.accepted!.entity.id).toBe(assetId!);
    await expect(
      SqliteCatalogue.inspectProductionReadiness({
        productDataDirectory: data,
      }),
    ).resolves.toMatchObject({ state: "ready" });
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 120000);

it("其他执行的合法已确认载荷搬入新执行，持久读取明确拒绝跨快照损坏", async () => {
  const data = await preparedCatalogueRoot();
  const damaged = await preparedCatalogueRoot();
  const media = await mkdtemp(path.join(tmpdir(), "digital-material-binding-"));
  const workflow = composeAssetRefresh(data, {});
  try {
    await writeFile(
      path.join(media, "one.pdf"),
      syntheticPdf({ author: "One", pageCount: 1 }),
    );
    const library = await workflow.assetLibraries.save({
      displayName: "绑定库",
      directories: [media],
      recognitionProfileIds: ["books"],
      sourceIdentities: [],
    });
    const input = {
      registrationId: library.rootIds[0]!,
      relativeScope: ".",
      acceptTrusted: true,
      informationRequirement: coverRequirement,
    };
    const first = await workflow.scanObservedScope(input);
    const second = await workflow.scanObservedScope(input);
    expect(second.execution.outcome).toBe("no-change");
    await workflow.close();
    await copyFile(
      path.join(data, "catalogue.sqlite"),
      path.join(damaged, "catalogue.sqlite"),
    );
    const database = new DatabaseSync(path.join(damaged, "catalogue.sqlite"));
    try {
      const row = database
        .prepare(
          "SELECT dispositions_json, audit_json FROM workflow_executions WHERE id = ?",
        )
        .get(second.execution.id) as {
        dispositions_json: string;
        audit_json: string;
      };
      const payload = first.execution.dispositions.find(
        (item) => item.observedMaterialConfirmation !== undefined,
      )!.observedMaterialConfirmation!;
      const dispositions = JSON.parse(
        row.dispositions_json,
      ) as WorkflowExecution["dispositions"];
      const changed = dispositions.map((item) =>
        item.observedMaterialConfirmation === undefined
          ? item
          : { ...item, observedMaterialConfirmation: payload },
      );
      const audit = JSON.parse(row.audit_json) as {
        payload: WorkflowExecution;
      };
      audit.payload = { ...audit.payload, dispositions: changed };
      database
        .prepare(
          "UPDATE workflow_executions SET dispositions_json = ?, audit_json = ? WHERE id = ?",
        )
        .run(
          JSON.stringify(changed),
          JSON.stringify(audit),
          second.execution.id,
        );
    } finally {
      database.close();
    }
    const catalogue = SqliteCatalogue.forProductData(damaged);
    try {
      await expect(
        catalogue.inspectExecution(second.execution.id),
      ).rejects.toThrow(
        /Malformed Workflow Execution local material confirmation/,
      );
    } finally {
      catalogue.close();
    }
  } finally {
    await workflow.close();
    await rm(data, { recursive: true, force: true });
    await rm(damaged, { recursive: true, force: true });
    await rm(media, { recursive: true, force: true });
  }
}, 120000);

function syntheticPdf(input: {
  readonly author: string;
  readonly pageCount: number;
}): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: input.pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${input.pageCount} >>`,
    ...Array.from(
      { length: input.pageCount },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>",
    ),
    `<< /Author (${input.author}) >>`,
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
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}
