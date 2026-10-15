# 普通目录预览与开发更新

`@digital/workspace-automation` 中的普通目录预览实现 是仓库唯一的普通目录准备与接入入口：一条命令把公开的环境生命周期
（`@digital/environment` 的 `prepare / start / inspect / stop / rebuild / delete`）与正式的
产品目录接入串起来，得到一个有资料、可浏览的预览。它不复制环境内部命令，也不自己拼进程、
数据库或来源装配。

```bash
pnpm preview up --material /srv/media/books --material /srv/media/comics --library 我的书架
                         # 两个真实目录归入同一资产库，默认离线；服务保持运行并打印地址
pnpm preview:verify       # 用原受控代表目录运行预览场景断言并按归属收尾
pnpm preview help         # 用法说明（--help 等同）
pnpm preview --help
```

`@digital/test-support/product-client` 是本入口使用的公共产品客户端：只走真实 HTTP 入口
（`/api/ready`、`/api/settings`、`/api/settings/libraries`、`/api/refresh`、`/api/executions/:id`、
`/api/intake`、`/api/catalogue`、`/api/correction-subjects/:id`、`/api/cover-choice/:id`、
`/api/cover-decisions`、`/api/preview`、`/api/artifacts/:digest`、`/api/automation`、
`/api/playback-interactions`），不接内部 Application、不灌库、不 mock 业务。
取消信号在客户端创建时注入：已经排队或进行中的请求都会随取消立即失败，不会留下晚到操作。

## 三个阶段分别报告

1. **准备**：普通资料目录与运行配置被记录，产品数据世代建立。
2. **服务就绪**：只采信环境自己给出的就绪结论（私有控制认证 + 签名探测），不由
   「已准备」或「进程存活」推导。
3. **接入完成**：按产品工作流的终态判断，绝不用就绪掩盖接入失败，也不按资产数量代产品宣布成功。

## 单独执行

`prepare / start / inspect / intake / stop / rebuild / delete` 各自可单独执行，每次都会报告
实际地址、实际端口与产品日志位置。`help`（或 `--help`）打印用法说明后以 0 结束。命令写在选项
之前（`preview up --port 52010`，不是 `preview --port 52010 up`），顺序不对时在请求阶段以 2 拒绝，
不触达任何环境操作。`--workspace`
必须是一份代码检出目录（默认本仓根），运行数据落在 `<工作区>/.digital/environments/<环境>`；
`--material` 与 `--manifest` 按字面值判定，必须是绝对路径，入口不按调用终端的工作目录猜测意图。

## 输入与来源

日常预览必须通过 `--material` 明确选择真实目录，可重复指定；一次接入建立一个命名资产库，
目录内的作品由正式识别流程处理。资产库组织由使用者选择，入口不按作品或测试案例拆库。
复用环境的 `up` 未指定新目录时刷新既有资产库；尚无资产库时沿用环境输入。
`intake` 未指定目录时沿用环境输入。没有已识别资产的目录仍可登记和观察，工作流结论独立报告。

日常来源默认 `offline`，不注入来源响应或合成凭据。需要真实联网时使用：

```bash
pnpm preview up --material /srv/media --library 我的资产 \
  --source-mode real --allow-real-source --real-condition 已确认网络和素材可用
```

需要授权的来源通过产品设置配置真实连接。未配置、不可用或缺少封面时保留实际状态，
入口不替换成测试封面，也不根据测试清单指定作品身份。

`verify` 默认使用 `fixtures/controlled-source-io/material/RJ01668691` 及其受控清单。
完整资料验收由 `verify-audio-post-corpus.ts` 和 `verify-publication-screen-corpus.ts` 显式运行；
它们通过 `corpus-verification.ts` 配置验收所需的合成连接，不参与日常预览。
显式受控模式须提供绝对路径的 `--manifest`。真实模式须同时给出 `--allow-real-source` 与
至少一条 `--real-condition`，缺少条件即拒绝。相对目录、相对清单及 52001—52999 以外的端口同样被拒绝。

