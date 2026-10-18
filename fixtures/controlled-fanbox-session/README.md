# 受控 FANBOX 会话夹具（Custom Udon 单选取）

本目录为「会话来源在真实产品进程中受控」提供仓库内的最小资料、封闭端点响应、合成凭据与各份
清单，供 Web 与 CLI 可执行根在受控模式下重复读取。默认执行不读取 `.scratch/acceptance-corpus`，
也不接触任何真实来源凭据；这里的会话凭据是合成值，只满足既有的形状校验，没有真实登录能力。

## 内容

- `material/customudon/23.12.31 コスプレ4/Season 1/`：缩减后的资料目录，只含一个自造轻量视频，
  用于观察正式创作者／发布日期目录约定。缩减输入里不含封面图片，因此托管主图只能来自独立图片请求。
- `responses/`：四个 FANBOX 封闭端点响应（login-status、limit=1 验证摘要、limit=300 采集摘要、
  connected 详情）与一个普通图片响应（主图 PNG）。
- `connections/synthetic-customudon.json`：合成浏览器请求上下文，经正式 `fanbox-connection-import`
  或 Web 设置 configure 提交给产品验证与私有存储；其值不得出现在 UI、日志或来源记录里。
- `expectations/customudon-7225781.reviewed-oracle.json`：人工复核后的期望投影，并明确列出该
  oracle 不支持的推断。
- 清单：`manifest.json` 为完整成功链路，其余每份各删掉或替换一条成功链路必需的条目，用作因果反例。

会话条目声明的是封闭端点，不是 URL。请求键由创作者范围、端点种类、该端点必要的 limit／postId／access
以及条目声明的合成私有上下文摘要共同决定，因此 `connected` 与 `public` 是两个不同条目，绝不互相借用。

## 真实、缩减与代表性取值

| 项目                                                                                                                        | 取值来源             | 说明                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| creatorId `customudon`、postId `7225781`、`2023-12-31T17:10:55+09:00`、标题 `Movie \| コスプレ4`、形态 `file`、封面 present | 真实参考             | 与独立审阅 oracle 一致                                                                                                                                                                                                                       |
| 真实根与文件层级                                                                                                            | 真实参考（只读核对） | `.scratch/acceptance-corpus/assets/media/animation/Custom Udon/23.12.31 コスプレ4`，原文件为 `Season 1/S01E01 - Cosplay4.mp4`（533393220 字节）、`Specials/S00E01 - Voice.mp4`（346704967 字节）、`poster.jpg`（67869 字节）；本夹具不改原根 |
| 缩减父目录名 `customudon`                                                                                                   | 输入变换             | 既有创作者标识规则不接受空格，`Custom Udon` 无法命中约定，故改为 oracle 已确认的 creatorId                                                                                                                                                   |
| 缩减目录内的 MP4                                                                                                            | 自造                 | 由 `@digital/workspace-automation` 的受控会话生成器 生成的结构正确最小盒序列，不是可播放视频，也不是原帖附件字节                                                                                                                             |
| 摘要与详情里的 `feeRequired`、`user.name`、附件 `f1` 的名称／大小／扩展名／地址                                             | 协议代表值           | 按既有解析契约给出，只覆盖实际走到的分支；不声称完整创作者历史，也不声称附件字节                                                                                                                                                             |
| 主图地址与 PNG 字节                                                                                                         | 协议代表值           | oracle 只记录封面 present，未保留地址与字节；不得写成该帖真实封面下载录像                                                                                                                                                                    |
| `login-status` 的 `{ "body": 0 }`                                                                                           | 协议代表值           | 连接验证要求的成功信封形态                                                                                                                                                                                                                   |
| 合成 userAgent／Cookie 值                                                                                                   | 自造                 | 没有真实登录能力；`manifest-mismatched-context.json` 声明另一个合成上下文摘要，用于证明摘要属于请求键                                                                                                                                        |

## 清单内容身份

内容身份与声明顺序无关，覆盖清单条目与本目录响应字节，因此改动任一响应字节都会改变身份：

- `manifest.json`：`sha256:92337ecdb997ab1a10f3aeb651d597ac90116571a3874119fc00e5e84ad933eb`
- `manifest-without-session.json`：`sha256:bd6ceb6789818c47449f83a967a616067d412c075a99ddf5d6a419f27126df25`
- `manifest-without-login-status.json`：`sha256:80159d05180a83815b5f204ec0a4fff9853ff1d47fed8006323aa9bab5766c5a`
- `manifest-without-verify-summaries.json`：`sha256:dd06043f179fe22d82b9cc8e60c6481f777c552be2c987f8fc1cc01e86fd07cb`
- `manifest-without-post-detail.json`：`sha256:c50e3084d4d4e03fb1ef0c7304afee3f6d7d668941e0af1c2ed6d1c0e7db818d`
- `manifest-without-collect-summaries.json`：`sha256:2fd9e7658c103fffc1eaaec80277aa547107f7c456ed18c05ce8c43028071bab`
- `manifest-without-cover-image.json`：`sha256:b4a4a760236092b58463bd8753cd9b9af47106972253a10ecd639694869b8a26`
- `manifest-public-detail-only.json`：`sha256:042774f7c46e470b3cfaf0074b7133acdf5967ab33b3a0c68ffb1439906dd5ce`
- `manifest-mismatched-context.json`：`sha256:343e6404186a5bea2be6919b5e7e263e51c31acf18396c7308e025d6b0abf03c`
- `manifest-other-creator.json`：`sha256:d2ebc5d6e4538c70714f630575a401188d7950abbf1ff5e9d5f8a6e85ff542dc`
- `manifest-detail-creator-mismatch.json`：`sha256:eddc6afc3d3aaa72e2b3d02c4ef2dc0177e3442932c869b96c7d82cd073ec24a`
- `manifest-public-detail-creator-mismatch.json`：`sha256:43906b41b83ad80e1170488ec17e6fbe3bd0dccec6ebd144dc29e3a9b3f1389a`

对应义务：`manifest-without-session.json` 证明配置验证不由普通请求代替；缺少 login-status 或 limit=1
摘要时连接验证不成立；`connected` 详情是验证与采集共同的端点键，缺少它两条链路都不成立；缺少 limit=300
摘要时采集无法形成帖子；缺少普通图片条目时托管主图未满足；只声明 `public` 详情时不能借用已连接响应；
声明的合成上下文或创作者范围与产品实际使用不符时整个事务被拒。后两份只把详情条目的声明创作者换成
另一个范围，login 与摘要仍属 `customudon`，因此它们专门证明详情这一条也受创作者范围约束，`connected`
与 `public` 都是如此。

## 重新生成与核验

```
pnpm fixture:fanbox-session
```

脚本重写资料、响应与合成凭据文件，打印各清单的绝对路径与内容身份，以及合成上下文的摘要标识，
供受控模式配置直接使用。输出完全确定，因此内容身份只在清单文本或响应字节被改动后变化。
