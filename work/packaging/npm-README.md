# Team Studio {{VERSION}}

基于本机 Codex app-server 的多团队协作面板，支持团队树、成员派发、双向反馈、审批、历史续聊和办公室状态。

## 安装

运行环境：Windows x64、Node.js 24+。执行 Agent 任务还需要本机安装并配置 Codex CLI。

本包发布到 GitHub Packages。先使用 GitHub 用户名和具有 `read:packages` 权限的 personal access token (classic) 完成 npm 登录；Token 只在本机登录提示中输入。

```powershell
npm login --scope=@z7256422 --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @z7256422/team-studio --registry=https://npm.pkg.github.com
team-studio
```

也可以在 [GitHub Releases](https://github.com/z7256422/TeamStudio/releases/latest) 下载自带 Node 的 Windows 便携 ZIP。

## 使用

启动后打开 <http://127.0.0.1:3210/>。再次执行 `team-studio` 会打开已运行的实例。

```powershell
team-studio status
team-studio stop
team-studio --version
```

默认将运行历史、加密凭据和启动状态保存在 `%LOCALAPPDATA%\TeamStudio`。团队和界面设置保存在浏览器本地存储，可在面板导出或导入。包内只包含程序、内置岗位模板和第三方许可证。

需要自定义数据目录或端口时，在启动、查询状态和停止时使用相同设置：

```powershell
$env:AGENT_MANAGER_PORT = '3211'
$env:AGENT_MANAGER_DATA_DIR = Join-Path $env:LOCALAPPDATA 'TeamStudio-Work'
team-studio
```

使用 `team-studio stop` 或启动窗口的 Ctrl+C 停止服务。源码、完整说明与问题反馈见 [TeamStudio](https://github.com/z7256422/TeamStudio)。
