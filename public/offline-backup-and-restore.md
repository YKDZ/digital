# 离线备份与恢复

此流程适用于单机 V1 的一个产品数据目录。它恢复 Catalogue、迁移账本、产品托管产物、耐久配置和私有来源连接；不是观察文件、宿主机路径映射或跨安装合并工具。

## 备份前提

先停止 Web、CLI 自动刷新宿主及任何正在执行的 Digital 写入命令。维护命令会取得产品根的跨进程独占维护租约；任一写入者已先取得租约时，备份或恢复会拒绝继续；维护先取得租约时，新的写入者也会拒绝启动。租约在完整复制和正式迁移结束前一直持有，不会进行“检查后再复制”的在线 SQLite 操作。

不要用在线快照、增量备份或云同步替代本流程。升级前也应先完成一次离线备份。

## 创建备份

为备份准备一个不存在或为空的目录。以下命令中的 `DIGITAL_PRODUCT_DATA` 必须是产品数据卷在当前环境中的绝对路径。

```sh
DIGITAL_PRODUCT_DATA=/srv/digital/data \
  pnpm --filter @digital/cli exec cli offline-backup /srv/digital-backups/2026-08-20
```

备份复制完整产品数据根，包含 `catalogue.sqlite` 及其非空 SQLite WAL/SHM、托管产物、耐久配置、私有来源连接和将来新增的耐久产品区域。这样不会因版本升级出现未被维护工具认识的新目录而静默丢失状态。

只有基础设施明确声明可再生的 `cache/`、运行租约状态和恢复暂存目录会排除。观察根与宿主机路径映射不属于产品数据根：它们只由部署的只读挂载提供，因此既不进入备份，也不应被手工放入产品根。请继续通过原有存储保护观察文件本身。

私有来源连接会按原字节和文件权限复制；命令、测试输出和诊断都不显示秘密内容。

## 恢复

使用兼容的应用版本，并准备一个不存在或为空的目标产品数据目录。恢复过程不会覆盖已有目录，也会拒绝符号链接、符号链接祖先或不安全的目录项。

```sh
DIGITAL_PRODUCT_DATA=/srv/digital/restored-data \
  pnpm --filter @digital/cli exec cli offline-restore /srv/digital-backups/2026-08-20
```

恢复先在目标根内创建权限为 `0700` 的私有暂存根；复制完成后启动正式的 `digital-db-migrate prepare-only` 进程。它只按已审阅的生产迁移计划检查或推进 Catalogue；恢复命令不会伪造 schema head 或直接写迁移账本。只有迁移成功才发布耐久目录项。

发布不是跨多个目录项的崩溃原子事务。恢复开始时会持久写入“恢复进行中”标记；若进程中断、发布或回滚失败，后续写入者和恢复都会失败关闭，绝不猜测目标是否完整。维护者必须删除失败的目标产品数据目录，重新创建空目录，再从原备份恢复；不得在原目标上继续重试。

随后用与原部署等价的容器内观察根挂载启动 Web。产品保存的是容器可见路径，不保存或恢复宿主机路径映射；每个已登记文件位置都必须在新部署中再次可读。

## 恢复验收

在启动后的产品数据根上运行以下只读检查。将 `<root-id>` 和 `<execution-id>` 换成恢复前记录的值：

```sh
pnpm --filter @digital/cli exec cli root-list
pnpm --filter @digital/cli exec cli catalogue-surface --surface current-catalogue
pnpm --filter @digital/cli exec cli catalogue-surface --surface current-attention
pnpm --filter @digital/cli exec cli catalogue-surface --surface workflow-history
pnpm --filter @digital/cli exec cli inspect <execution-id> --json
pnpm --filter @digital/cli exec cli source-connection-list
pnpm --filter @digital/cli exec cli scan <root-id> --json
```

这些检查确认原文件位置、当前目录、待处理事项、刷新历史、指定刷新记录和来源连接状态仍可读取；最后一次扫描会在原观察根上重新执行普通刷新路径。对恢复前已接受且观察内容未变化的作品，预期结果为 `no-change`，并保留同一个作品标识而非创建重复作品。

当前仓库尚未交付正式的播放或精确文件下载 CLI/HTTP 入口：Application 只提供后续播放/下载可复用的受控字节来源 seam，Web 也没有可验收的播放或下载路由。因此本恢复流程不能诚实地声称已验证播放或下载；这两项应在对应入口交付后补入同一恢复演练，不能用原型页面或直接文件路径代替。
