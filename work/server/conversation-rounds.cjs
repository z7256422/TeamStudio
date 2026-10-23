/* 用户提交才创建对话轮次；派发与返工都挂在发起它们的经理轮次下。
 * roundId 用于新记录，旧数据按调度关系恢复，不改写历史库。 */
function conversationRounds(chain) {
  const rounds = [], byRound = new Map(), byRun = new Map();
  for (const run of chain) {
    const context = run.context || {};
    let round = byRun.get(context.coordinatorRunId) || byRound.get(context.roundId);
    if (!round && !context.coordinatorRunId && !context.roundId && context.taskId && context.dispatchMode !== 'continuation') round = rounds[0];
    if (!round && context.coordinatorRunId) round = rounds.at(-1);
    if (!round) {
      round = { id: context.roundId || run.id, number: rounds.length + 1, requestRunId: run.id,
        goal: context.taskTitle || run.goal, createdAt: run.createdAt, runs: [] };
      rounds.push(round); byRound.set(round.id, round);
    }
    round.runs.push(run); byRun.set(run.id, round);
  }
  return rounds.map(round => {
    const attempts = new Map();
    const attemptByRun = Object.fromEntries(round.runs.map(run => { const attempt = (attempts.get(run.agentId) || 0) + 1; attempts.set(run.agentId, attempt); return [run.id, attempt]; }));
    const manager = round.runs.find(run => run.settings?.management);
    const active = round.runs.find(run => !['completed', 'failed', 'cancelled'].includes(run.status));
    const expected = round.runs[0].context?.expectedAgentIds;
    const incompleteQueue = !active && !manager && expected?.some(id => !round.runs.some(run => run.agentId === id));
    const status = active?.status || manager?.status || (incompleteQueue || round.runs.some(run => run.status === 'failed') ? 'failed' : round.runs.some(run => run.status === 'cancelled') ? 'cancelled' : round.runs.at(-1).status);
    const endedAt = active ? null : round.runs.reduce((latest, run) => (run.endedAt || run.updatedAt || run.createdAt) > latest ? (run.endedAt || run.updatedAt || run.createdAt) : latest, '');
    return { ...round, status, incompleteQueue: Boolean(incompleteQueue), endedAt, manager, delivery: manager?.delivery || null, memberCount: attempts.size, attemptByRun, runIds: round.runs.map(run => run.id) };
  });
}

// 通知从持久化运行结果投影，关闭页面后完成的交付也能找回；成员完成不冒充整轮交付。
function deliveryNotifications(chains) {
  const finished = round => {
    if (round.status !== 'completed') return false;
    if (round.manager) return round.manager.delivery?.status === 'completed';
    const context = round.runs[0].context || {};
    if (context.dispatchMode === 'manager') return false;
    // 浏览器队列可能尚未启动后续成员，必须等这一轮的预期成员都结束。
    if (['parallel', 'sequential'].includes(context.dispatchMode)) return !!context.expectedAgentIds?.length && context.expectedAgentIds.every(id => round.runs.some(run => run.agentId === id && run.status === 'completed'));
    return true;
  };
  return chains.flatMap(chain => conversationRounds(chain).filter(finished).map(round => ({
    id: 'delivery:' + round.requestRunId, kind: 'delivery', runId: chain[0].id, round: round.number,
    title: round.manager?.delivery?.mode === 'reply' ? '项目经理已回复' : round.manager?.delivery?.mode === 'report' ? '审查与分析报告已完成' : round.manager ? '任务已验收交付' : '任务执行完成', taskTitle: chain[0].context?.taskTitle || chain[0].goal,
    summary: round.manager?.delivery.summary || round.goal, createdAt: round.endedAt,
    artifacts: round.manager?.delivery.artifacts || []
  }))).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 100);
}
function feedbackNotifications(chains) {
  return chains.flatMap(chain => conversationRounds(chain).flatMap(round => round.runs.flatMap(run => (run.feedback || []).filter(item => item.managerRunId === run.id && item.status === 'expired')).map(item => ({
    id: 'feedback-timeout:' + item.requestId, kind: 'feedback', runId: chain[0].id, round: round.number,
    title: '成员反馈等待超时', taskTitle: chain[0].context?.taskTitle || chain[0].goal,
    summary: `${item.memberName} → ${item.managerName}：${item.question}`, createdAt: item.resolvedAt, artifacts: []
  }))));
}
module.exports = { conversationRounds, deliveryNotifications, feedbackNotifications };