日常环境名默认 `completion-01-preview`，验收每次分配独立名称，可用 `--environment` 覆盖。
验收临时输入同样按运行隔离；仅在自建环境成功回收后删除，失败或仍由调用方持有的现场保留输入供复现。

## 归属与收尾

- **自建 verify 环境**：成功后先保存证据，再停止并删除；任何断言失败或异常都改走失败保留分支——
  先停止自有服务，再保留可重启的数据、日志与证据载体，不宣称已回收。
  CI 设置 `DIGITAL_CI_EVIDENCE` 时，结果与隔离输入写入该证据根，成功先停止并保留真实产品数据与日志；由同一 CI 交接在核实上传后调用公共删除入口。
- **恢复上次失败记录**：`failed` 记录（上次准备失败，带着它自己的日志与数据载体）按恢复处理——
  本入口重新准备并拥有**本次启动的服务**，收尾只停止这个服务；那条记录与它的载体不属于本入口，
  成功也不删除，停止与删除仍归原使用者决定。只有本次运行之前完全没有记录（`unprepared`）才取得删除权。
- **`--provided`**：环境由调用方提供，本入口绝不准备、启动、停止、重建或删除它——成功、失败
  与中断都一样，只做只读查看和业务断言，之后仍可被提供方独立使用。
- **`up` 的复用前提**：只有本次运行之前没有任何环境记录（`unprepared`）或上次准备失败
  （`failed`）时，`up` 才自建并取得归属；已有世代一律原样复用——就绪世代直接沿用它的运行地址，
  不重新准备也不重启，归属仍归原使用者，失败也只保留现状。配置不兼容以 3 拒绝，未被接管以 4 拒绝。
- **verify 前提**：环境在本次运行之前已存在且未给 `--provided` 时，只有 `failed` 记录允许按恢复
  运行，其余状态直接拒绝，绝不复用并删除他人状态。
- 主错误与收尾错误始终分开打印，收尾错误不覆盖主错误；`SIGINT`/`SIGTERM` 会中止进行中的
  等待与晚到操作，自有服务按归属停止、现场保留后才退出（130/143），提供方环境原样留下。

## 退出码

| 码  | 含义                                       |
| --- | ------------------------------------------ |
| 0   | 结论成功                                   |
| 1   | 环境或产品操作失败（主错误已打印）         |
| 2   | 用法或来源选择不有效（未触达任何环境操作） |
| 3   | 配置不兼容，需要显式重建                   |
| 4   | 环境不受管理                               |
| 5   | 环境拒绝请求                               |
| 6   | 服务已就绪，但目录接入或业务断言未通过     |
| 130 | 被 SIGINT 中断；资源按归属处理后才退出     |
| 143 | 被 SIGTERM 中断；资源按归属处理后才退出    |

## 覆盖与后续

本入口取代了根上原来的便捷脚本 `prototype`（`pnpm --filter @digital/web dev`）：那个入口
只起前端开发服务，不准备环境、不建产品数据、不做目录接入，也没有归属与收尾约定，因此这些
逻辑过去散落在各人的手工命令里。`pnpm preview` 现在承担同一职责，`verify` 子命令把
「从未接入 → 浏览 / 刷新 / 读取封面 / 人工编辑 / 子集与多目录接入 / 未列入来源请求失败 →
改名、自动刷新、播放进度与人工封面在重启后保留 → 显式重建保持输入字节」做成可重复执行的断言。
日常 `up` 成功后保持服务运行；使用者显式停止、重启、重建或删除。日常预览与代表验证沿用同一
公共生命周期，业务输入、来源响应和预期留在调用方，不由环境能力解释作品。

## 保留产品状态的代码更新

先通过普通预览完成准备和目录接入，再停止现有服务，进入同一个环境的代码更新会话：

