# Agent 协同控制台

这是一个以本机 Codex app-server 为执行引擎的通用 Agent 管理面板。React 页面只调用控制平面定义的统一 HTTP/SSE 接口，Codex 协议细节由后端 adapter 负责，因此后续可以增加 Claude Code、Gemini CLI、OpenAI-compatible HTTP 或本地模型 adapter，而无需重写团队配置界面。

## Windows 便携包

在 Windows x64、Node.js 24+ 且已安装 Codex 的开发环境运行 `node work/package-portable.cjs`，会先重新构建界面，再在 `dist/` 生成独立版本目录、ZIP 和 `.sha256` 校验文件。打包需要联网读取该版本 Node 的官方许可证和校验值；本机 Node 二进制校验失败会中止。

ZIP 内置 Node 运行时，完整解压后双击 `Start.cmd` 即可打开浏览器面板，用 `Stop.cmd` 或启动窗口的 Ctrl+C 停止。启动器只管理本目录实例，默认监听本机 3210 端口；端口被占用会明确提示。执行任务仍需本机安装、登录并配置 Codex。

打包采用运行文件白名单，排除个人历史、凭据、调试日志、截图和任务产物。团队配置保存在浏览器，历史首次启动后存入包内 `.agent-manager/`；迁移说明见包内 `README.txt`。可运行 `node work/packaging/smoke-test.cjs "dist/生成的文件名.zip"` 验证实际解压包，该检查使用临时目录和独立端口，不调用真实 Codex。

## 启动

在项目根目录运行：

```powershell
node work/agent-manager-server.cjs
```

然后访问 <http://127.0.0.1:3210/>。页面资源仍内嵌在单文件中，但必须通过服务地址使用。直接打开 HTML 只显示服务入口和旧团队配置导出，不再访问本机控制接口。所有路由（含读取、审批、SSE 和 OPTIONS）校验回环 Host、同源 Origin 与浏览器站点信息；拒绝外站、null Origin 和 DNS rebinding Host。无 Origin 的本机原生客户端仍兼容。这是浏览器跨站防护，不是针对本机其他进程的身份认证。

运行环境需要 Node.js 24+（使用内置 SQLite）和本机可用的 `codex` 命令。0.9.2 使用直接进程启动；Windows 的 npm `.cmd` shim 则通过显式 `cmd.exe` 执行固定参数，不再使用 Node 的 `shell: true`，消除 DEP0190 警告。可用环境变量 `CODEX_BIN` 指定受信任的 Codex 可执行文件路径（Windows 支持 `.exe`、`.com`、`.cmd`、`.bat`，不能附带额外命令参数），用 `AGENT_MANAGER_PORT` 修改端口。

运行历史保存在项目根目录的 `.agent-manager/runs.sqlite`，可通过 `AGENT_MANAGER_DATA_DIR` 指定数据目录。记录包含任务、输出和原执行指令，属于本地工作数据。正常关闭会刷盘，运行时最多延迟 800 毫秒保存，终态立即保存。所有协作方式都在服务端调度；非经理任务提交时一次持久化全部排队席位，刷新/关闭页面不影响派发。服务重启将未结束席位标为中断并产生通知，不自动重放可能产生副作用的工作。经理任务可从原会话恢复团队快照；普通队列续聊恢复原成员，需按未完成情况重新安排后续成员。旧浏览器队列缺失预期成员时显示未完成。

## 页面能力

在「团队配置 → 执行接口 / 工具与能力」统一设置，新增成员默认沿用所属团队，后续修改自动同步。已有成员保留原配置，可点击「让全体直属成员沿用团队设置」一次应用；个别成员可在 Agent 配置中切换为「独立配置」。设置仅影响直属成员，子团队保留各自配置，历史续聊沿用原快照。修改后点击「保存更改」。工具与能力选择仍为配置偏好，实际执行权限由本机 Codex 控制。

首次使用创建 28 人、7 个团队的小型产品研发公司：管理团队及需求、软件、机械、硬件、UI 与产品设计、系统验证部门。各部门负责人可以独立接单，总团队支持逐级派发和验收；已有配置不会覆盖。普通“新建团队”仍提供项目经理、前端、后端、测试四人软件模板。

