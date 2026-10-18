# 数字资料库终端

`digital-tui` 是连接独立产品服务的终端客户端。服务要先启动；TUI 不启动或管理服务。`--url` 接受服务地址根路径（不带 `/api/v1`），也可用 `DIGITAL_PRODUCT_URL` 设置，默认是 `http://127.0.0.1:3000`。`--execution <编号>` 可直接打开已有执行记录。

`@digital/tui` 的正式命令入口是包中的 `digital-tui` bin，指向 `dist/cli.js`；安装包包含构建后的 `dist`，仓库里的 `src` 不是可直接运行的命令。服务已经运行时，只需沿正式 Turbo 依赖图构建 TUI 及其依赖，再运行构建产物连接服务：

```bash
pnpm exec turbo run build --filter=@digital/tui...
SERVICE_URL=http://127.0.0.1:3000 # 改为现有服务地址；托管环境可查看 inspect 输出
node apps/tui/dist/cli.js --url "$SERVICE_URL"
```

本机已安装 `digital-tui` 时，也可直接执行 `digital-tui --url "$SERVICE_URL"`。只有准备新的完整受控开发环境时才使用 `pnpm development:controlled`；服务生命周期与 TUI 客户端构建、运行相互独立。

## 导航与资料库操作

在列表页按 `1`、`2`、`3`、`4`、`5`、`6`、`7` 切换资产库、资产、未识别材料、执行、待处理、历史和来源连接。用方向键或 `j`、`k` 移动，`Enter` 选择资产库，`n`、`p` 翻页，`/` 筛选本页，`r` 重读，`q` 退出。

资产库页按 `c` 创建、`e` 修改、`d` 移除、`s` 扫描、`a` 配置自动刷新。创建或修改时输入库名和目录，再选择识别能力及来源；用方向键移动、空格切换、回车保存。目录由产品服务所在机器访问，TUI 不上传客户端文件。输入 `-路径` 可从当前目录列表移除目录；移除资产库需再按 `y` 确认。

扫描页显示本次执行编号、各目录结果、已识别材料归属及失败原因；资产和未识别材料分别在 `2`、`3` 页查看。

执行页显示执行编号和结果。执行仍在进行时可按 `c` 请求取消，按 `r` 重新查询。连接在执行期间断开时，结局暂时未知；恢复连接后用原执行编号查询，不要重复发起扫描或刷新。退出或重启终端后，可用 `digital-tui --url "$DIGITAL_PRODUCT_URL" --execution <编号>` 回到同一执行查看状态；服务管理日志位置见 [`workspace-automation` 使用说明](../../packages/workspace-automation/README.md)。

TUI 用于管理资产库、扫描和查看资料状态、已观察资料及来源记录；它不播放音视频，也不提供打开原文件的阅读器。

## 本机与远程连接

远程工作区的素材目录仍由服务器访问。若从服务所在机器的终端运行 TUI，将 `--url` 设为 `pnpm environment inspect` 输出的服务地址。浏览器在本机时，可从本机通过 SSH 转发服务器回环端口。例如 OAuth 应用登记为 `http://localhost:4321/api/v1/source-connections/bangumi/callback`，本机 4321 转发到服务器服务监听端口 4321：

```bash
ssh -N -L 4321:127.0.0.1:4321 account@server
```

本例中本机转发端口、服务器 `webPort` 和回调 URI 端口都设为 4321，便于与已登记回调地址配合；一般并不要求三者相等。Bangumi 应用登记的完整回调 URI 须与服务收到的回调目标一致；SSH TCP 转发保留浏览器请求中的 HTTP Host。连接服务器的终端中运行 TUI 时，`--url` 使用服务机器上 `inspect` 显示的地址：

```bash
SERVICE_PORT=4321 # 改为 inspect 输出的服务器端口
SERVICE_URL="http://127.0.0.1:${SERVICE_PORT}"
pnpm --filter @digital/service exec digital-tui --url "$SERVICE_URL"
```

本机已安装 `digital-tui` 时，可在开启上述 SSH 转发后，从本机终端连接同一个远程服务：

```bash
digital-tui --url http://127.0.0.1:4321
```

Bangumi 回调路由为 `/api/v1/source-connections/bangumi/callback`。授权时 TUI 会显示实际目标实例和回调目标；浏览器应打开该授权地址，并能通过配置的回调 URI 到达正在使用的服务。

## 来源连接

按 `7` 打开来源连接，使用方向键选择来源，`Enter` 或 `c` 配置，`r` 重读，`x` 撤销并确认。

- TMDB：输入 TMDB API Read Access Token（访问令牌）。OMDb：输入 OMDb API key。TUI 隐藏输入，立即验证后保存；更换已配置连接也会先验证新值。
- Bangumi：OAuth 应用信息通过现有公共客户端 `PublicApiClient.configureBangumiOAuthClient()` 配置，当前 TUI 不提供填写应用密钥的操作。公共 HTTP API 接受 `PUT /api/v1/source-connections/bangumi/client-configuration`，字段为 `clientId`、`clientSecret` 和 `redirectUri`。将 JSON 请求体保存在仓库外、仅当前用户可读的文件中，再从该文件发送，避免将密钥写入命令历史或进程参数：

  ```bash
  SERVICE_URL=http://localhost:4321
  curl --fail --silent --show-error --request PUT \
    "$SERVICE_URL/api/v1/source-connections/bangumi/client-configuration" \
    --header 'content-type: application/json' \
    --data-binary @/path/to/private/bangumi-oauth.json
  ```

  JSON 文件包含应用 `clientId`、`clientSecret` 和登记的 `redirectUri`。不要将密钥写进 `--config-json`、资产库基线或版本控制。用户授权时在来源连接页选择 Bangumi 并按 `Enter`，在自己的浏览器打开终端显示的授权地址，返回终端等待结果。

- FANBOX：按 `f` 输入创作者编号并发起限时配对；需在已登录 FANBOX 的浏览器扩展中完成配对。创作者编号不是登录凭据。

来源连接密钥与授权保存在服务端的私密状态中，与普通环境配置和初始资产库基线分开。普通停止和启动会保留连接；显式重建会清除授权，之后须在对应来源重新连接。来源连接撤销也不会改变已配置的资产库目录。