```bash
pnpm preview up --environment my-preview --material /srv/media --library 我的资产
pnpm preview stop --environment my-preview
pnpm preview:dev my-preview
```

开发入口要求已有、已停止的准备记录，不重复接入目录，也不重建产品数据。
领域、应用、来源及服务端变更由 Turbo 的实际依赖图构建并替换服务，组件与样式沿用热更新。
编译失败时旧服务停止，完整诊断留在开发日志中；恢复有效代码后会话自动恢复。
各包通过自己的 `dev:compile` 编译本地输出；`dev:build` 交由根开发任务停止旧世代并记录失败，包之间的构建顺序仍由 Turbo 原生图决定。

另一个终端可用 `pnpm preview inspect --environment my-preview` 查看实际地址、更新状态与日志。
用 `pnpm preview stop --environment my-preview` 独立终结本次开发会话；停止后代码变化不再启动服务。
终端中断开发入口也会停止自有服务并保留产品数据及日志。准备、启动、停止、重建和删除仍可单独使用；
普通启动缺省使用生产运行模式，切换模式须先显式停止。

## 与本地自动化并行

开发预览、CLI 和 Web 自动化使用各自的代码检出、环境名、空闲端口、临时目录及证据目录。
每份检出独立安装依赖和构建；开发会话使用自己的 `.turbo/development/dist`，正式构建仍写本检出的
`dist`。只读素材可以共用，产品数据与来源连接设置不可共用，也不要让两份检出互相指向构建输出。
使用原 CLI journey 和 Web managed/provided 入口，不直接启动未经准备的产品进程。

只有实际完成公共停止并确认自有进程退出后才能删除自己的环境。失败现场保留原错误、产品日志和
浏览器诊断，经公共 `start` 显式重启后继续排查；无法确认归属或退出时保留现场，不按端口清理他方资源。

## 单容器与 Compose 部署

部署入口是 [Web Dockerfile](../../apps/web/Dockerfile) 与
[Compose 配置](../../docker-compose.yml)，不需要测试框架或素材清单。以下命令从仓库根目录执行，
要求已有可用的 Docker；Compose 用法另需 Docker Compose。构建使用正式 Turbo 依赖图：

```bash
docker build -f apps/web/Dockerfile --target standalone -t digital-standalone:latest .
docker build -f apps/web/Dockerfile --target runtime -t digital-runtime:latest .
```

`standalone` 携带正式迁移，默认执行 `prepare-and-start`；`runtime` 只启动 Web，不执行迁移，
未准备、版本不兼容、迁移失败或损坏的目录数据库不能就绪。两种镜像默认以 `1001:1001` 运行。
产品数据与被观察文件必须分离：先按部署机器的权限管理方式准备已有目录，使运行用户可读写数据目录、
可读取素材目录及其父目录。以下路径须替换为 Docker 后端机器上的实际绝对路径；远程 Docker 的挂载路径
属于后端机器，镜像与路径也必须在该后端可用。

```bash
export DIGITAL_PRODUCT_DATA_HOST_PATH=/srv/digital/data
export DIGITAL_OBSERVED_ROOT_HOST_PATH=/srv/digital/media
export DIGITAL_UID=1001
export DIGITAL_GID=1001
```

单容器直接准备并启动：

```bash
docker run -d --name digital-web --user "$DIGITAL_UID:$DIGITAL_GID" \
  -p 127.0.0.1:3000:3000 \
  --mount "type=bind,src=$DIGITAL_PRODUCT_DATA_HOST_PATH,dst=/data" \
  --mount "type=bind,src=$DIGITAL_OBSERVED_ROOT_HOST_PATH,dst=/observed/media,readonly" \
  digital-standalone:latest
curl --fail http://127.0.0.1:3000/api/ready
docker logs digital-web
```

也可以先单独准备，再用 `runtime` 启动，替代上面的单容器命令；迁移成功退出后才启动服务：

