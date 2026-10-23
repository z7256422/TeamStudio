const TEAM_PROTOCOL_VERSION = 2;

// Codex 只允许 thread/start 注册 dynamicTools，旧线程必须显式迁移，不能仅更新提示词。
function prepareTeamThread(runs, { agentId, threadId, enabled, toolRole }) {
  if (!enabled || !threadId) return { threadId, instructions: '', migration: null };
  const history = [...runs.values()].filter(run => run.agentId === agentId && run.threadId === threadId);
  const previous = history.at(-1);
  const previousRole = previous?.settings?.teamToolRole || (previous?.settings?.management ? 'manager' : 'member');
  if (previous?.settings?.teamProtocolVersion === TEAM_PROTOCOL_VERSION && (!toolRole || previousRole === toolRole)) return { threadId, instructions: '', migration: null };
  const context = history.slice(-3).map(run => ({ goal: (run.goal || '').slice(0, 2000), assignment: run.context?.assignment?.slice(0, 1000), status: run.status,
    output: ((run.messages || []).map(item => item.text).filter(Boolean).join('\n') || run.output || '').slice(-4000), error: (run.error || '').slice(0, 1000),
    feedback: (run.feedback || []).slice(-1).map(item => ({ question: item.question?.slice(0, 1000), answer: item.answer?.slice(0, 1000), status: item.status })) }));
  const owners = new Set(history.map(run => run.id));
  const results = [...runs.values()].filter(run => owners.has(run.context?.coordinatorRunId)).slice(-20)
    .map(run => ({ runId: run.id, agentId: run.agentId, status: run.status }));
  return { threadId: undefined, migration: { fromThreadId: threadId, reason: '团队工具或管理职责已变化，需要迁移旧引擎线程；已保留原任务历史并带入近期公开结果，完整旧引擎上下文不自动复制。' },
    instructions: '\n\n【旧线程兼容迁移】\n下列内容是原任务近期公开记录，不代表工作已完成。请结合当前分工重新核验工作区；缺少信息时按新反馈协议询问，不要假设还持有完整旧上下文。\n' + JSON.stringify(context)
      + (results.length ? '\n近期直属成员历史成果（可用 team_read_result 按 runId 补读，不必重新派工）：\n' + JSON.stringify(results) : '') };
}
module.exports = { TEAM_PROTOCOL_VERSION, prepareTeamThread };
