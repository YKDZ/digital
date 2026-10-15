# CI 运行与证据

每次 PR 和推送到 main，`Check` 在独占检出中调用同一个根治理实现，先运行轻检查，再运行全部默认重检查。默认范围包括受控 CLI 旅程、浏览器、managed HTTP，以及 standalone／Compose 部署；不需要个人来源凭据或私有素材。Docker daemon、挂载权限和浏览器是受支持运行平台的前置条件，缺失时检查失败。

本地完整验收使用 `pnpm check:full`。CI 收集与上传交接可在独占的新检出中按同一阶段复现：

```sh
pnpm install --frozen-lockfile
TURBO_CONCURRENCY=2 DIGITAL_AUTOMATION_WORKSPACE="$PWD" pnpm --filter @digital/workspace-automation exec node --conditions=digital-source scripts/ci-environment.ts run
DIGITAL_AUTOMATION_WORKSPACE="$PWD" pnpm --filter @digital/workspace-automation exec node --conditions=digital-source scripts/ci-environment.ts collect
```

`run` 直接调用公共门禁的治理实现；包内原生准备任务负责浏览器与正式镜像，不在工作流复制构建逻辑。Turbo 并发限制为 2，镜像构建继续使用 Docker／BuildKit 的层缓存。每次重跑使用新的独占检出和证据目录。

证据默认保存到 `.scratch/ci/full`，可用 `DIGITAL_CI_EVIDENCE` 指定目录。相同变量传到正式 CLI、HTTP 和部署叶入口：它们保留实际产品数据、归属和场景结果，成功后把环境交给 CI 收尾。CLI 保留已有的命令行交接参数，HTTP 保留已有的 keep-on-success 参数；本地未启用 CI 交接时，成功场景按正式生命周期回收，失败现场保留。

`collect` 独立停止并检查本次自有服务和容器，收集整个真实产品数据根及停止后的日志。部署通过公共容器管理接口保存数据，浏览器诊断和命令结果一并进入本次证据目录。执行失败或取消后仍运行停止、收集和上传；一个环境收集失败不阻止其他自有环境停止。

只有实际上传成功，并通过 GitHub API 核实产物 ID、名称、运行归属及有效字节后，`delete` 才调用正式删除。保存或上传失败保留原载体，未知退出状态不删除。执行、保存、上传和清理结果分别报告，删除后的结果也写入实际作业日志。本地 `collect` 成功不能替代真实上传核验。

真实资料、真实来源和 provided 服务继续使用所属包的显式条件验收入口；普通门禁报告这些任务未执行。完整受控验收通过不代表真实来源验收通过。