新建团队的 Skills、MCP 默认全选，新增成员沿用所属团队的能力选择；全选模式在目录加载或新增能力后自动补齐。手动取消某项后，该分类会保留自定义选择；点击“恢复全选”可再次自动包含全部能力。旧配置的空能力列表默认全选，非空列表保留原选择。修改后点击“保存更改”即可保留；这些选择目前为成员配置偏好，实际工具权限仍由本机执行引擎配置决定。

项目经理通过真实调度工具规划、按需派发成员、等待结果、安排返工和验收交付。调度驻留服务端，关闭页面不影响执行。开发任务必须有成员成果、实际文件和验证证据，不能只输出计划；审查、分析和咨询任务允许经理独立提交最终报告，不强制改代码、派发成员或创建文档。

0.9.1 按本轮要求区分报告与文件交付。明确的开发或修复要求优先；简短续聊沿用上一轮类型，续聊要求修复时重新执行文件验收。报告可以用 `team_complete` 提交结论与依据，文件列表允许为空；也可以由引擎标记为 `final_answer` 的完整最终回复自动完成。进度消息、空回复、真实执行失败、待审批和未结束或最近失败的成员不会自动完成。报告完成后，历史、办公室和消息中心同步更新。

旧版误判记录在加载时仅在具备“正常结束事件、最终报告、无失败或活动成员”等证据时修正；原报告和时间保持不变。无法确认的历史失败保持原状，可以在原会话继续。成果判定负责区分输出类型，不代表服务端独立验证了报告结论的正确性。

0.8 版本的「项目经理主导」会先启动经理，再由经理调用 `team_dispatch` 指定成员和子任务，调用 `team_wait` 收回结果，最后调用 `team_complete` 提交交付物和验证证据。成员按团队并发上限执行，默认一次 1 名；每位成员使用自己的供应商、模型、角色指令与工作目录。当前实际接入的供应商是本机 Codex。

旧版只有计划的任务，可以在原历史对话中点击「让项目经理继续交付」。首次升级使用当前原团队的成员配置，后续续聊沿用保存的快照；所有成员执行仍归入同一条任务历史。停止经理会同时停止本轮成员。

新团队和未指定文件权限的新任务默认使用无沙箱（`danger-full-access`），可访问当前用户有权限的文件和网络；可在任务输入框或团队执行设置中选择“工作区可写”或“只读”沙箱。项目经理、派发成员及返工沿用同一执行模式，无沙箱任务不检查或初始化 Windows 沙箱。已保存的团队权限和历史会话快照保持原选择；旧团队可切换权限后保存，沙箱报错旁也可点击“改用无沙箱”只调整本次任务。审批策略独立保留，实际审批由引擎根据操作决定，无沙箱不保证每条命令都会询问。实际验证仍由经理与成员执行，服务端检查文件存在和验证字段，不能独立证明测试报告的正确性。

0.9 版本把用户对话轮次与成员执行次数分开。聊天按每轮的「要求 → 成员执行 → 交付」组织；成员卡片提供公开进展、结果和操作记录，派发与返工不会增加对话轮数。新任务输入区可以单独选择文件权限，侧栏 Recents 直接恢复最近任务。审批进入右上角消息中心，也能在对应聊天卡片和办公室处理；验收完成后产生交付通知。交互和验证约定见 `work/docs/task-experience.md`。

