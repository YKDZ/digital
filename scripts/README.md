# 普通目录预览与开发更新

`scripts/preview-environment.ts` 是仓库唯一的普通目录准备与接入入口：一条命令把公开的环境生命周期
（`@digital/environment` 的 `prepare / start / inspect / stop / rebuild / delete`）与正式的
产品目录接入串起来，得到一个有资料、可浏览的预览。它不复制环境内部命令，也不自己拼进程、
数据库或来源装配。

```bash
pnpm preview              # 准备、启动并自然接入完整29根轻量资料，服务保持运行并打印浏览地址
pnpm preview:verify       # 用原受控代表目录运行预览场景断言并按归属收尾
pnpm preview help         # 用法说明（--help 等同）
node scripts/preview-environment.ts --help
```

`scripts/preview-product.ts` 是本入口使用的产品客户端：只走真实 HTTP 入口
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

## 默认输入与来源

- 日常预览默认选择 `fixtures/preview-corpus/coverage.json` 的两批完整资料：29 根安全观察目录，
  其中 24 根属于识别范围、5 根明确保持未识别。索引逐项引用原 `cases.json` 和 `references.json`；
  根数量不代表资产数量。EPUB、PDF、图片、音视频是可执行轻量输入，不证明完整读取、播放或性能。
- `verify` 保持票 06 的受控代表目录 `fixtures/controlled-source-io/material/RJ01668691`
  和原清单，默认检查不依赖完整资料。专项可用 `--material` 显式选择任意普通目录（可重复），
  包括共同资料中的某个子目录。
- 来源默认**受控**：完整预览使用共同 `fixtures/preview-corpus/manifest.json`，仅引用两批原响应字节；
  `--manifest` 可显式选择其它清单（绝对路径）。入口按内容身份核验后交给环境，产品根再复核一次。
  已收录资料所需的合成来源连接通过正式设置入口配置；既有连接（包括撤销或不可用状态）不被替换。
- **真实来源默认关闭**：必须同时给 `--allow-real-source` 与至少一条 `--real-condition`，
  条件会被原样报告；缺条件即拒绝，不静默落回真实装配。
- 相对清单、相对资料目录、区间外端口（只允许 52001—52999）都在请求阶段被拒绝。
- 环境名默认 `completion-01-preview`（日常入口）与 `completion-01-verify`（verify），都可用
  `--environment` 覆盖。

## 归属与收尾

- **自建 verify 环境**：成功后先保存证据，再停止并删除；任何断言失败或异常都改走失败保留分支——
  先停止自有服务，再保留可重启的数据、日志与证据载体，不宣称已回收。
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
日常 `up` 成功后保持服务运行；使用者显式停止、重启、重建或删除。完整默认资料与代表验证沿用同一
入口及生命周期，业务输入、来源响应和预期留在调用方，不由环境能力解释作品。

## 保留产品状态的代码更新

先通过普通预览完成准备和目录接入，再停止现有服务，进入同一个环境的代码更新会话：

```bash
pnpm preview up --environment my-preview
pnpm preview stop --environment my-preview
pnpm preview:dev my-preview
```

开发入口要求已有、已停止的准备记录，不重复接入目录，也不重建产品数据。
领域、应用、来源及服务端变更由 Turbo 的实际依赖图构建并替换服务，组件与样式沿用热更新。
编译失败时旧服务停止，完整诊断留在开发日志中；恢复有效代码后会话自动恢复。

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

部署入口是 [Web Dockerfile](../apps/web/Dockerfile) 与
[Compose 配置](../docker-compose.yml)，不需要测试框架或素材清单。以下命令从仓库根目录执行，
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

### 显式部署检查

默认根检查不启动 Docker。已构建镜像、可用 Docker 后端、独占检查端口、可写证据目录及 Playwright Chromium
就绪后，可单独调用已有部署检查入口；两类证据分别保存：

```bash
export DIGITAL_DEPLOYMENT_STANDALONE_IMAGE=digital-standalone:latest
export DIGITAL_DEPLOYMENT_RUNTIME_IMAGE=digital-runtime:latest
export DIGITAL_DEPLOYMENT_ARTIFACTS="$PWD/.scratch/deployment/standalone"
export DIGITAL_COMPOSE_CHECK_ARTIFACTS="$PWD/.scratch/deployment/compose"
pnpm --filter @digital/web deployment
```

单容器检查默认使用端口 `8080`，Compose 检查默认使用端口 `3000`，可分别通过
`DIGITAL_DEPLOYMENT_PORT` 与 `DIGITAL_COMPOSE_CHECK_PORT` 指定独占端口。检查只管理自己创建的对象，
失败时保留诊断和数据；镜像构建成功、配置展开或辅助后端启动都不能代替检查实际通过。
