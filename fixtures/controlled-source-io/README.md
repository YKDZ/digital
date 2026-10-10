# 受控来源夹具（DLsite 单选取）

本目录为普通请求受控外部 I/O 提供仓库内的最小资料、响应与期望，供 Web 与 CLI 可执行根在
受控模式下重复读取。默认执行不读取 `.scratch/acceptance-corpus`，也不接触任何私人来源凭据。

## 内容

- `material/RJ01668691/`：缩减后的作品目录，只含一个自造音轨，用于观察与准入。
- `responses/`：三条普通响应（作品接口 JSON、作品页 HTML、封面 PNG）。
- `manifest.json`：三条都收录的清单；`manifest-without-cover.json` 只收录前两条，用作
  「元数据成功但必需的封面产物未满足」的反例。
- `expectations/RJ01668691.reviewed-oracle.json`：人工复核后的期望投影。

清单内容身份（与顺序无关，可重复计算）：

- `manifest.json`：`sha256:0595bf9c66f739a60b67ac434391e7e274d5f268df5509637c48b73c4fefa6e8`
- `manifest-without-cover.json`：`sha256:2dcbe48a543b5b8eb0b01cee51a4904737f237d7a4c67a8ce56c1884a2f9043e`

## 真实、缩减与代表性取值

| 项目 | 取值来源 | 说明 |
| --- | --- | --- |
| 产品编号 RJ01668691、标题、简介、发售日、年龄分级、语言、maker_id | 真实参考 | 与人工复核 oracle 一致，接口结构按 DLsite 官方响应形态书写 |
| 价格、封面图片地址 | 协议代表值 | 独立 oracle 未记录这两项；按 DLsite 响应形态给出，不代表该作品真实下载录像 |
| 作品页 HTML 的圈名、声优／脚本／插画、 genres 链接 | 协议代表值 | 按解析器要求的表格与链接结构构造，非逐字节真实页面 |
| 封面 PNG 与音轨 WAV | 自造 | 由 `scripts/build-controlled-source-io-fixture.ts` 生成，字节确定 |
| 全库结构统计（`regularFileCount`、`descendantDirectoryCount`、`treeMetadataSha256`） | 不适用 | oracle 中的这些数值描述完整验收语料，缩减夹具只含一个文件，不能据此比对 |

## 重新生成与核验

```
node --experimental-strip-types scripts/build-controlled-source-io-fixture.ts
```

脚本重写两个媒体文件，并打印两份清单的绝对路径与内容身份，供环境配置直接使用。
