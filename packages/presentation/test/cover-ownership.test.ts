import { describe, expect, it } from "vitest";

import { projectAssetView } from "../src/index.ts";
import {
  entityDescription,
  revisionDescription,
  viewFacts,
  viewLocation,
} from "./view-facts.ts";

describe("作品封面与文件图片归属", () => {
  it("只选择当前作品的有效封面，不让其他主体或普通附件补位", () => {
    const withoutOwnCover = projectAssetView(
      viewFacts({
        id: "audio-work",
        descriptions: [
          entityDescription("audio-work", [["asset.title", "音声作品"]]),
          entityDescription(
            "script-book",
            [],
            [["asset.primary-cover", "script-page", "/managed/script.png"]],
          ),
          revisionDescription(
            "script-pdf",
            "script-revision",
            [],
            [["asset.material-image", "script-page", "/managed/script.png"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "script-page-location",
            artifactId: "script-page",
            kind: "managed",
            address: "/managed/script.png",
          }),
          viewLocation({
            id: "script-pdf-location",
            artifactId: "script-pdf",
            kind: "observed",
            address: "/media/台本.pdf",
            confirmedRevisionId: "script-revision",
          }),
        ],
      }),
    );

    expect(withoutOwnCover.cover).toBeUndefined();
    expect(withoutOwnCover.files).toEqual([
      {
        name: "台本.pdf",
        format: "PDF",
        revisionId: "script-revision",
        image: "/managed/script.png",
      },
    ]);

    const withOwnCover = projectAssetView(
      viewFacts({
        id: "audio-work",
        descriptions: [
          entityDescription(
            "audio-work",
            [],
            [
              [
                "asset.primary-cover",
                "official-cover",
                "/managed/official.jpg",
              ],
            ],
          ),
          entityDescription(
            "other-work",
            [],
            [["asset.primary-cover", "other-cover", "/managed/other.jpg"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "other-cover-location",
            artifactId: "other-cover",
            kind: "managed",
            address: "/managed/other.jpg",
          }),
          viewLocation({
            id: "official-cover-location",
            artifactId: "official-cover",
            kind: "managed",
            address: "/managed/official.jpg",
          }),
        ],
      }),
    );
    expect(withOwnCover.cover).toBe("/managed/official.jpg");
  });

  it("不把旧修订版的图片投影到当前文件", () => {
    const view = projectAssetView(
      viewFacts({
        id: "book",
        descriptions: [
          revisionDescription(
            "book-pdf",
            "old-revision",
            [],
            [["asset.material-image", "old-page", "/managed/old.png"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "book-pdf-location",
            artifactId: "book-pdf",
            kind: "observed",
            address: "/media/book.pdf",
            confirmedRevisionId: "current-revision",
          }),
          viewLocation({
            id: "old-page-location",
            artifactId: "old-page",
            kind: "managed",
            address: "/managed/old.png",
          }),
        ],
      }),
    );

    expect(view.cover).toBeUndefined();
    expect(view.files).toEqual([
      {
        name: "book.pdf",
        format: "PDF",
        revisionId: "current-revision",
      },
    ]);
  });

  it("明确单文件承载整项内容时同一精确图片可同时服务作品与文件", () => {
    const view = projectAssetView(
      viewFacts({
        id: "single-book",
        descriptions: [
          entityDescription(
            "single-book",
            [],
            [["asset.primary-cover", "page-image", "/managed/single.png"]],
          ),
          revisionDescription(
            "single-pdf",
            "single-revision",
            [],
            [["asset.material-image", "page-image", "/managed/single.png"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "single-pdf-location",
            artifactId: "single-pdf",
            kind: "observed",
            address: "/media/single.pdf",
            confirmedRevisionId: "single-revision",
          }),
          viewLocation({
            id: "page-image-location",
            artifactId: "page-image",
            kind: "managed",
            address: "/managed/single.png",
          }),
        ],
      }),
    );

    expect(view.cover).toBe("/managed/single.png");
    expect(view.files).toEqual([
      {
        name: "single.pdf",
        format: "PDF",
        revisionId: "single-revision",
        image: "/managed/single.png",
      },
    ]);
  });

  it("同级封面冲突不供图并保留为事实问题，必需资料的缺失列入缺失事实", () => {
    // 原断言：同一目标上「读取声明冲突」与「读取已供出有效角色地址」不能并存。现行正式
    // 读取在 association-conflict 与 decision-unusable 分支只返回冲突、角色集合为空
    // （packages/application/src/effective-fact-reads.ts 的两条 return [] 分支），因此负项
    // 夹具按读取实际产生的形状书写；展示层不得再自己判一次角色资格。
    const siblings = {
      kind: "artifact-association-conflict" as const,
      role: "asset.primary-cover",
      references: [
        {
          kind: "artifact-association" as const,
          associationId: "association-a",
        },
        {
          kind: "artifact-association" as const,
          associationId: "association-b",
        },
      ],
      explanation: "当前图片存在多个同等合格的选择",
    };
    const unusableDecision = {
      kind: "artifact-role-decision-unusable" as const,
      role: "asset.primary-cover",
      references: [
        {
          kind: "artifact-role-decision" as const,
          decisionId: "cover-decision",
        },
        {
          kind: "artifact-association" as const,
          associationId: "association-a",
        },
      ],
      explanation: "已选封面不再是当前内容，请重新选择或撤回",
    };

    // 合法正项基底：只有一个合格候选时确实供出封面且没有事实问题。
    const resolved = projectAssetView(
      viewFacts({
        id: "book",
        descriptions: [
          entityDescription(
            "book",
            [],
            [["asset.primary-cover", "page-image", "/managed/page.png"]],
          ),
        ],
        locations: [
          viewLocation({
            id: "page-image-location",
            artifactId: "page-image",
            kind: "managed",
            address: "/managed/page.png",
          }),
        ],
      }),
    );
    expect(resolved.cover).toBe("/managed/page.png");
    expect(resolved.factProblems).toEqual([]);

    // 两个同级候选：不得任选一张图，冲突原样呈现给使用者，且已请求角色不被伪造成缺失。
    const conflicted = projectAssetView(
      viewFacts({
        id: "book",
        descriptions: [
          entityDescription("book", [], [], { conflicts: [siblings] }),
        ],
        locations: [
          viewLocation({
            id: "page-a-location",
            artifactId: "page-a",
            kind: "managed",
            address: "/managed/page-a.png",
          }),
          viewLocation({
            id: "page-b-location",
            artifactId: "page-b",
            kind: "managed",
            address: "/managed/page-b.png",
          }),
        ],
      }),
    );
    expect(conflicted.cover).toBeUndefined();
    expect(conflicted.factProblems).toEqual([
      {
        target: { kind: "entity", entityId: "book" },
        message: "这项内容有尚未解决的资料或图片选择",
        conflicts: [siblings],
      },
    ]);
    // 缺失事实是公开可选字段：没有确定缺失时正式投影省略该键（presentation/src/index.ts
    // 在无缺失时不写出 missingFacts），因此带冲突的角色不能被伪造成一条缺失。
    expect(conflicted.missingFacts).toBeUndefined();

    // 已选决定失效是读取产生的另一类冲突，展示处理规则相同：抑制供图并保留审计。
    const decisionUnusable = projectAssetView(
      viewFacts({
        id: "book",
        descriptions: [
          entityDescription("book", [], [], { conflicts: [unusableDecision] }),
        ],
        locations: [
          viewLocation({
            id: "page-a-location",
            artifactId: "page-a",
            kind: "managed",
            address: "/managed/page-a.png",
          }),
        ],
      }),
    );
    expect(decisionUnusable.cover).toBeUndefined();
    expect(decisionUnusable.factProblems).toEqual([
      {
        target: { kind: "entity", entityId: "book" },
        message: "这项内容有尚未解决的资料或图片选择",
        conflicts: [unusableDecision],
      },
    ]);
    expect(decisionUnusable.missingFacts).toBeUndefined();

    // 被请求且必需、当前读取确定为缺失的属性与角色才进入缺失事实；可选缺失不制造缺失。
    // 正式读取的确定缺失只来自 requested 选择器范围，因此夹具按视图真实请求的坐标声明范围。
    const lacking = projectAssetView(
      viewFacts({
        id: "incomplete-book",
        descriptions: [
          entityDescription("incomplete-book", [["asset.title", "书名"]], [], {
            requestedMetadata: [
              "asset.title",
              "asset.introduction",
              "asset.declared-language",
            ],
            missingProperties: [
              "asset.introduction",
              "asset.declared-language",
            ],
            missingArtifactRoles: ["asset.primary-cover"],
          }),
        ],
        informationReadiness: {
          subjectId: "incomplete-book",
          status: "unavailable",
          inputs: [
            {
              kind: "metadata",
              coordinate: "asset.introduction",
              necessity: "required",
              status: "unavailable",
            },
            {
              kind: "artifact-role",
              coordinate: "asset.primary-cover",
              necessity: "required",
              status: "unavailable",
            },
            {
              kind: "metadata",
              coordinate: "asset.declared-language",
              necessity: "optional",
              status: "unavailable",
            },
          ],
        },
      }),
    );
    expect(lacking.missingFacts).toEqual([
      "asset.introduction",
      "asset.primary-cover",
    ]);
    expect(lacking.title).toBe("书名");
    expect(lacking.cover).toBeUndefined();
  });
});
