# Team Studio

以本机 Codex app-server 为执行引擎的多团队管理面板。支持团队树、团队统一接口与能力、成员独立模型、负责人派发、成员反馈、审批、历史续聊和办公室状态展示。

在「团队配置 → 执行接口 / 工具与能力」统一设置，新增成员默认沿用所属团队，后续修改自动同步。已有成员保留原配置，可点击「让全体直属成员沿用团队设置」一次应用；个别成员可在 Agent 配置中切换为「独立配置」。设置仅影响直属成员，子团队保留各自配置，历史续聊沿用原快照。修改后点击「保存更改」。工具与能力选择仍为配置偏好，实际执行权限由本机 Codex 控制。

## 下载与安装

- [下载 Windows x64 便携版](https://github.com/z7256422/TeamStudio/releases/latest)：自带 Node，完整解压后双击 `Start.cmd`。
- [GitHub Packages](https://github.com/z7256422/TeamStudio/packages)：提供 `@z7256422/team-studio` npm 安装包，需要 Windows x64、Node.js 24+ 和 GitHub Packages 登录。
- [版本变化](CHANGELOG.md) · [完整安装与发布流程](work/docs/releases.md)。

以上安装方式执行 Agent 任务时都需要本机已安装并配置 Codex；发布包不包含个人配置或登录凭据。

## 源码运行

```powershell
npm start
```

打开 http://127.0.0.1:3210。源码运行需要 Node.js 24+；执行任务还需要本机安装并配置 Codex。便携包自带 Node，使用 Start.cmd / Stop.cmd。

- [使用说明与完整 HTTP/SSE API](outputs/README.md)
- [安全与可靠性审查、修复边界](work/docs/security-reliability-review.md)
- [前端模块与开发说明](work/panel-src/README.md)
- [成员成果交接协议](work/docs/team-results.md)

```powershell
npm test
npm run build
npm run package
npm run package:npm
```

`npm test` 自动发现全部测试，包括真实 Codex app-server 配合本机模拟模型的传输测试，不调用付费模型。开发环境缺少 Codex 时该项会明确跳过；发布打包强制设置 `REQUIRE_CODEX_TEST=1`，必须通过全部测试、构建和解压包冒烟验证。

版本号唯一来源是 `work/server/app-info.cjs`；健康接口、Codex 初始化、分发文件名、manifest 和包内说明均引用它。运行数据、本机配置、凭据、环境变量文件、包含个人信息的本地记录和分发包由 `.gitignore` 排除。
