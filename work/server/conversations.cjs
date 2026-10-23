const { TERMINAL_RUN_STATES } = require('./run-metadata.cjs');
const { randomUUID } = require('node:crypto');
function sameConversation(left, right) {
  if (left.context?.taskId || right.context?.taskId) return !!left.context?.taskId && left.context.taskId === right.context?.taskId;
  return !!left.threadId && left.threadId === right.threadId && left.adapter === right.adapter;
}
function conversationRuns(runs, selected) {
  return [...runs.values()].filter(run => run.id === selected.id || sameConversation(run, selected)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
// 没有引擎会话的失败记录单独成组，避免不同任务误合并。
function conversationKey(run) {
  if (run.context?.taskId) return JSON.stringify(['task', run.context.taskId]);
  return JSON.stringify(run.threadId ? ['thread', run.adapter, run.threadId] : ['run', run.id]);
}
function groupedConversations(runs) {
  const groups = new Map();
  for (const run of runs.values()) {
    const key = conversationKey(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.values()].map(chain => chain.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    .sort((a, b) => b.at(-1).createdAt.localeCompare(a.at(-1).createdAt));
}
function canDeleteConversation(chain) { return chain.every(run => TERMINAL_RUN_STATES.has(run.status) && !run.approvals?.size); }
function coordinatorRun(chain) {
  const id = chain.find(run => run.context?.coordinatorAgentId)?.context.coordinatorAgentId;
  return chain.find(run => run.agentId === id) || chain.find(run => run.context?.agentRole === 'ProjectManager') || chain[0];
}
function assertRunAvailable(runs, agentId, threadId, reservedId = null) {
  const active = [...runs.values()].find(run => run.id !== reservedId && !TERMINAL_RUN_STATES.has(run.status) && (run.agentId === agentId || (threadId && run.threadId === threadId)));
  if (active) throw Object.assign(new Error('此成员或会话仍在运行，请等待完成或先停止当前运行'), { statusCode: 409 });
}
function continuationInput(runs, previous, goal) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 12000) throw Object.assign(new Error('请填写 1–12000 个字符的后续要求'), { statusCode: 400 });
  if (!previous.threadId) throw Object.assign(new Error('这条记录没有可恢复的会话，请创建新任务'), { statusCode: 409 });
  if (previous.approvals?.size) throw Object.assign(new Error('请先处理这条记录的待审批请求'), { statusCode: 409 });
  assertRunAvailable(runs, previous.agentId, previous.threadId);
  // threadId 必须来自选中的历史记录，不能取成员最近使用的另一条会话。
  return { ...(previous.settings || {}), agentId: previous.agentId, adapter: previous.adapter, cwd: previous.cwd, threadId: previous.threadId,
    goal: goal.trim(), parentRunId: previous.id,
    context: { ...(previous.context || {}), roundId: randomUUID(), expectedAgentIds: null, taskTitle: goal.trim(), source: { kind: 'user', name: '本机用户' }, dispatchMode: 'continuation', handoffFrom: null } };
}
module.exports = { sameConversation, conversationKey, conversationRuns, groupedConversations, canDeleteConversation, coordinatorRun, assertRunAvailable, continuationInput };
