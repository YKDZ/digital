# 环境工作流与预览验收

日常环境通过根命令 `pnpm environment` 管理。首次进入须显式选择 `--source-mode`；普通目录示例使用离线来源：

```bash
pnpm environment enter --environment my-preview --source-mode offline --input /srv/media
pnpm environment inspect --environment my-preview
pnpm environment stop --environment my-preview
pnpm environment enter --environment my-preview
```

从其他检出操作时可加 `--workspace-path <代码检出目录>`。`--input` 可重复指定普通目录；受控来源还须通过 `--config-json` 选择受控来源清单。`enter` 负责环境准备与独立产品服务就绪，不发起资料接入或全库刷新；首次 ready 不代表初始资料已建立。后续资料操作仍通过产品正式工作流完成。

## 来源配置、初始库基线与故障恢复

首次 `enter` 保存环境的来源模式、素材目录和非秘密运行配置。`offline` 不启用真实外部来源；`real` 使用真实来源网络；`controlled` 还须在 `--config-json` 的 `sourceIo` 中指定受控清单路径和内容身份。这里的配置只选择运行方式，不能存放 API 密钥、OAuth 应用密钥或用户授权。普通服务连接使用终端的「来源连接」流程；Bangumi OAuth 应用设置及远程回调见[终端说明](../../apps/tui/README.md#来源连接)。

下面以服务监听 `webPort` 为 4321 的已验证连接方式为例，在首次 `enter` 前选定空闲端口，并在 Bangumi 应用登记完整回调地址 `http://localhost:4321/api/v1/source-connections/bangumi/callback`：

```bash
pnpm environment enter --environment my-remote --source-mode real \
  --input /srv/media --config-json '{"webPort":4321}'
pnpm environment inspect --environment my-remote
```

服务器服务地址会是 `http://127.0.0.1:4321`。回调浏览器在本机时，从本机用 `ssh -N -L 4321:127.0.0.1:4321 account@server` 转发，再从服务器终端或本机已安装的 `digital-tui` 连接同一服务。本例中本机转发端口、服务器 `webPort` 和回调 URI 端口都设为 4321，便于复用已登记的回调地址；一般并不要求三者相等。Bangumi 回调校验使用服务收到的完整 URL 与登记的回调 URI 比较，TCP 转发保留 HTTP Host。端口被占用时管理命令会失败，不会接管或自动改用其他端口；已准备的环境不能用重入命令更换 `webPort`。已有服务的 TUI 构建和连接方式见[终端说明](../../apps/tui/README.md)。

用 TUI 创建、修改或移除资产库并确认当前目录组织后，可以显式保存或更新初始资产库基线。该公共 API 快照只保存库名、目录、识别能力和来源选择，不保存来源连接密钥或授权；执行后返回已保存的库数：

```bash
SERVICE_URL=http://127.0.0.1:3000
curl --fail --silent --show-error --request POST \
  "$SERVICE_URL/api/v1/asset-library-initial-configuration" \
  --header 'content-type: application/json' --data '{}'
curl --fail --silent --show-error \
  "$SERVICE_URL/api/v1/asset-library-initial-configuration"
```

把 `SERVICE_URL` 设为 `inspect` 输出的当前服务地址。之后若需更新基线，先在 TUI 保存新的库配置，再重复 `POST`；TUI 目前没有单独的「保存基线」按键。该管理 API 由 `pnpm environment` 托管的服务提供。

普通停止和启动保留产品数据、来源连接与当前库状态；重新 `enter` 只复用已保存的环境配置，也不会扫描或刷新。`rebuild` 必须在服务停止后运行，它清空该环境自有产品数据、业务状态和来源私密连接，保留素材目录、环境来源选择、日志及单独保存的初始库基线。重建后重新进入服务会恢复基线里的库组织，但不会扫描素材；Bangumi OAuth 应用设置和用户授权都要重新配置。

```bash
pnpm environment stop --environment my-preview
pnpm environment rebuild --environment my-preview
pnpm environment enter --environment my-preview
pnpm environment inspect --environment my-preview
```

故障时先只读运行 `pnpm environment inspect --environment <环境名>`，查看环境状态、来源模式、素材路径、服务地址、运行日志和最近操作日志位置。`enter`、`prepare`、`start` 的失败结果也会给出阶段和日志目录；保留这些日志及环境数据后再决定下一步，不要用 `delete` 代替诊断。扫描或刷新期间连接断开时，结局未知；记下 TUI 显示的执行编号，服务重新就绪并恢复连接后用 `digital-tui --url "$SERVICE_URL" --execution <执行编号>` 查询同一执行，不要重复发起操作。远程工作区中的目录由服务机器解释；远程连接和 TUI 操作见[终端说明](../../apps/tui/README.md#本机与远程连接)。

## 完整受控开发资料

新工作区可用一个明确的命令准备、启动并初始化完整受控默认资料：

```bash
pnpm development:controlled -- --environment my-controlled-workspace
pnpm environment inspect --environment my-controlled-workspace
pnpm --filter @digital/service exec digital-tui --url http://127.0.0.1:<端口>
```

`development:controlled` 会先沿正式 Turbo 构建图构建当前 TUI 及其公开 API 依赖，再准备服务并初始化资料。使用 `inspect` 返回的服务端口启动 TUI。

初始化会配置受控来源，创建名为“完整受控开发资料”的单个资产库，并登记 `audio-posts/material` 与
`publication-screen/material` 两个实际父目录后执行一次正式扫描。它沿用同一份 29 根参考：分别报告安全观察、正式识别范围与明确未识别范围；这些数值是参考目录覆盖，不代表资产数量。受控模式只替换外部请求与 FANBOX 浏览器会话传输，未声明请求明确失败且不会回退真实网络。初始化命令只接受尚未准备的新环境；失败时停止本次启动的服务并保留环境数据供排查。

正式扫描后，初始化会为 `film-directed` 目录显式提交一次 TMDB 电影编号 `9509` 的来源定向识别，再通过正式执行查询读取结果。该步骤只指定人工来源输入，不预置资产边界、身份或关系；服务重启或普通重入均不会重做扫描或该步骤。

在 TUI 列表页按 `1` 检查资产库、按 `2` 检查资产、按 `3` 检查未识别材料。完成检查后用 `pnpm environment stop --environment my-controlled-workspace` 停止服务；普通重入只用 `pnpm environment enter --environment my-controlled-workspace`，会保留已生成的业务状态且不会重扫。

完整共同运行的唯一正式验收入口是 `pnpm verify:controlled-default`。常规验收使用完整资料；专项用例可从同一份语料选择子集，不改变上述日常库组织。真实目录与真实来源由使用者另行显式选择 `--source-mode real`；离线工作区继续显式使用 `--source-mode offline`，两者都不等同于完整受控默认环境。

## 保留的产品验收

`pnpm preview:verify` 保留原有预览产品验收链路：它通过公开环境生命周期准备服务，再用真实 HTTP 产品客户端覆盖首次浏览、人工封面、子集与多目录接入、未列来源拒绝、重启后状态保留及显式重建输入字节保持。`--case <名称>` 可选跑指定场景。

验收默认使用 `fixtures/controlled-source-io` 下的受控代表目录和清单。真实来源默认关闭，必须同时提供 `--allow-real-source` 与至少一个 `--real-condition`；受控清单及普通目录都须使用绝对路径。

自建验收环境成功后先保存证据、停止服务再回收；断言失败或取消时停止本次启动的服务并保留数据与日志。`--provided` 只读查看调用方环境并执行业务断言，不停止或删除该环境。CI 设置 `DIGITAL_CI_EVIDENCE` 时，验收会把数据与证据交给同一 CI 收尾流程。

## 开发更新

现有代码更新入口 `pnpm preview:dev <环境名>` 要求目标环境已准备并停止。它负责开发更新会话，不承担普通资料接入；首次准备与停止仍使用正式环境入口：

```bash
pnpm environment enter --environment my-preview --source-mode offline --input /srv/media
pnpm environment stop --environment my-preview
pnpm preview:dev my-preview
```

`enter` 使用产品正常运行配置。此链路中的代码更新行为由 `preview:dev` 自身负责；正式环境入口只报告准备、服务就绪与本次业务未执行状态。开发预览与产品专项验收使用各自的代码检出、环境名、端口、临时目录与证据目录。只读素材可以共用，产品数据与来源连接设置不可共用。

## 单容器与 Compose 部署

部署入口是[服务 Dockerfile](../../apps/service/Dockerfile)与
[Compose 配置](../../docker-compose.yml)，不需要测试框架或素材清单。以下命令从仓库根目录执行，
要求已有可用的 Docker；Compose 用法另需 Docker Compose。构建使用正式 Turbo 依赖图：

```bash
docker build -f apps/service/Dockerfile --target standalone -t digital-service-standalone:latest .
docker build -f apps/service/Dockerfile --target runtime -t digital-service-runtime:latest .
```

`standalone` 携带正式迁移，默认执行 `prepare-and-start`；`runtime` 只启动独立产品服务，不执行迁移，
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
docker run -d --name digital-product-service --user "$DIGITAL_UID:$DIGITAL_GID" \
  -p 127.0.0.1:3000:3000 \
  --mount "type=bind,src=$DIGITAL_PRODUCT_DATA_HOST_PATH,dst=/data" \
  --mount "type=bind,src=$DIGITAL_OBSERVED_ROOT_HOST_PATH,dst=/observed/media,readonly" \
  digital-service-standalone:latest
curl --fail http://127.0.0.1:3000/api/ready
docker logs digital-product-service
```

也可以先单独准备，再用 `runtime` 启动，替代上面的单容器命令；迁移成功退出后才启动服务：

```bash
docker run --rm --user "$DIGITAL_UID:$DIGITAL_GID" \
  --mount "type=bind,src=$DIGITAL_PRODUCT_DATA_HOST_PATH,dst=/data" \
  digital-service-standalone:latest prepare-only
docker run -d --name digital-product-service --user "$DIGITAL_UID:$DIGITAL_GID" \
  -p 127.0.0.1:3000:3000 \
  --mount "type=bind,src=$DIGITAL_PRODUCT_DATA_HOST_PATH,dst=/data" \
  --mount "type=bind,src=$DIGITAL_OBSERVED_ROOT_HOST_PATH,dst=/observed/media,readonly" \
  digital-service-runtime:latest
```

Compose 复用同一组目录和身份，并显式选择已构建镜像。UID 与 GID 都必须非零；配置不自动创建宿主挂载目录。
`migrate` 成功退出后，`service` 才启动，素材挂载保持只读：

```bash
export DIGITAL_SERVICE_MIGRATION_IMAGE=digital-service-standalone:latest
export DIGITAL_SERVICE_RUNTIME_IMAGE=digital-service-runtime:latest
docker compose -p digital-example up -d --no-build --wait
docker compose -p digital-example ps -a
docker compose -p digital-example logs migrate service
curl --fail http://127.0.0.1:3000/api/ready
```

Compose 默认只绑定 `127.0.0.1:3000`，可显式设置 `DIGITAL_BIND_ADDRESS` 与 `DIGITAL_PORT`。
两种部署都通过产品设置接入容器内的 `/observed/media`，挂载本身不会登记资料库或执行目录接入。
单容器用 `docker stop -t 10 digital-product-service` 停止、`docker start digital-product-service` 重启；保存所需日志后，
`docker rm digital-product-service` 删除已停止容器。Compose 用 `docker compose -p digital-example stop -t 10`
停止，`docker compose -p digital-example up -d --no-build --wait` 重启，
`docker compose -p digital-example down` 删除该项目容器与网络。这些命令保留绑定的数据和素材目录；
一致备份须先确认应用退出，再将整个产品数据根作为一个单元保存，素材不属于产品数据备份。

### 受控部署验收

`pnpm check:heavy` 和 `pnpm check:full` 默认运行 standalone 与 Compose 的受控部署验收。验收先按正式服务 Dockerfile 构建独立服务镜像，再通过真实 HTTP 产品 API 配置多目录资产库、扫描并回读结果；素材来自 `@digital/preview-corpus` 的公开资源。开发与 CI 使用同一实现。只运行部署范围时使用：

```bash
pnpm exec turbo run deployment --filter=@digital/service
```

验收要求可用的 Unix Docker daemon、后端可见的挂载路径和必要文件权限，不需要私人素材或真实来源授权。准备任务每次确认环境和镜像，Docker／BuildKit 复用原生构建缓存；缓存或镜像缺失时会重建，缺少运行条件会明确失败。

构建网络由 Docker 默认配置提供。宿主网络可达而桥接网络无法访问依赖仓库的开发环境，可显式设置 `DIGITAL_DEPLOYMENT_BUILD_NETWORK=host`，向同一正式构建传入 Docker 的原生网络选项；CI 沿用 runner 的默认网络。

仓库开发容器启用 init 回收孤儿进程，使用 Unix Docker 宿主的网络，并将工作区挂载到与宿主相同的绝对路径，使发布端口、素材和证据目录在验收进程与 daemon 两侧都可访问。更新这项配置后须重建开发容器；既有会话仍使用原来的进程回收方式、路径与网络。

检查默认选择空闲端口，仍可通过 `DIGITAL_DEPLOYMENT_PORT` 与 `DIGITAL_COMPOSE_CHECK_PORT` 指定独占端口。环境及证据使用本次唯一身份；成功先保存证据再回收自有资源，包括已经验证的预期失败反例，真实失败保留诊断和数据。

设置 `DIGITAL_CI_EVIDENCE` 时，检查把自有环境与证据交给同一 CI 收尾流程，核实实际上传之后才删除。镜像构建成功、配置展开或辅助服务启动都不代替部署断言通过。