- 左侧导航包含“新任务”“办公室”“运行记录”“成员消息”“团队配置”“Agent 配置”“接口与能力”；团队目录和详细配置合并为同一页面，点击团队只选中，不跳转任务页。
- 团队支持树状包含，可创建、复制、删除、折叠和切换团队，阻止循环、多父和重复包含。新任务包含所选团队及其下级的成员，并按发起团队的策略调度；删除团队节点保留子团队与其成员。
- “新任务”采用正文、底部输入框和可收起执行面板；输入框左上方的工作目录按钮支持搜索历史 / 配置目录，也可浏览其他文件夹。底部左侧选择文件权限与审批策略，右侧展示模型及发送按钮，沿用浅色 Team Studio 样式。目录优先级为“任务目录 → Agent 专属目录 → 团队默认目录 → 控制平面默认目录”，切换团队或新建任务会同步当前团队默认目录；“Agent 配置”采用目录与标签编辑器，分别配置角色指令、执行接口和工具能力。每位成员可单独选择 Provider、模型和工作目录。
- “成员消息”接入控制平面的通用消息总线，支持全体广播、成员定向消息和 SSE 实时同步；Agent 完成任务后会自动广播最近输出。
- “接口与能力”通过自适应模型卡片、执行供应商、团队默认接口和环境诊断分区展示配置；模型编辑按模型参数与连接认证分组。Skills 和 MCP 支持网格目录与搜索，刷新会重新请求本机接口；默认接口弹窗支持独立草稿，取消后丢弃草稿。
- 自定义最多 50 个团队、每个团队 1–200 个成员；每个成员有名称、角色、职责、Provider、模型标识和系统 Prompt。
- 支持项目经理主导、全员并行、按成员顺序接力、仅当前成员四种协作方式，并设置并发上限。
- 每位成员启动独立 Codex thread；成员的模型、Prompt 和最终工作目录转换为 `thread/start` 与 `turn/start` 参数。最终工作目录遵循任务级、Agent 级、团队级的覆盖顺序。
- 通过 SSE 查看 Codex agent message delta、工具输出、状态变化和错误。
- 任务正文显示当前执行阶段、耗时及可展开的命令 / 工具步骤；审批、补充信息、引擎重试和失败分别展示。对话在底部时自动跟随新输出，向上翻阅时保留阅读位置。
- 断线自动重连并按事件序号去重，连接时读取权威状态；状态变化由 SSE 通知触发定向读取，空闲不轮询。停止操作等待真实后端中断，成员失败时不再派发后续排队成员。Codex RPC 无响应会在 45 秒后返回错误。
- 启动时从本机 app-server 读取 Skills 与 MCP server/tool 状态；浏览器不读取 `config.toml` 中的 token、API key 或环境值。
- Codex 请求命令执行、文件修改、工具输入、MCP elicitation 或额外权限时，页面显示具体事务和截止时间。未处理的请求十分钟后以 JSON-RPC 超时错误结束，并保存审批超时通知；不会默认批准。任务失败、停止及服务中断同样进入消息中心。
- 配置可保存到浏览器、导出 JSON 和导入恢复；旧版 `version: 1` 单团队 JSON 会自动迁移到 `version: 2` 多团队结构。“运行记录”加载已持久保存的最近运行摘要，并保留当前页面的流式输出与事件日志。
- 历史列表按会话合并，一个会话只占一条；用户提交算一轮，成员派发与返工为该轮内执行。界面每页 20 次执行，可前后翻页；折叠状态不加载正文，展开后读取最近消息与有界预览，按版本仅同步变更运行。全文可从执行卡片或时序图下载。已保存的完整公开消息不随展示裁剪；事件环形窗口为最近 200 条、操作投影最近 40 项，旧版本已经丢失的内容无法恢复。
- “新任务”顶部提供“选择历史对话”，选中后在主界面恢复多轮对话和底部输入框，可直接发送后续要求、查看输出或停止执行。历史详情也可点击“在主界面继续”。右侧展示原成员、团队、目录及模型；选择历史本身不启动执行，也不覆盖当前团队配置。
- 续聊接在项目经理最新上下文上，沿用已保存的团队快照，由经理按需再次派发成员；普通会话只恢复原成员。相同成员或会话同时只允许一个运行；执行期间可以停止或先编辑下一条要求，发送失败保留草稿。旧记录缺少设置快照时沿用 Codex 会话自身配置，不用当前表单覆盖。
- 四处工作目录均支持“选择”按钮，通过弹窗浏览本机文件夹、磁盘、上级目录或输入地址；取消不会修改原值。
- 历史支持确认后删除整个会话或清空已结束会话，包含各会话内的全部轮次；只要有一轮仍在运行或待审批，就完整保留该会话。删除不影响项目文件、成员配置或 Codex 会话。
- 恢复对话后，办公室定位到原执行成员并同步真实运行状态，提供“返回当前对话”。从配置中移除的历史成员以只读工位呈现，不写回配置。旧任务的页面状态不会覆盖正在续聊的状态。MCP、skills 实际可用能力仍由当前本机引擎配置决定。
- 办公室保留像素画风，按当前任务的 `taskId` 展示成员状态；新任务尚未提交时成员待命。按团队分房间，支持团队范围、成员搜索、状态筛选。点击成员查看任务、来源、时间、步骤与错误。状态由 SSE 通知唤醒读取，完成后计时停止，断线明确标记旧数据；排队状态来自服务端，可在刷新后恢复查看。
- 人物随真实执行状态思考、敲键盘、查资料、整理回复、举牌审批、修理重试、庆祝或求助，待命时喝咖啡；不同服装和休息区小猫增加辨识度与趣味。长时间无事件时显示等待引擎，不伪造进展。提供动画开关并记住偏好，尊重系统减少动态效果设置；断线冻结动作，文字与图标仍能区分状态。

