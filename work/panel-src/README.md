# 面板前端源码

源码按浏览器运行时的职责拆分。构建脚本按依赖顺序逐文件用 Babel 编译，再合成为资源内嵌的单文件 HTML，由本机服务提供；模块错误会定位到具体文件。file: 入口只支持打开服务和导出旧配置。

安全、队列、轻量历史、诊断与测试入口见 [本次审查修复说明](../docs/security-reliability-review.md)。全部 HTTP/SSE 接口见 [API 表](../../outputs/README.md#控制平面-api)。版本唯一来源为 `../server/app-info.cjs`。

0.10 的成员反馈规范见 `../docs/team-feedback.md`。`server/team-feedback.cjs` 管理提问、答复、幂等、超时和取消；`server/team-thread.cjs` 处理旧 Codex 线程的动态工具兼容迁移。前端 `components/TeamFeedback.jsx` 共用于聊天和办公室，时序图从持久化问答投影，消息中心展示超时通知。待答问题唤醒经理的 `team_wait`，经理用 `team_reply_member` 回复，成员的 `team_ask_manager` 在原 turn 中返回；不增加用户轮次或创建额外运行。

0.10.1 的等待和状态同步使用事件机制，详见 `../docs/event-driven-execution.md`。后端 `server/workspace-events.cjs` 汇总变更范围；前端 `runtime/workspace-events.js` 管理共享连接、定向刷新、请求合并、退订及重连恢复。

1. `config/constants.js`、`config/team-presets.js`、`config/capabilities.js` 和 `config/model.js`：共享常量、默认角色模板、能力选择同步、版本迁移、配置校验和本地持久化。团队通过 `team.children` 形成树状包含关系，并校验重复包含、自己包含和循环包含。
2. `runtime/control-plane.js`：Provider-neutral 运行契约，负责本机 Codex app-server 的 HTTP/SSE 调用和审批响应。
   `../shared/run-progress.js` 由前后端共用，归并运行状态、工具步骤和公开执行阶段；`RunProgress`、`RunConversation` 与 `ApprovalCard` 分别展示执行进展、历史多轮对话和审批 / 补充信息表单。
3. `state/useWorkspace.js`：页面状态、团队和 Agent CRUD、树状团队编排、运行调度、消息总线以及配置导入导出。
4. `components/PanelShell.jsx`：单层工具栏、团队切换、侧栏导航和手机抽屉导航。
5. `components/DialogLayer.jsx`：接口配置、导出配置和全局提示对话框。
6. `views/`：团队、Agent、任务、消息、运行记录和接口能力页面。团队页把可折叠树和标签编辑器放在同一工作区；点击节点只切换编辑对象，保持当前标签。`TeamSettingsView` 是右侧可复用的表单区块，旧 `team` 路由兼容映射到 `TeamsView`。
7. `App.jsx`：组合 hook、壳层、视图和对话框层。
8. `components/Primitives.jsx`：统一 SVG 图标、标签导航、字段、头像、搜索和空态组件。
9. `styles/base.css`、`styles/shell.css`、`styles/workspaces.css`：分别负责设计变量与控件、应用壳层、业务页面与响应式布局。构建只读取模块化源码，旧模板和额外 CSS 已移出工程归档；新增样式应放在对应模块中。
10. `office/model.js`、`office/PixelArt.jsx`、`state/useOffice.js`、`views/OfficeView.jsx` 和 `styles/office.css`：分别负责办公室状态合并与场景映射、人物及道具绘制、状态同步、页面交互和动作样式。房间按团队划分，复用真实配置及运行元数据；不生成虚构任务。`officeScene` 根据状态和 `phase` 选择姿态，动画开关保存在 `agent-manager:office-animation`。
11. `components/DirectoryPicker.jsx`、`components/ConfirmDialog.jsx` 和 `styles/directory-picker.css`：复用目录选择及删除确认。目录选择通过 portal 打开，支持嵌套弹窗，取消时不修改父表单草稿。
12. `components/RunConversation.jsx` 与 `styles/conversation.css`：按原 thread 展示多轮对话、续聊、停止和错误；页面卸载不取消后端运行。`server/conversations.cjs` 负责历史会话分组与续聊参数继承，`server/run-store.cjs` 负责 SQLite 存储，均不依赖前端团队配置。
13. `components/TaskConversation.jsx`：主界面的历史对话选择器和原配置只读面板；与历史详情共用 `RunConversation`，通过 `layout="task"` 固定底部输入区。`taskConversation` 保存在工作区状态中，办公室可返回原对话。

## 页面交互

0.9 的对话轮次、执行卡片、Recents、任务权限和通知中心规则见 `../docs/task-experience.md`。轮次按用户提交计数，成员执行单独计数；旧历史无需清空。新增的 `runtime/conversation-model.js`、`runtime/approval-details.js`、`state/useNotifications.js`、`components/ExecutionCard.jsx` 与 `components/NotificationCenter.jsx` 分别负责展示投影、权限事务、通知同步和对应 UI，样式集中在 `task-activity.css` 与 `notifications.css`。

首次使用默认创建 28 人、7 个团队的小型产品研发公司，管理团队包含需求、软件、机械、硬件、UI 与产品设计、系统验证部门，各部门有负责人。职责模板在 config/company-roles.js；普通“新建团队”仍提供 4 人软件团队模板。已有配置与指令不被覆盖。

项目经理先制定目标、分工、接口和验收计划，前端交接接口需求，后端对齐实现，测试输出整体验收报告。共享目录沿用项目协作文档，没有合适文件时约定使用 `docs/team-development.md` 记录本轮计划与交接。项目经理使用 team_dispatch、team_wait、team_complete 完成真实派发、结果检查和交付验收；普通成员只执行被派发的子任务。

- 新任务：正文与底部输入框构成任务工作区，右侧执行面板可收起；手机默认收起。输入框上方的工作目录按钮打开可搜索列表，汇集当前选择、历史任务及团队 / Agent 配置中的目录；“浏览其他目录”复用本机目录选择弹窗。目录优先级为“本次任务目录 → Agent 专属目录 → 团队默认目录 → 控制平面默认目录”；留空即可沿用配置。输入框底部左侧选择文件权限和审批策略，右侧展示执行模型并发送或停止。布局由 `components/TaskComposer.jsx`、`components/TaskDirectoryMenu.jsx` 与 `styles/task-composer.css` 负责，沿用现有浅色控件，不影响成员消息输入区。提交后显示实际提交的目标与成员输出。新建任务会清空对话草稿并恢复当前团队默认目录，运行页仍可查看上一轮输出。
- 团队配置：左树右编辑；基本信息、直属成员、子团队、执行接口、工具与能力、执行设置分别编辑。包含关系为单父树，删除节点保留后代，清理父引用并修正祖先并发数。
- Agent 配置：目录与角色指令、执行接口、工具能力三个标签；新增成员直接打开角色指令。搜索同时匹配名称、角色和职责。
- 工具能力：新建团队默认全选 Skills 和 MCP，新增成员沿用所属团队选择；全选模式在目录延迟到达、刷新和新增能力时自动补齐。团队与独立成员分别保存 `capabilitySelection.skills`、`capabilitySelection.mcpServers`，取值 `all` 或 `custom`。手动取消勾选后仅该分类进入自定义模式，即使清空也会在保存、刷新和导入后保留；“恢复全选”可以重新跟随目录。旧配置未记录模式时，空列表按全选处理，非空列表保留为自定义。目录失败不清空已有选择，运行时不变更配置。此处为配置偏好，尚未转换为每位成员的运行时工具权限。
- 接口与能力：内容居中并限制最大宽度，自定义模型按容器宽度展示三列、两列或单列卡片；下方分区展示执行供应商、团队默认接口与环境诊断。模型表单分为模型配置、连接与认证两组，Skills 和 MCP 使用可搜索网格目录。页面专用样式位于 `styles/integrations.css`，模型卡片与表单位于 `styles/custom-providers.css`；刷新按钮实际读取本机接口。默认接口弹窗使用独立草稿，取消或 Escape 丢弃修改。
- 运行记录：成员列表和输出阅读器，支持查看子团队成员；历史记录和事件日志独立标签。任务页与运行页展示启动、分析、命令 / 工具步骤、等待审批、重试、断线和失败原因，并显示耗时与长时间无新活动提示。历史通过 SSE 变更通知读取轻量增量，每页 20 次执行；正文展开后才读取，可下载完整已保存记录、续聊及停止。运行记录保存于 `.agent-manager/runs.sqlite`，服务重启后可继续查看；未结束记录明确标为中断。
- 历史续聊：只提交后续 `goal`，由后端继承原目录、成员、adapter、模型及指令，`parentRunId` 记录来源；缺少 thread 的记录禁用续聊。旧历史无设置快照时不清空 Codex 内部配置。同成员或同 thread 的并发请求返回 409；消息事件按 turnId 隔离，早于启动响应的通知缓冲后回放。续聊接在原 thread 最新上下文上，不回滚历史；受管会话继续由经理按需派发成员。
- 运行可靠性：SSE 带事件序号、心跳和重连去重，连接快照收敛结束状态。界面状态由共享的 `/api/events` 通知触发读取，不再定时查询。停止操作等待后端确认，即使启动请求尚未返回，也会在收到 runId 后执行中断。成员失败或被中断时停止派发排队成员；已经并行启动的成员保持各自运行。审批按 runId 与 requestId 区分，通过事件同步并支持回答工具问题。
- 成员消息：广播频道与成员定向频道；只展示已收到的数据，不伪造消息。运行中的 Agent 不会自动读取新消息。
- 工作目录：任务、团队、Agent 和默认接口四个入口都可点击“选择”浏览本机目录；支持上级、磁盘快捷位置、地址跳转、目录筛选及中文路径。单击选中、双击或箭头进入，确认后写回绝对路径；取消保留原值。仅列出目录，不读取文件内容。
- 历史管理：`/api/conversations` 优先按 taskId 跨成员及供应商合并，旧记录按 adapter + thread 合并，缺少二者的运行单独显示，先合并再取最近 100 个会话。标题用最初任务，状态用活动轮或最新轮；通过 runIds 将办公室任意一轮定位到原会话。删除和清空均以整会话为单位，活动或待审批的会话完整保留；旧单轮 API 继续兼容。
- 主界面恢复：新任务顶部选择历史对话，或历史详情点击“在主界面继续”。选择只加载历史，发送时恢复原会话的成员和执行参数，不修改当前团队配置或隐式派发整队。办公室默认定位原成员，提供返回入口；配置中已移除的历史成员通过 `officeTeams` 构造只读工位，服务器真实活动优先于页面的旧任务状态。
- 办公室：选定团队时包含其子团队，也可查看全部团队；支持成员搜索和状态筛选。每间房最多展示 12 个工位，每页 6 间房。点击工位查看任务、发起人、顺序接力来源、时间、当前步骤与错误，并跳转对应历史；手机点击工位后滚动到详情。状态同时改变人物姿态、道具、标签和工位背景；支持关闭动画及系统 reduced-motion 设置。
- 状态同步：办公室按当前任务的 `taskId` 读取成员摘要，由工作区变更通知触发刷新，时钟每秒更新并校正服务端时差；新任务尚未提交时不读取历史运行，所有成员显示待命。已结束运行耗时固定。初次连接失败显示未知，后续断线保留并明确标注旧状态，停止动画。排队成员先在服务端持久保存，再由事件唤醒派发；页面只展示服务端状态。
- 无事件提示：任务页、历史详情和办公室共用 `runInactivity`，运行 30 秒没有新事件时显示经过时间，等待审批和连接中断分别说明。办公室显示最近执行事件时间；连接保活不代表引擎产生了新进度。长文本或工具参数生成期间可能没有可见事件，因此不自动判失败、中断或重新派发。分析项结束后显示“等待引擎下一步”，不保留过时的分析状态。
- 来源语义：用户发起与前序接力分开保存为 `context.source` 和 `context.handoffFrom`；旧客户端未传来源时显示“未记录来源”。项目经理派发记录额外保留 coordinatorRunId 和 dispatchCallId，经理等待结果时显示协调状态，完成前显示验收状态。所有新任务的派发均驻留服务端；旧浏览器队列缺失预期成员时显示未完成。

## 构建与验证

在项目根目录运行：

```powershell
node work/build-panel.cjs
node --test work/panel-src/config/model.test.cjs
node --test work/agent-manager-server.test.cjs work/panel-src/runtime/run-progress.test.cjs
node --test work/server/office.test.cjs
node --test work/server/conversations.test.cjs
```

服务在每次请求时读取 `outputs/agent-manager.html`，更新前端只需重新构建并刷新页面。配置继续保存在浏览器的 `agent-manager:v1` key，保存的结构仍为 version 2；原配置无需手动迁移。

当前保留资源内嵌的单文件交付方式，不使用 ES module import；通过服务打开即可使用，不依赖 CDN。

UI 回归使用 `node work/test-support/runtime-fixture.cjs`，访问 `http://127.0.0.1:33210`。该服务只返回内存夹具，不启动 Codex；任务目标含“失败”时模拟失败，否则模拟命令失败、等待审批和审批后完成。真实服务使用 3210 端口，测试时应核对地址。

办公室 UI 回归使用 `node work/test-support/office-fixture.cjs`，端口为 33211；`/fixture/config` 提供固定成员配置，导入后可以检查多团队、多状态、删除和接力来源。目录浏览、办公室摘要、续聊与删除走生产路由，执行接口使用假客户端，绝不启动真实 Codex。续聊会在 4.5 秒后完成，`[fail-start]` 模拟启动失败；POST `/fixture/phase` 可设置前端工程师的 `phase`，POST `/fixture/offline` 切换办公室接口断线。


## 项目经理调度（0.8）

- `server/team-coordinator.cjs` 定义供应商无关的工具与调度器，依赖统一的 startRun/cancelRun。Codex adapter 将工具注册为 experimental dynamicTools，并响应 item/tool/call；这是模型真实调用，不解析自然语言中的“已派发”。本机验证版本为 codex-cli 0.154.0。
- POST /api/runs 可携带 management: { members, concurrency }。成员快照包含 id/name/role/provider/model/cwd/prompt；新任务默认 danger-full-access（无沙箱），可手动选择 workspace-write 或 read-only，审批仍使用原策略。成员继承经理的执行模式；无沙箱时跳过 Windows 沙箱预检。旧团队和历史的显式权限保持不变。配置中的 planned 供应商不能被真实派发，返回明确错误。
- 管理层通过 team_dispatch 指定成员与子任务；启动时立即占用席位，达到并发上限拒绝额外调用。同成员返工恢复同任务的最近线程。team_wait 在成员活动期间挂起，由成员结束或反馈事件唤醒；成果以短预览和编号返回，team_read_result 分段读取全文。
- 本轮成果类型由 `server/delivery-contract.cjs` 按目标区分，并保存在 `management.deliveryMode`。报告类允许独立完成和空文件列表；完整 `final_answer` 可自动提交报告，进度消息不算报告。开发类仍要求 team_complete 验证成员参与、子运行结束、成员最新运行成功、交付文件存在及验证证据。证据由模型负责核实，服务端不把文字声明当作独立测试证明。续聊“修复问题”等要求会切回开发验收。
- 调度状态与成员快照存入原运行 SQLite 数据。刷新页面不停止服务器调度，停止经理会联动当前轮派发的成员；进程重启后中断的任务可沿原经理上下文继续。
- 旧版规划任务缺少快照和动态工具时，页面提供“让项目经理继续交付”：明确采用当前原团队成员，服务端在原 taskId 下创建受管线程并携带已有计划；原历史完整保留。原团队已删除时仍可普通续聊，但不能凭空构造成员。
- 自动回归：node --test work/server/team-coordinator.test.cjs。隔离 UI：node work/test-support/team-fixture.cjs，端口 33212。真实引擎烟测需要显式设置 RUN_TEAM_ENGINE_SMOKE=1，运行 work/test-support/team-engine-smoke.cjs，仅操作临时目录。若 Windows 报 LookupAccountNameW / CodexSandboxOffline: 1788，属于本机沙箱环境异常；面板展示实际审批和失败，不自动关闭沙箱或批准提权。

## 团队统一设置（0.15.0）

在「团队配置 → 执行接口 / 工具与能力」统一设置，新增成员默认沿用所属团队，后续修改自动同步。已有成员保留原配置，可点击「让全体直属成员沿用团队设置」一次应用；个别成员可在 Agent 配置中切换为「独立配置」。设置仅影响直属成员，子团队保留各自配置，历史续聊沿用原快照。修改后点击「保存更改」。工具与能力选择仍为配置偏好，实际执行权限由本机 Codex 控制。

配置仍为 version 2。团队新增 skills、mcpServers、capabilitySelection；成员新增 connectionMode、capabilityMode（team/custom）。缺少来源标记的旧成员按 custom 处理。派发前按所属团队解析生效值；历史执行只保存解析后的参数。
