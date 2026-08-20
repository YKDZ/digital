# V1 产品范围

V1 是一套供单个可信用户自托管的真实数字资产目录，而不是继续以 CLI、固定样例或原型界面代替产品。它必须使用真实文件和真实官方来源完成识别、采用、浏览、刷新、审阅与基础消费闭环，并在进程重启后保留权威状态和可审计历史。

## 已确认的用户旅程

- 用户可以配置受观察目录和适用来源凭据，通过普通扫描、自动入库、Drop 或定向识别添加内容；这些入口使用同一 Asset Refresh Workflow 和 proposal-to-decision path。
- 用户可以在正式设置中建立和维护需要授权的在线来源；公开来源无需配置，环境变量和挂载的私有文件只是部署时的可选引导或覆盖方式，不是普通使用的唯一入口。各来源只解释自己的授权输入和生命周期，私密值由产品管理的本地私有存储保管，不进入 Digital Assets、Source Records、普通目录状态、诊断或固定样例。可信单用户 V1 不建立加密保险库、账户隔离或通用凭据模型。
- 用户可以把容器内可见的绝对路径登记为只读“文件位置”，并为每个位置选择链接跟随策略和允许的链接目标位置。添加内容、Drop、定向识别、手动刷新与自动刷新都只选择这些位置内的有限范围；自动刷新只是独立附加的周期安排，停用它不会撤销文件访问。产品不建立宿主机与容器路径的映射层。
- 部署必须在应用启动前提供唯一的产品数据目录；空目录可以初始化 Catalogue，正式设置不能在线改变这个自举位置。SQLite Catalogue、托管产物、来源连接私有存储和持久配置位于其明确子区域，可删除缓存具有独立边界。改用另一目录表示打开另一套安装；V1 迁移采用停机后整体移动，不复制受观察文件。
- V1 唯一正式生产部署是文档化的 Docker Compose 单容器：一个 `/data` 可写产品数据卷，若干以只读方式挂载并在产品内登记的受观察目录。镜像以非 root 用户运行，NAS 读取权限和 UID／GID 映射由部署者配置；容器不发现宿主机路径或获得媒体写权限。Kubernetes、多容器 worker、systemd 裸机、桌面安装包和厂商 NAS 套件暂不支持，`pnpm dev` 只用于开发。
- V1 提供并实际演练停机整体备份与恢复：停止应用后复制产品数据目录，恢复到兼容应用版本并重新提供登记过的容器挂载路径。备份覆盖 Catalogue、托管产物、持久配置和来源连接私有存储；明确可删除的缓存可以重建，受观察原文件仍由用户自己的存储方案保护。验收恢复后的浏览、历史、来源连接、手动刷新和直接播放，不实现在线、增量、云端或跨安装合并。
- 可信的确定结果可自动采用；不确定、冲突或需要审阅的结果进入统一 Inspection Workspace 和 Attention Inbox。
- 用户可以浏览资产、关系、可用产物和已经采用的来源事实，并执行“刷新元数据”与“重新刮削”；操作结果可审计，需审阅的结果在采用前使用正式 Asset View 投影展示。
- 正式 Web 界面覆盖日常旅程，并为 DLsite、FANBOX、书籍、番剧和电影提供适合其信息结构的 Asset View；这不会在 Digital Assets 中建立对应媒体类型。
- 用户可以下载一个准确且当前可访问的 Artifact Revision。Delivery 以附件方式流式传输并隐藏服务器路径；尚无确认修订版的本地文件只在本次请求时渐进哈希，确认过程中变化则失败并要求普通刷新。该能力可服务书籍、FANBOX 附件、脚本和其他产物，但不提供浏览器内联打开、临时 PDF／EPUB 阅读器、下载历史、托管副本、整作品 ZIP 或导出布局；资产、目录和文件树的成员范围不能由下载接口猜测。
- 受观察目录保持只读；目录整理、导出和 Metadata Writeback 不属于当前已确认的 V1 发布门槛。

## 架构发布门槛