## 控制平面 API

基础地址默认为 `http://127.0.0.1:3210`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务、Codex provider、配置摘要和待审批数量 |
| `GET` | `/api/providers` | 已注册 provider adapter 及能力 |
| `POST` | `/api/providers/custom` | 新建自定义模型连接；URL、认证、默认模型、思考强度 |
| `POST` / `DELETE` | `/api/providers/custom/:id` | 修改/删除连接；活动任务禁止修改，历史引用禁止删除 |
| `POST` | `/api/providers/test` | 显式测试 Responses 流式与工具调用，会请求配置的模型服务 |
| `GET` | `/api/providers/:id/diagnostics?checkEngine=1&cwd=...&sandbox=...` | 检查目录、引擎启动、认证及所选沙箱；refresh=1 强制重查 |
| `POST` | `/api/providers/:id/repair` | `{ "action": "setup", "cwd": "..." }`，显式初始化 Windows 沙箱 |
| `GET` | `/api/events` | 工作区 SSE 变更范围与重连通知，客户端据此定向读取 |
| `GET` | `/api/notifications` | 交付、审批超时、失败、停止、服务中断和反馈超时通知；已读/清除偏好在浏览器 |
| `GET` | `/api/config` | 脱敏后的 Codex 配置路径和 MCP 名称 |
| `POST` | `/api/codex/skills` | 调用 Codex `skills/list` |
| `POST` | `/api/codex/mcp` | 调用 Codex `mcpServerStatus/list` |
| `POST` | `/api/runs` | 创建一次 provider-neutral 运行，返回 `runId` 和 SSE 地址 |
| `POST` | `/api/tasks` | `{strategy, concurrency, members}`，整批提交非经理队列，返回根 run；每位 member 使用 /api/runs 的新任务字段 |
| `GET` | `/api/runs` | 最近运行摘要 |
| `GET` | `/api/conversations` | 最近 100 个会话摘要，先合并再截取，含原始标题、最新状态、轮数和 runIds |
| `DELETE` | `/api/conversations?scope=finished` | 清空全部已结束会话，活动及审批中的会话完整保留 |
| `DELETE` | `/api/runs/:id` | 删除一条已结束记录，活动或待审批返回 409 |
| `DELETE` | `/api/runs?scope=finished` | 清空已结束且无待审批的记录，返回 deletedIds |
| `GET` | `/api/office` | 跨 Provider 的成员运行摘要及服务器时间 |
| `GET` | `/api/filesystem/directories?path=...` | 目录列表、上级及快捷位置，path 可省略 |
| `GET` | `/api/runs/:id` | 单次运行状态、thread、turn 和审批 |
| `GET` | `/api/runs/:id/conversation` | 同一会话执行与轮次；轻量分页、增量参数见下文 |
| `GET` | `/api/runs/:id/execution?view=compact` | 本轮成员及执行摘要，支持 since 增量；运行页仅加载所选成员正文 |
| `GET` | `/api/runs/:id/transcript` | 下载单次运行完整已保存公开消息、交付、反馈和操作投影 |
| `DELETE` | `/api/runs/:id/conversation` | 由任意轮定位并删除整会话面板记录，活动或待审批返回 409 |
| `POST` | `/api/runs/:id/continue` | `{ "goal": "后续要求" }`，恢复原会话并新增一轮 |
| `GET` | `/api/runs/:id/events` | 单次运行的 SSE 事件流 |
| `POST` | `/api/runs/:id/cancel` | 调用 Codex `turn/interrupt` |
| `GET` | `/api/sessions` | Agent 到本地 provider session 的映射摘要 |
| `GET` | `/api/sessions/:agentId` | 查看单个 Agent 的可恢复 thread |
| `POST` | `/api/sessions/:agentId/turns` | 在已有 thread 上继续一轮对话 |
| `POST` | `/api/sessions/:agentId/archive` | 归档空闲的 Codex thread |
| `GET` | `/api/approvals` | 当前等待用户处理的审批请求 |
| `POST` | `/api/approvals/:requestId/respond` | 响应审批；支持 `decision: accept/acceptForSession/decline/cancel`；`acceptForSession` 会在当前 provider session 内复用本次授权，等价的范围字段为 `scope: session` |
| `POST` | `/api/messages` | 写入通用 Agent-to-Agent 消息 |
| `GET` | `/api/messages` | 读取消息历史 |
| `GET` | `/api/messages/stream` | 订阅消息 SSE |

