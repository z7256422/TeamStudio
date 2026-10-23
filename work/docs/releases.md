# 发布与安装

## 面向使用者

- [Releases](https://github.com/z7256422/TeamStudio/releases/latest)：下载 Windows x64 便携 ZIP，自带 Node，完整解压后运行 `Start.cmd`，使用 `Stop.cmd` 停止。执行 Agent 任务仍需本机安装并配置 Codex。
- [GitHub Packages](https://github.com/z7256422/TeamStudio/packages)：提供 `@z7256422/team-studio` npm 包，需要 Windows x64 和 Node.js 24+。包的完整安装与数据目录说明见 [npm 使用说明](../packaging/npm-README.md)。

GitHub Packages 的 npm 安装需要本机完成 registry 登录，使用具有 `read:packages` 权限的 personal access token (classic)。Token 在登录提示中输入，不写到项目文件或命令示例中。

```powershell
npm login --scope=@z7256422 --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @z7256422/team-studio --registry=https://npm.pkg.github.com
team-studio
```

`team-studio status` 查看实例，`team-studio stop` 停止。npm 安装版的数据默认位于 `%LOCALAPPDATA%\TeamStudio`；便携版仍保存在解压目录的 `.agent-manager`。两者都只监听本机回环地址。

## 维护者发布流程

1. 在 `work/server/app-info.cjs` 修改软件版本，并在根目录 `CHANGELOG.md` 记录本版变化。版本是所有分发包的唯一来源，已发布的 npm 版本不可覆盖。
2. 在 Windows x64、Node.js 24+ 和可用 Codex 环境中构建：

   ```powershell
   npm run package
   npm run package:npm
   ```

   便携包构建校验 Node 官方摘要、执行全部测试、构建界面与内置模板，并检查实际解压包的启动、重复启动、停止、数据库完整性和密钥加密。npm 包复用同一份运行文件白名单。
3. 检查 `dist/` 内的 ZIP、npm `.tgz` 和各自 `.sha256`；提交对应源码后，在该提交创建 `v版本号` 的 GitHub Release，上传 ZIP 和对应的 `.sha256`。本机 npm 包用于安装验证，正式 npm 包由工作流从版本标签构建。
4. 发布 Release 会触发 [Publish GitHub npm package](../../.github/workflows/publish-package.yml)。工作流检出版本标签，校验版本，安装固定版本的 Codex，运行完整测试，再构建并发布 npm 包。
5. 工作流仅使用 GitHub 自动提供的 `GITHUB_TOKEN`，权限为 `contents: read` 和 `packages: write`，无需把个人 Token 添加到仓库。首次发布后在 Packages 中检查仓库关联及访问权限。

需要重试时，在 Actions 中手动运行工作流并填写现有版本标签。若 npm 版本已经发布，不应重复发布同一版本；应先核对上次运行结果。

## 分发边界

源码仓库保留 `private: true`，防止从根目录误发 npm 包。`npm run package:npm` 在全新的 `dist/npm/` 暂存目录生成专用清单和安装入口，发布 registry 固定为 GitHub Packages。

ZIP 和 npm 包共用 `work/packaging/runtime-files.cjs` 的运行文件白名单，只包含服务代码、离线界面、内置岗位模板、启动器与第三方许可。个人配置、`.npmrc`、Codex 登录文件、运行数据库、日志、历史验证记录和用户任务产物不在白名单内。npm 入口把用户数据放到安装目录之外，升级包时可继续使用。