```bash
docker run --rm --user "$DIGITAL_UID:$DIGITAL_GID" \
  --mount "type=bind,src=$DIGITAL_PRODUCT_DATA_HOST_PATH,dst=/data" \
  digital-standalone:latest prepare-only
docker run -d --name digital-web --user "$DIGITAL_UID:$DIGITAL_GID" \
  -p 127.0.0.1:3000:3000 \
  --mount "type=bind,src=$DIGITAL_PRODUCT_DATA_HOST_PATH,dst=/data" \
  --mount "type=bind,src=$DIGITAL_OBSERVED_ROOT_HOST_PATH,dst=/observed/media,readonly" \
  digital-runtime:latest
```

Compose 复用同一组目录和身份，并显式选择已构建镜像。UID 与 GID 都必须非零；配置不自动创建宿主挂载目录。
`migrate` 成功退出后，`web` 才启动，素材挂载保持只读：

```bash
export DIGITAL_MIGRATION_IMAGE=digital-standalone:latest
export DIGITAL_RUNTIME_IMAGE=digital-runtime:latest
docker compose -p digital-example up -d --no-build --wait
docker compose -p digital-example ps -a
docker compose -p digital-example logs migrate web
curl --fail http://127.0.0.1:3000/api/ready
```

Compose 默认只绑定 `127.0.0.1:3000`，可显式设置 `DIGITAL_BIND_ADDRESS` 与 `DIGITAL_PORT`。
两种部署都通过产品设置接入容器内的 `/observed/media`，挂载本身不会登记资料库或执行目录接入。
单容器用 `docker stop -t 10 digital-web` 停止、`docker start digital-web` 重启；保存所需日志后，
`docker rm digital-web` 删除已停止容器。Compose 用 `docker compose -p digital-example stop -t 10`
停止，`docker compose -p digital-example up -d --no-build --wait` 重启，
`docker compose -p digital-example down` 删除该项目容器与网络。这些命令保留绑定的数据和素材目录；
一致备份须先确认应用退出，再将整个产品数据根作为一个单元保存，素材不属于产品数据备份。

### 受控部署验收

`pnpm check:heavy` 和 `pnpm check:full` 默认运行 standalone 与 Compose 的受控部署验收。根编排显式提供本次工作区、仓库受控素材和 Compose 配置，所属包的准备任务构建正式镜像并准备 Chromium；本地与 CI 使用同一实现。只运行部署范围时使用：

```bash
pnpm exec turbo run deployment --filter=@digital/web
```

验收要求可用的 Unix Docker daemon、后端可见的挂载路径和必要文件权限，不需要私人素材或真实来源授权。准备任务每次确认环境和镜像，Docker／BuildKit 复用原生构建缓存；缓存或镜像缺失时会重建，缺少运行条件会明确失败。

构建网络由 Docker 默认配置提供。宿主网络可达而桥接网络无法访问依赖仓库的开发环境，可显式设置 `DIGITAL_DEPLOYMENT_BUILD_NETWORK=host`，向同一正式构建传入 Docker 的原生网络选项；CI 沿用 runner 的默认网络。

仓库开发容器启用 init 回收孤儿进程，使用 Unix Docker 宿主的网络，并将工作区挂载到与宿主相同的绝对路径，使发布端口、素材和证据目录在验收进程与 daemon 两侧都可访问。更新这项配置后须重建开发容器；既有会话仍使用原来的进程回收方式、路径与网络。

检查默认选择空闲端口，仍可通过 `DIGITAL_DEPLOYMENT_PORT` 与 `DIGITAL_COMPOSE_CHECK_PORT` 指定独占端口。环境及证据使用本次唯一身份；成功先保存证据再回收自有资源，包括已经验证的预期失败反例，真实失败保留诊断和数据。

设置 `DIGITAL_CI_EVIDENCE` 时，检查把自有环境与证据交给同一 CI 收尾流程，核实实际上传之后才删除。镜像构建成功、配置展开或辅助服务启动都不代替部署断言通过。
