# 执行状态、审批与环境诊断

## 工作区同步

`useCurrentExecution` 在工作区挂载，使用 `watchCurrentExecution` 每 2 秒读取当前会话的 `/api/runs/:runId/execution`。切换页面不会停止同步；切换任务或卸载订阅会忽略旧请求的迟到响应。失败保留最近状态并显示同步错误，下一次自动重试。

接口返回 `round`、原团队快照中的 `members`、本轮各成员最新一次实际执行的 `runs`。未被派发的成员保持待命，不把上一轮交付状态带入新一轮；返工在同轮用最新执行覆盖该成员状态。历史阅读器仅更新自己的对话视图，不能污染当前任务。旧并行/接力发起流程仍使用原 SSE。

## 文件审批

`approval-context.cjs` 在文件事件到达时按运行对象和 `(threadId, turnId, itemId)` 关联变更。每个运行保留最近 64 项以及仍在审批的项，不依赖只有 200 条的事件日志。公开审批接口和 SSE 返回关联后的 `params.changes`，不修改引擎原请求或批准语义。

审批卡优先显示实际命令、目录与权限；文件路径、变更类型直接可见，差异默认折叠。任务和分工原文可展开。缺少可关联的文件信息时明确说明，不推测路径。

## 供应商诊断契约

- `GET /api/providers/:provider/diagnostics?cwd=...&refresh=1`：返回 `provider/status/summary/checkedAt`，以及可选的 `detail/readiness/probe/setup/repair`。状态为 `ready`、`blocked`、`unknown` 或 `notApplicable`。
- `POST /api/providers/:provider/repair`，请求 `{ "action": "setup", "cwd": "..." }`：显式初始化；有活动任务时返回 409。接口形状通用，当前仅实现 Codex 适配器；未接入供应商返回 404。

选择“工作区可写”或“只读”时，Windows 上先调用本地协议的 `windowsSandbox/readiness`，再用 `command/exec` 在只读沙箱运行固定的 `cmd.exe /d /c exit 0`。不创建 thread/turn，不修改项目文件。检查结果按目录缓存 30 秒，最多缓存 32 个目录，并合并同目录同时请求。已识别的实际沙箱错误会使缓存失效。

新团队和未指定权限的新任务默认使用 `danger-full-access`。会话的 `sandbox` 和轮次的 `sandboxPolicy` 由 `server/execution-permissions.cjs` 统一转换，成员派发继承经理选择；审批策略独立保留。无沙箱时诊断返回 `notApplicable`，不会调用 Windows 沙箱 RPC，也不受沙箱错误缓存或正在修复的状态影响。

已保存团队、显式选择的限制模式和历史快照不随默认值改变。沙箱模式下启动新任务、续聊和成员派发仍执行预检；明确故障阻止启动轮次并记录失败原因，不会因故障自动放开权限。诊断接口支持 `sandbox` 查询参数，缺省与新任务一致；页面可显式切换“无沙箱”。旧历史缺少权限快照时不覆盖 Codex 原会话权限。检查只证明最小进程能启动，不保证后续所有文件或网络权限可用。

用户在诊断卡点击修复并确认后才调用 `windowsSandbox/setupStart`（`mode: elevated`），可能触发系统 UAC。监听 `windowsSandbox/setupCompleted`，失败/进程退出/120 秒未返回时显示原因并清理监听。修复之后重新检查实际启动能力，不以 `started: true` 代替修复成功。任务审批与文件权限不变。

实现依据：仓库中的本机 app-server 协议 schema。实施时官方 Windows 页面返回 Forbidden，未据其内容作额外推断。

## 调度与展示

- 经理依据规模选轻量或标准协作：小任务简短分工与结果交接，复杂任务再维护必要的协作文档；用户及项目规范优先。不覆盖浏览器已保存的自定义提示词，运行时补充调度约定。
- `team_wait` 挂起等待，由完成、失败、成员提问、审批变化或取消事件唤醒，无周期超时返回。普通输出不唤醒经理，取消释放等待者。界面同步同样改为事件通知，详见 [挂起等待与事件唤醒](event-driven-execution.md)。
- 保留 `members/pending` 字段，新增 `reason` 和每成员的 `outputUnchanged`。已交接且状态未变的结果不重复传全文；第一次返回与终态变化保留完整交接摘要（既有长度上限）。连续等待在执行步骤中合并，原事件仍保留。
- Windows 运行指引建议明确 UTF-8、脚本文件/标准输入和真实退出码，减少多层命令引号丢失。
- 列表、通知和图标题用首行短标题；完整目标始终保存在原字段，用于派发、正文与详细查看。
- 办公室仅依据公开 `agentMessage.phase` 区分汇报进展、最终回复和未知阶段；不读取推理内容，迟到输出不能让终态重新变成执行中。

## 报告与文件交付（0.9.1）

`server/delivery-contract.cjs` 集中判定本轮成果类型。明确的审查、分析和咨询要求使用 `report`；有实际修改、修复或产出文件要求时使用 `files`，混合要求优先文件交付；无法识别的新任务保守按文件交付，简短续聊沿用上一轮类型。每一轮都重新检查明确的新要求，避免审查后的“修复这些问题”继承报告验收。

报告不要求其他成员参与或创建文件，允许 `team_complete` 使用空 `artifacts`，但仍需非空结论和依据。也支持在引擎正常结束时使用本轮已完成的 `agentMessage.phase=final_answer` 自动提交报告；不能使用 commentary 或混合的旧 `output` 猜测结论。已派发成员必须全部结束、每个成员最近一次执行成功、无待审批。报告的工具记录只说明实际发生过的操作，不自动声称测试通过。

文件交付保留原成员、文件存在性和验证证据检查。旧版误判报告的修正仅限精确的验收错误、引擎 `turn/completed` 正常结束、最终消息和成员状态均具备证据的记录；修正可重复执行，保留原消息与时间。真实引擎失败、缺失消息边界或开发任务不修正。

回归覆盖：`node --test work/server/delivery-contract.test.cjs work/server/team-coordinator.test.cjs`。可显式设置 `RUN_REPORT_ENGINE_SMOKE=1` 后执行 `node work/test-support/report-engine-smoke.cjs`，在临时目录验证真实 Codex 不调用验收工具、不改文件也可正常提交报告。