- Source Refresh Run、每个来源范围的 Source Refresh Change Set、审阅、过期检查、取消和终态必须由 Digital Assets 拥有权威语义；Workflow Execution 只协调并引用，SQLite Adapter 只持久化和条件追加。
- 每个 Asset View 与后台工作分别提供一份完整 Information Requirement，并通过同一 Application fulfillment 与 Information Readiness 路径获得信息；不再从子 View fragments 合成通用 superset，也不允许交互与自动扫描获得不同信息。
- Capability declaration 必须包含完整 kind、版本和 interpretation contract，Composition 校验唯一性，Workflow 恢复兼容性与历史 provenance 覆盖所有实际参与的能力。
- 正式 V1 必须能从产品内完成所需 Source Connection 的建立、状态检查、替换、撤销或重新授权；OAuth、浏览器导出凭据、访问令牌等差异保留在各自能力与外层配置界面，Composition 只注入能力专用的私有访问。缺失或失效的授权只使对应来源工作明确不可用，不能提交空 Source Record 或抹去既有事实。
- 文件位置、来源连接和适用设置的变更无需重启应用。新的 Workflow Execution 在开始时读取并冻结本次有限范围、非私密配置版本、能力声明和规划输入；运行中的执行不会因设置变化而被静默重新规划或自动取消，后续刷新和自动触发自然采用最新配置。执行记录不保存凭据，撤销授权只会使尚未完成的对应来源工作明确失败。
- 应用启动时检查所有非终态的长 Workflow Execution，不区分手动、Drop、定向识别或自动触发。兼容执行从最近持久断点恢复，等待审阅的执行继续等待；无法满足冻结版本、配置、引用或断点条件的执行进入明确的中断终态并保留已提交结果和原因，不能永久停留在“正在刷新”。恢复不回滚 Domain 结果、不自动开启替代刷新，也不增加网络重试、分布式队列或 exactly-once 基础设施。
- V1 由 Web 进程内唯一的 Execution Host 统一托管手动、Drop、定向识别和自动刷新等长执行。HTTP 在执行已持久化且被宿主接受后立即返回编号，任务不依附请求生命周期。关闭时停止新操作和触发，允许任务在有限时间内停到安全断点后再关闭 SQLite；未完成者下次启动恢复，进程关闭不等于用户取消。它不建立持久队列、重试策略或第二套状态模型，并允许以后不改变 Application 合同地拆分 worker。
- 只有产品数据目录、Catalogue schema 或数据库完整性、必要 migration、能力声明唯一性与合同兼容性等核心前提失败才阻止正常启动。单个来源连接或文件位置缺失、失效、未挂载或不可访问时，已有目录、无关来源和可用内容继续工作；依赖它的新工作明确阻塞或失败，自动刷新避免在前提未恢复时反复制造等价失败记录。局部故障不能被静默跳过后报告成功，也不能据此认定文件消失。
- 固定真实语料的 29 个逻辑根目录全部通过只读、安全、无误识别和明确未识别的安全门；其中 24 个通过真实官方来源完成端到端识别：8 个 DLsite 音声、5 个 FANBOX 帖子、7 个独立 EPUB／PDF 出版物、2 部番剧和 2 部电影。严格命名电影验证自动识别，非规范 BDMV 电影验证定向识别、TMDB＋OMDb 组合和格式部件不会制造资产。3 个音乐目录、1 个目录型视觉设定集和 1 个目录型漫画暂时保持安全但未识别。已审阅 oracle 只验证正确结果，不能提供固定网络响应或绕过识别；缺网时在线门自然失败。
- SQLite 继续作为 V1 catalogue store，但 Drizzle schema 是结构的唯一代码来源，查询通过 Drizzle 构造。当前未发布的开发阶段可在适当时通过 `drizzle-kit pull` 从现有 catalogue 建立完整 schema 起点，审阅并修正后删除旧手写 SQL migration 与不完整 mirror，随后使用 `drizzle-kit push` 直接演进可重建的开发和测试数据库；接近首次正式发布时才冻结第一份 baseline migration，此后正式 catalogue 只通过向前 migration 升级。保留 `@digital/sqlite` 作为 Application Persistence Ports 的具体 Adapter，不恢复可供 Web 直接查询的通用 `db` package；其内部查询按 Persistence Port 与事务一致性范围组织，而不是按表建立通用 repository。正式 migration tooling 保持独立；Domain、Presentation 与 Delivery 不接触 schema、Drizzle database 或查询模块。
- 正式容器采用 YKDZ/template `vike-app` 的生产准备模式：standalone 入口在 Web 接受请求前运行独立部署的 Drizzle migration，另提供 prepare-only 与已由外部准备数据库的 start-only 方式；运行时再次校验 Catalogue readiness。未准备、版本更新、migration 失败或完整性失败的数据库不能提供服务。正式部署不用 `push`、不支持降级，升级前使用停机整体备份；migration 只处理产品数据结构，不访问受观察目录。
- 生产 Web 分离进程 liveness 与 Catalogue readiness。readiness 要求 migration、Catalogue 核心检查、能力声明校验和所有非终态执行的恢复分类已经完成，但不等待长执行结束；单个来源或文件位置故障只是局部降级。Docker 普通健康检查使用 readiness，prepare-only 容器不提供 HTTP 健康接口；响应不得泄露凭据、完整私有路径、数据库错误栈或来源正文。
- Persistence Ports 由 Application 用例、原子提交和明确查询塑形，不从 Domain 类型或数据库表机械生成。Drizzle schema 只为数据库必须独立保证的唯一性、lineage、条件追加、引用完整性和高频查询关系化；不可变证据、版本化工作流输入、检查点与整体读取的审计载荷可以使用显式版本 JSON。当前 Catalogue 与 Attention 可以使用可重建投影，但任何权威 Domain lifecycle 都不能只存在于查询投影或 Workflow JSON 中。
- 每个受观察 logical root 实现 ADR-0037 的明确 symlink policy：不跟随、只跟随文件链接、或跟随文件与目录链接。跟随目标必须位于当前 root 或另一个容器内可见且明确授权的 target root；不建立宿主机／容器路径映射。链接别名保持普通 Location，目录遍历检测循环与重复目标，断链、越界、权限错误和扫描中变化产生诊断与不完整覆盖。固定语料覆盖三种策略、断链、越界和循环。
- 文件位置登记具有独立于 Automation Intent 的持久身份、显示名称、容器内绝对路径和链接边界策略；它属于 Application 配置而不是 Domain 目录、媒体库或资产分类。产品数据与托管产物目录不得和任一受观察位置重叠。
- 移除文件位置只撤销后续扫描、播放和文件读取权限，并停用依赖它的自动刷新；登记身份、历史执行、Location、资产、关系、来源事实与决定继续保留。撤销访问不是完整文件观测，不能据此认定文件已经消失或删除目录内容。原登记可以重新连接，无关路径必须登记为新的文件位置。
- 正式 Asset View 与播放器接入时收口当前 optional-bag 和多处分派，使新增一种 View 的选择、完整投影和 delivery 映射保持局部；不为此引入运行时插件注册。
- 大量真实资产浏览前，将当前 Catalogue、Workflow Execution 历史和当前 Attention 投影分成用途明确的 Application 查询；普通浏览不再遍历全部永久审计历史后在 Web 去重。
- V1 的 Current Catalogue、Workflow History 和 Current Attention 分别通过分页的直接 Drizzle 查询从权威当前状态或历史读取；不预先存储展示结果，也不设计物化投影、同步或重建机制。若真实规模以后证明有必要，可在不改变 Application 与 Presentation 合同的前提下增加可重建的读取优化。
- 不以文件长度为理由整体重写 Application 或 SQLite；重构沿真实用户旅程建立职责明确、可独立验证的模块，并保持 Application-owned transaction 与 conditional-append 语义。