历史客户端应使用 `conversation?view=compact&limit=20&offset=0`。`offset` 从最新执行向前偏移，`limit` 在轻量模式最大为 200；响应含 `total/hasEarlier/hasNewer/runOrder/revision/reset`。下次带 `since=<revision>`，`runs` 只包含版本变更的记录；按 `runOrder` 与已有记录合并，`reset=true` 时替换快照。版本失效、查询范围变化或服务重启均自动返回新快照。`detail=1` 为时序图提供有界正文，单次详情 `/api/runs/:id?view=compact` 用于展开阅读；无轻量参数的旧接口保留兼容。历史摘要中的 `transcriptAvailable` 表示存在可下载的已保存正文，`transcriptOmitted` 表示本次轻量响应有意未内联正文，`transcriptTruncated` 仅在已返回的预览短于保存原文时为 `true`。

Provider 的 `status: available` 仅表示适配器已接入，不能当作模型可执行的证据。`readiness.status` 区分 `unknown/ready/blocked`；目录诊断不调用付费模型，`modelConnectivity: unverified` 表示尚未验证实际模型请求。页面明确区分管理服务、执行引擎、认证和模型测试。诊断不带 `checkEngine=1` 时保留旧版只检查沙箱的兼容行为。

配置文件 `version: 2` 使用 `activeTeamId`、`teams` 和 `providers` 字段；Provider 选择是 provider-neutral 的。当前本机真正执行的是 `codex-app-server`，Claude Code、Gemini CLI 和 OpenAI-compatible HTTP 已作为可登记的适配器占位，接入对应后端后即可运行。

`/api/runs` 请求示例：

```json
{
  "adapter": "codex-app-server",
  "agentId": "builder",
  "goal": "检查当前项目并提出实现计划",
  "cwd": "C:/workspace/project",
  "model": "default",
  "developerInstructions": "先分析，再给出可验证的步骤",
  "approvalPolicy": "on-request",
  "context": {
    "taskId": "task-001",
    "taskTitle": "检查当前项目并提出实现计划",
    "teamId": "software",
    "teamName": "软件开发团队",
    "memberTeamId": "software",
    "memberTeamName": "软件开发团队",
    "agentName": "项目经理",
    "agentRole": "ProjectManager",
    "source": { "kind": "user", "name": "本机用户" },
    "dispatchMode": "sequential",
    "handoffFrom": null
  }
}
```

消息接口是 provider-neutral 的，消息包含 `fromAgentId`、可选 `toAgentId`、`runId`、`content`、`replyTo`、`priority` 和时间戳。服务端顺序接力将前序成果的明确标注预览（最多 6000 字符）放入下一位 Prompt，并共享工作目录；消息总线已经可供更复杂的协调器或其他前端使用。

