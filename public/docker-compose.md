# 单机 Docker Compose 部署

Digital V1 的正式部署形态是根目录的 `docker-compose.yml`：一个短命的 `migrate` job 先准备产品数据目录，成功后才允许唯一常驻的 `web` 容器启动；该容器同时包含 Web、API、Execution Host 与自动刷新轮询。它不引入多 worker、Kubernetes、systemd 或宿主机路径转换。

## 前置条件

- Docker Engine 与 Docker Compose v2。
- 一个由部署者创建、归 `DIGITAL_UID:DIGITAL_GID` 所有的空产品数据目录。
- 一个或多个由部署者管理的观察目录；示例只挂载一个，且必须给容器运行身份读取权限。

选择 NAS 上可用的非 root 身份，例如：

```sh
export DIGITAL_UID=1000
export DIGITAL_GID=1000
export DIGITAL_PRODUCT_DATA_HOST_PATH=/path/on/host/digital-product-data
export DIGITAL_OBSERVED_ROOT_HOST_PATH=/path/on/host/observed-media
export DIGITAL_BIND_ADDRESS=127.0.0.1
export DIGITAL_PORT=3000
```

首次部署前创建产品目录，并将其所有权交给上述身份；不要让 Compose 自动创建路径：

```sh
install -d -m 0750 -o "$DIGITAL_UID" -g "$DIGITAL_GID" "$DIGITAL_PRODUCT_DATA_HOST_PATH"
docker compose build
docker compose up -d
```

`DIGITAL_UID` 和 `DIGITAL_GID` 都必须是非零整数。Compose 入口会在每次启动时再次拒绝 UID 或 GID 为 `0` 的配置，不能以 root 运行来绕过目录权限设置。

`migrate` 只挂载 `/data`，不挂载观察目录。`web` 把产品数据固定为容器内绝对路径 `/data`，观察目录固定为只读 `/observed/media`。在产品的“文件位置”设置中登记 `/observed/media`；不要写入上述宿主机路径，也不要建立宿主机—容器路径映射。

多个观察根时，复制 `web.volumes` 的只读 bind mount，分别指定稳定的容器内绝对目标（例如 `/observed/books`），然后在产品中登记该目标。产品数据目录不得与任何观察根重叠。

## 运行检查与故障处理

`/api/live` 只证明 Node 进程能够应答；`/api/ready` 还要求 migration、Catalogue、能力声明和 Execution Host 恢复分类已完成。Compose 健康检查调用 `/api/ready`，所以迁移失败、未准备或不兼容的 Catalogue 不会标记为健康，且 `web` 因 `service_completed_successfully` 不会启动。

```sh
curl -fsS http://127.0.0.1:"$DIGITAL_PORT"/api/live
curl -fsS http://127.0.0.1:"$DIGITAL_PORT"/api/ready
docker compose ps
docker compose logs migrate web
```

停止或重建容器时保留产品数据目录：

```sh
docker compose down
docker compose up -d --build
```

不要使用会清除产品数据目录的操作。Catalogue、目录状态、Execution history、Source Connection 私有状态和已识别资产均位于 `/data`，会在重建后保留；观察文件始终由部署者独立备份和管理。

升级前停止服务并整体复制产品数据目录。恢复时提供同一个容器内观察根路径及其只读挂载，然后从兼容版本启动。正式迁移只向前进行；不支持降级、自动恢复或用 `push` 作为生产入口。
