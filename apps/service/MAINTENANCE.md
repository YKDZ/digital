# 离线备份与恢复

`@digital/service` 的生产依赖提供 `digital-product-maintenance`。在仓库根目录用
`pnpm product:maintenance` 调用；容器部署使用 `/app/node_modules/.bin/digital-product-maintenance`。
命令只对显式给出的产品数据根操作，不会从当前目录或服务环境猜测路径。

离线操作前，停止 `digital-product-service` 及所有可能写入同一产品数据根的自动化宿主、
工作进程和旧客户端；确认没有其他产品写入者。维护命令仍会获取产品数据维护租约，若根
仍被占用会失败退出，不读取不一致状态，也不与活动服务竞争。备份目标和恢复目标必须是
空目录；恢复不会覆盖现有产品数据。

```sh
pnpm product:maintenance offline-backup \
  --product-data /data/digital \
  --backup-directory /backups/digital-2026-10-18

pnpm product:maintenance offline-restore \
  --backup-directory /backups/digital-2026-10-18 \
  --product-data /data/digital-restored
```

备份包含完整产品数据根中的耐久数据，包括 Catalogue 及其 WAL/SHM、持久配置、私密来源
连接、托管素材和其他耐久目录项；只排除 `cache`、`runtime-state` 与 `staging`。产品观察
到的原始媒体目录位于产品数据根之外，不会复制或改写。恢复后必须让服务在原素材仍可用的
路径上运行。私密来源凭据会随产品数据备份保留，命令输出不会打印凭据内容。

成功时命令以零退出码输出完成信息；任何准备、复制、迁移、发布或收尾失败都以非零退出码
报告，恢复未完成时不会输出成功信息。恢复失败会留下中断标记并阻止该目标根被当作可用
产品启动。保留原备份；确认失败目标可丢弃后，使用一个新的空目标目录重试恢复。
