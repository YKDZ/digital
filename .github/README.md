# CI 运行与证据

默认 `Check` 工作流在三个独立的 GitHub 托管工作区并发运行：根检查仍为 `pnpm run check`；CLI 仍调用本地 `test:e2e` 的受控旅程；Web 仍调用真实 HTTP 浏览器入口。默认范围不需要个人来源凭据、私有语料、开发监听或 Docker。

本地可按相同阶段复现（先冻结安装，CLI/Web 先按正式 Turbo 图构建依赖，Web 安装 Chromium）：

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@digital/web --filter=@digital/cli --filter=@digital/db-migrations
node --conditions=digital-source scripts/ci-environment.ts run cli
node --conditions=digital-source scripts/ci-environment.ts collect cli
```

将 `cli` 换为 `web` 可运行浏览器链；`root` 需要独占的新工作区，运行前会登记环境目录为空。证据默认保存到 `.scratch/ci/<root|cli|web>`，可用 `DIGITAL_CI_EVIDENCE` 选择本次独立目录。每次重跑应使用新目录，避免覆盖前次证据。

CI 根检查按托管运行器的资源预算将 Turbo 任务并发限制为 2，CLI/Web 保持默认 10；本地相同条件用 `TURBO_CONCURRENCY=2 node --conditions=digital-source scripts/ci-environment.ts run root` 复现，内部仍执行 `pnpm run check`，测试和作业期限保持不变。

CLI 的 `--retain-on-success` 保持成功结局，停止并确认退出后暂不删除产品数据；不提供该选项时仍按原本行为回收。Web 使用已有 `--keep-on-success true`，成功后服务仍运行，后续 `collect` 会经公共 stop/inspect 停止并独立确认退出，然后收集整个真实产品数据根和停止后的完整日志。适用的浏览器诊断随场景结果保留。收集失败不会阻止其他明确自有环境的停止。

CI 在执行失败、超时或取消后仍进入独立停止、收集与上传步骤。上传要求有真实文件；只有实际 upload-artifact 成功，并通过 GitHub API 核实产物 ID、名称、运行归属和有效字节后，才调用公共 delete。保存或上传失败不执行删除；未知退出状态保留载体，执行、保存和清理结果分别报告。删除后的结果另写入实际作业日志，避免只留在已经上传之后的本地文件里。本地 `collect` 成功仅证明收集完成，不能代替真实上传。

Docker 部署只在手工触发时显式选择 `deployment`。该作业先使用现有 Dockerfile 构建 standalone/runtime 两目标，向原 `check:deployment` 传入两份明确镜像引用，再运行既有部署断言。未选择或未执行该作业不表示部署通过。完整真实资料与来源验收继续使用各自显式入口和既有条件，不纳入默认 CI。