## 正式界面采用方式

- 不继续维护一个覆盖全部产品的巨大 prototype。一次只选择一个完整界面或紧密相关的用户旅程，使用真实形状的数据覆盖正常、加载、空白、部分可用、阻塞、失败和响应式状态。
- 每个 prototype 现场验收视觉、用词和交互后，立即拆分并应用到正式 View Components 与 routes，接入真实 Presentation model，补齐回归验证并删除该 prototype route 与专用 fixture，然后才进入下一个界面。
- App Shell、视觉 token、规范用语和 shadcn-vue widgets 是正式维护的共享基础，不由每个 prototype 重新创建；prototype 仍是设计验证产物，不是领域事实、长期兼容界面或生产架构。

## 首个播放切片

- V1 提供真实可用的直接播放，而不是只预留播放器按钮或未被使用的抽象。
- 首个验收对象是包含多个文件与目录层级的 DLsite 音声作品，播放体验参考 Kikoeru 的作品文件树、当前播放队列和常驻播放控制，但不复制其按路径和扩展名建立身份的实现。
- 用户可以从作品内明确选择可播放文件；选择一个音频时以当前文件树层级的可播放文件形成临时 Playback Queue，并从所选文件开始顺序播放。队列支持“添加到播放队列”和“下一首播放”，跨页面导航保留但无需在关闭浏览器后恢复。
- Playback Queue 的顺序和目录分组只属于 Asset Presentation，不建立 Collection、Entity Relationship、Metadata Assertion 或资产层级。队列项引用准确的 Artifact Revision，文件名可用于展示但不成为元数据或身份。
- V1 提供播放、暂停、进度跳转、上一首、下一首、音量和当前队列；随机、循环、睡眠定时和保存播放列表不作为发布门槛。
- 每个单独音频文件的播放位置和完成状态绑定到准确的 Artifact Revision 并自动保存；内容变化后，旧位置不会静默应用到新修订版。当前目录或 Playback Queue 可以派生本次选择的进度，但无法稳定定义全作品进度的资产种类不记录作品级进度，也不从目录名称、全部文件或替代编码推断它。
- V1 直接播放浏览器原生支持的本地音频和视频；不支持的容器或编码显示明确原因。
- Delivery 通过同一套媒体中立、支持 HTTP Range 的读取通道提供 Playback Rendition，使浏览器能够按需取得字节、开始播放和跳转位置，而不必先下载完整文件。流地址不暴露或接受任意服务器文件路径；音频和视频 Asset View 不各自实现文件读取。
- 直接使用原始修订版、未来转码得到的媒体以及字幕转换结果都表现为 Playback Rendition。它默认只在播放期间存在或作为可回收缓存复用，不会自动成为正式 Artifact；只有另一项明确的保留、整理或导出操作可以将输出持久化。
- 播放端声明自身支持能力和用户选择的音轨、字幕或质量偏好，由 Application 自动生成 Playback Plan；直接播放优先，普通用户不选择处理器或编辑处理步骤。媒体与字幕可以有各自的有序处理路径，V1 不建立通用 DAG 或用户可编程媒体管道。
- Application 与 Delivery 的播放路径从首个切片起保持媒体中立；DLsite 音声负责完成第一条真实用户旅程，兼容的视频可以复用相同路径，不兼容的视频返回明确原因。普通播放不建立持久 Playback Session 或 Workflow Execution；暂停、切换文件、播放结束和页面隐藏时保存有产品意义的交互状态，V1 不要求定时轮询同步。
- 首个播放切片强制验收真实语料中的 MP3 与 WAV；MP4 可用于验证共享读取路径，但不扩大为完整视频兼容承诺。Playback Plan 保留独立字幕路径，LRC 与 VTT 仍可出现在作品文件树中，但 V1 不要求自动配对或同步显示；Presentation 不通过同名或目录邻近自行建立音频与字幕关系，后续必须由适用目录或格式能力提供明确配对证据。
- 转码、字幕转换、BDMV 菜单、DRM、远程串流和复杂播放列表不属于首个播放切片，但播放准备结构不能阻止以后增加这些能力。

## 暂不作为发布门槛

- 完整播放器或阅读器生态，以及对所有容器、编码和字幕格式的兼容。
- 浏览器内联打开原文件、内建书籍阅读器、阅读进度、书签和批注。
- 账户管理、权限模型和面向公网的安全加固。
- 运行时安装第三方插件或动态兼容性协商。
- 覆盖所有未来数字资产种类。

本文只记录产品范围和可验收结果。领域语言由各 CONTEXT 文档维护，架构取舍由 ADR 维护；实现包、组件库和路由结构不在本文中定义。
