const { conversationRounds } = require('./conversation-rounds.cjs');
const { jobFromRunEvent } = require('../shared/run-progress.js');
const { endStream } = require('./sse.cjs');
const TERMINAL_RUN_STATES = new Set(['completed', 'cancelled', 'failed']);

function parseTaskContext(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('context must be an object');
  const text = (value, max = 160) => {
    if (value == null) return null;
    if (typeof value !== 'string' || value.length > max) throw new Error(`context fields must be text up to ${max} characters`);
    return value;
  };
  const source = input.source || {};
  if (!['user', 'agent', 'api'].includes(source.kind)) throw new Error('context.source.kind must be user, agent or api');
  const handoff = input.handoffFrom;
  if (input.expectedAgentIds != null && (!Array.isArray(input.expectedAgentIds) || input.expectedAgentIds.length > 200)) throw new Error('context.expectedAgentIds must contain at most 200 members');
  return { taskId: text(input.taskId), taskTitle: text(input.taskTitle, 12000), teamId: text(input.teamId), teamName: text(input.teamName), memberTeamId: text(input.memberTeamId), memberTeamName: text(input.memberTeamName), agentName: text(input.agentName), agentRole: text(input.agentRole), coordinatorAgentId: text(input.coordinatorAgentId), coordinatorAgentName: text(input.coordinatorAgentName),
    source: { kind: source.kind, id: text(source.id), name: text(source.name) },
    roundId: text(input.roundId), coordinatorRunId: text(input.coordinatorRunId), dispatchCallId: text(input.dispatchCallId), assignment: text(input.assignment, 10000),
    expectedAgentIds: input.expectedAgentIds?.map(id => text(id, 100)) || null,
    dispatchMode: text(input.dispatchMode, 30),
    handoffFrom: handoff ? { agentId: text(handoff.agentId), name: text(handoff.name), runId: text(handoff.runId) } : null };
}
function updateRunProjection(run, event) {
  run.progress = jobFromRunEvent(run.progress || { startedAt: Date.parse(run.createdAt) }, event);
  // 文本输出另有有界缓冲；办公室只需要活动状态和最近工具步骤。
  delete run.progress.output;
  if (TERMINAL_RUN_STATES.has(run.status)) run.endedAt ||= event.time;
}
function officeRun(run) {
  const progress = run.progress || {};
  const status = TERMINAL_RUN_STATES.has(run.status) ? ({ completed: 'done', cancelled: 'cancelled', failed: 'failed' }[run.status]) : run.approvals?.size ? 'waiting' : progress.status || run.status;
  const resultMode = run.delivery?.mode || run.settings?.management?.deliveryMode || null;
  return { agentId: run.agentId, runId: run.id, status, resultMode, phase: progress.phase || '', activity: status === 'done' && resultMode === 'reply' ? '已回复用户问题' : progress.activity || (status === 'starting' ? '正在启动引擎' : '等待运行事件'),
    context: run.context || null, goal: run.context?.taskTitle || run.goal, cwd: run.cwd, adapter: run.adapter, model: run.model || 'default',
    createdAt: run.createdAt, startedAt: run.startedAt || null, endedAt: run.endedAt || null, updatedAt: run.updatedAt || run.createdAt,
    currentStep: progress.steps?.at(-1)?.detail || '', feedback: run.feedback || [], error: run.error || '' };
}
function officeSnapshot(runs, taskId = null) {
  const latest = new Map();
  const scoped = taskId === null ? [...runs.values()] : [...runs.values()].filter(run => run.context?.taskId === taskId);
  const current = taskId === null ? scoped : conversationRounds(scoped.sort((a, b) => a.createdAt.localeCompare(b.createdAt))).at(-1)?.runs || [];
  for (const run of current) {
    // 办公室可以按当前任务查看；不把另一条历史任务的完成状态带入当前任务。
    if (taskId !== null && run.context?.taskId !== taskId) continue;
    const old = latest.get(run.agentId);
    const active = !TERMINAL_RUN_STATES.has(run.status), oldActive = old && !TERMINAL_RUN_STATES.has(old.status);
    if (!old || (active && !oldActive) || (active === oldActive && run.createdAt >= old.createdAt)) latest.set(run.agentId, run);
  }
  return { serverTime: new Date().toISOString(), agents: [...latest.values()].map(officeRun) };
}
function deleteRunHistory(runs, runIds, removeStored = () => {}) {
  const selected = runIds.map(id => runs.get(id)).filter(Boolean);
  if (selected.some(run => !TERMINAL_RUN_STATES.has(run.status) || run.approvals?.size)) throw Object.assign(new Error('运行中或等待审批的记录不能删除，请先停止任务'), { statusCode: 409 });
  removeStored(selected.map(run => run.id));
  // 只删除面板记录并关闭其订阅，不触碰会话、项目文件和其他记录。
  for (const run of selected) { for (const client of run.subscribers || []) endStream(client); runs.delete(run.id); }
  return { deletedIds: selected.map(run => run.id) };
}
module.exports = { TERMINAL_RUN_STATES, parseTaskContext, updateRunProjection, officeSnapshot, deleteRunHistory };
