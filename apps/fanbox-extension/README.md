# FANBOX 浏览器连接器

## 安装

1. 在仓库根目录运行 `pnpm --filter @digital/fanbox-extension build`。
2. 在 Chromium 打开 `chrome://extensions`，启用“开发者模式”。
3. 选择“加载已解压的扩展程序”，选中 `apps/fanbox-extension/dist`。

Chromium 在加载时会说明扩展读取浏览器 Cookie 所需的权限。扩展只会在用户明确启动连接后读取 FANBOX 会话；目标服务和 FANBOX 站点访问权限会在连接步骤中分别申请。

## 连接

1. 在 Digital TUI 打开菜单 7“来源连接”，按 `f` 输入 FANBOX 创作者编号。
2. 保持 TUI 中的连接请求等待，记下服务地址、目标实例编号、请求编号和限时配对码。
3. 确认当前 Chromium 配置已登录 FANBOX，点击工具栏扩展图标打开独立连接页，填写 TUI 显示的信息并选择“检查目标与创作者范围”。四项输入会保存在当前浏览器会话中；重新打开页面后仍需手动检查目标。
4. 核对服务实例和创作者范围，再选择“使用此浏览器登录状态连接”。Chromium 会分别询问目标服务与 FANBOX 的访问权限。
5. 扩展只读取 FANBOX 域名 Cookie，并自动附上当前浏览器 User-Agent；目标服务完成正式 FANBOX 登录验证后才会私密保存连接。

服务地址需使用完整的 HTTP 或 HTTPS 地址。扩展会请求该地址的精确来源权限；是否允许 HTTP 地址由当前 Chromium 版本与部署环境的浏览器权限规则决定。连接请求有时限，取消、替换或过期后，旧请求不能再写入连接。