`context` 为可选、跨供应商的展示元数据；传入时 `source.kind` 为 `user`、`agent`、`api`，不是身份认证或授权依据。接力时 `handoffFrom` 记录 `{agentId, name, runId}`。旧客户端不传 `context` 仍可运行。办公室每位成员优先展示活动运行，否则展示所选任务的最近记录；已删除记录不会继续展示。全部接口统一接受同源面板或无 Origin 的本机原生客户端，不接受 file: 页面的 null Origin。

## Provider adapter 边界

0.10 新增运行时成员反馈：经理工具为 `team_dispatch`、`team_wait`、`team_reply_member`、`team_complete`；被派发成员拥有 `team_ask_manager`。成员调用提问工具后等待经理答复，通过同一工具响应继续原 turn，不增加对话轮次。问答随历史保存，聊天、办公室和时序图共用反馈数据；超时会产生通知且不能通过交付验收。详细边界和旧线程兼容方式见 `work/docs/team-feedback.md`。

成员成果交接新增 `team_read_result`：等待返回短预览与成果编号，负责人按需分段、重复读取完整正文，避免长中文报告在工具传输中被截断。多成员状态也按响应总字节数分页；等待继续由事件唤醒。旧会话续聊会迁移注册新工具，保留原任务历史。详见 [成员成果交接协议](../work/docs/team-results.md)。

诊断和任务启动使用统一的工作目录校验：空值使用控制台项目目录，非空路径失效时必须重新选择，不会自动创建目录或切换项目。支持复制路径的外层引号、前后空白及相对控制台目录的路径。诊断接口对目录故障返回 `status: blocked`、`category: working-directory`、`code` 和实际 `cwd`，不调用引擎；任务启动和沙箱修复返回对应的 4xx/5xx 错误，不生成运行记录。无沙箱同样检查目录。

页面诊断显示具体路径并提供目录选择弹窗。任务页选择只应用于本次任务；接口与能力页修改团队默认目录后需保存。诊断、启动和成员派发快照统一按非空的任务目录、成员目录、团队目录取值。

控制平面内部把 provider 视为能够启动运行、流式发送事件、取消运行和响应审批的 adapter。现在只有 `codex-app-server` 实现，它通过 stdio JSON-RPC 启动本机 `codex app-server --stdio`，发送 `initialize`、`thread/start`、`turn/start`、`turn/interrupt`，并转发通知。新增 provider 时，保留 `/api/runs`、SSE 事件和审批/消息语义即可接入其他 agent 应用或模型。

页面不会调用 Codex 内部的 `spawn_agent`，也不会假设每个成员由一个统一模型管理。每次新任务为成员创建 thread，续聊使用 `thread/resume` 和 `turn/start`；统一控制平面负责调度、事件路由、审批和消息存储。运行记录持久化到本机 SQLite，原始 thread 上下文仍由 Codex 保存。其他 adapter 可实现相同历史会话 HTTP 契约，分布式调度队列尚未实现。

## 交付文件

- `outputs/agent-manager.html`：服务提供的单文件页面；直接打开文件只提供服务入口和旧配置导出。
- `work/panel-src/`：前端源码，按 `config`、`runtime`、`state`、`components`、`views` 和 `styles` 分层；页面不再依赖旧模板 CSS，入口 `App.jsx` 只负责组合。
- `outputs/agent-manager.jsx`：旧路径兼容说明；请勿直接修改该文件。
- `work/agent-manager-server.cjs`：本地控制平面和 Codex adapter。
- `work/server/`、`work/shared/`：目录浏览、任务元数据、历史删除及前后端共用的运行状态逻辑。
- `work/build-panel.cjs`：从源码重新生成 HTML。
- `outputs/example-team.json`：可导入的示例团队配置。
- `outputs/THIRD_PARTY_LICENSES.txt`：React / ReactDOM 的 MIT 许可。

历史截图、临时请求、旧模板、外部项目调研副本、一次性验证产物及旧版便携包已移出工程。当前源码、测试、协议定义、依赖、运行数据库和最新便携包保留。包含本机信息的迁移、归档和核查记录仅在本地保留，不随源码上传。

构建页面：

```powershell
node work/build-panel.cjs
```

安全默认值是回环监听、不返回凭据、审批不自动允许。不要把控制平面端口转发到公网，也不要在未审阅请求内容时批量批准命令或文件修改。
