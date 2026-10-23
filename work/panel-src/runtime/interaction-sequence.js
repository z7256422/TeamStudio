/* 将统一会话契约投影为参与者和有向交互；不根据回复文本猜测派发关系或读取时间。 */
function buildInteractionSequence(conversation, channelMessages = []) {
  const runs = conversation?.runs || [], rounds = conversation?.rounds || [];
  const runById = new Map(runs.map(run => [run.runId, run]));
  const roundByRun = new Map(rounds.flatMap(round => (round.runIds || []).map(id => [id, round])));
  const actors = new Map(), events = [], warnings = new Set(), dependencies = new Map();
  const after = (id, prerequisite) => dependencies.set(id, [...(dependencies.get(id) || []), prerequisite]);
  const timestamp = value => {
    if (value == null || value === '') return null;
    const time = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(time) ? time : null;
  };
  const actor = (id, name, role = '') => {
    if (!actors.has(id)) actors.set(id, { id, name: name || id, role });
    return id;
  };
  const member = (id, name, role) => actor('agent:' + id, name || id, role);
  const user = actor('user', '用户', '任务发起人');
  runs.forEach(run => member(run.agentId, run.context?.agentName, run.context?.agentRole));
  const sourceFor = run => {
    const context = run.context || {}, parent = runById.get(context.coordinatorRunId);
    if (parent) return member(parent.agentId, parent.context?.agentName);
    if (context.source?.kind === 'agent' && context.source.id) return member(context.source.id, context.source.name);
    if (context.handoffFrom?.agentId) return member(context.handoffFrom.agentId, context.handoffFrom.name);
    if (context.coordinatorRunId || context.source?.kind === 'agent') {
      warnings.add('部分派发来源缺少完整记录，已标记未知来源。');
      return actor('unknown:' + (context.coordinatorRunId || run.runId), context.source?.name || context.coordinatorAgentName || '来源未记录');
    }
    return user;
  };
  const add = (run, value) => {
    const round = roundByRun.get(run.runId);
    const time = timestamp(value.time);
    events.push({ runId: run.runId, roundId: round?.id || run.runId, roundNumber: round?.number || 1,
      attempt: round?.attemptByRun?.[run.runId] || 1, order: events.length, ...value, time });
    if (time == null) warnings.add('部分旧记录未保存准确时间，显示在所属轮次末尾，不推测时间。');
  };
  for (const run of runs) {
    const context = run.context || {}, round = roundByRun.get(run.runId);
    const own = member(run.agentId, context.agentName), from = sourceFor(run);
    const attempt = round?.attemptByRun?.[run.runId] || 1;
    const delegated = from !== user;
    add(run, { id: run.runId + ':request', kind: delegated ? 'dispatch' : 'request', from, to: own,
      title: delegated ? (attempt > 1 ? `派发返工 · 第 ${attempt} 次` : context.dispatchMode === 'sequential' ? '接力任务' : '派发任务') : (round?.number > 1 ? '继续会话' : '发起任务'),
      time: context.dispatchMode === 'sequential' && context.handoffFrom ? run.startedAt || run.createdAt : run.createdAt || run.startedAt, status: run.status,
      content: delegated ? (context.assignment || run.goal || '') : (round?.goal || context.taskTitle || run.goal || '') });
    const messages = (run.messages || []).filter(message => message.text);
    for (const [index, message] of messages.entries()) {
      // 最终回复随完成事件返回；过程消息只作为成员自身的公开进展，不推断接收方。
      if (message.phase === 'final_answer' && ['completed', 'failed', 'cancelled'].includes(run.status)) continue;
      add(run, { id: run.runId + ':progress:' + (message.id || index), kind: 'progress', from: own, to: own,
        title: '公开进展', time: message.startedAt, content: message.text, status: run.status });
    }
    for (const [index, step] of (run.progress?.steps || []).entries()) {
      add(run, { id: run.runId + ':operation:' + (step.id || index), kind: 'operation', from: own, to: own,
        title: step.label || '执行操作', time: step.startedAt || step.time, endedAt: timestamp(step.endedAt),
        content: step.detail || '', output: step.output || '', exitCode: step.exitCode, status: step.status });
    }
    if ((run.progress?.steps || []).length >= 40 || (run.events || []).length >= 200) {
      warnings.add('部分记录已达到历史保留上限，早期操作可能未保存；图中仅展示已有记录。');
    }
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) continue;
    const finalMessages = messages.filter(message => message.phase === 'final_answer');
    const output = finalMessages.length ? finalMessages.map(message => message.text).join('\n\n') : (run.output || '');
    const delivery = !context.coordinatorRunId && (run.coordination || (round?.requestRunId === run.runId ? round.delivery : null));
    const accepted = run.status === 'completed' && delivery?.status === 'completed';
    const legacy = !finalMessages.length && !!output;
    add(run, { id: run.runId + ':result', kind: accepted ? 'delivery' : run.status === 'completed' ? 'result' : 'failure',
      from: own, to: accepted ? user : from, response: true, status: run.status,
      title: accepted ? (delivery.mode === 'reply' ? '答复用户' : delivery.mode === 'report' ? '提交报告' : '验收交付') : run.status === 'failed' ? '执行失败' : run.status === 'cancelled' ? '执行停止' : output ? '返回结果' : '执行结束（无返回内容）',
      time: run.endedAt, content: accepted ? delivery.reply || delivery.summary : output,
      output: accepted ? output : '', error: run.error || '', artifacts: accepted ? delivery.artifacts || [] : [],
      verification: accepted ? delivery.verification || [] : [],
      note: [delegated ? '箭头按派发关系指向任务发起方；时间为成员执行结束时间，未记录对方实际读取时间。' : '',
        legacy ? '此记录仅保留合并输出，缺少逐条回复边界。' : ''].filter(Boolean).join('\n') });
  }
  // 同一问答在经理和成员运行中各保存一份，图中只显示一次真实的提问/答复。
  const feedback = new Map();
  for (const run of runs) for (const item of run.feedback || []) {
    const old = feedback.get(item.requestId);
    if (!old || (item.resolvedAt || item.askedAt) > (old.item.resolvedAt || old.item.askedAt)) feedback.set(item.requestId, { run, item });
  }
  for (const { run, item } of feedback.values()) {
    const owner = runById.get(item.memberRunId) || run;
    const from = member(item.memberId, item.memberName), to = member(item.managerId, item.managerName);
    add(owner, { id: item.requestId + ':question', kind: 'message', from, to, title: '成员提问', time: item.askedAt,
      content: item.question, output: item.context || '', status: item.status });
    if (item.status === 'answered') add(owner, { id: item.requestId + ':answer', kind: 'message', from: to, to: from,
      title: '经理答复', response: true, time: item.answeredAt, content: item.answer, status: item.status });
    else if (item.status !== 'pending') add(owner, { id: item.requestId + ':closed', kind: 'failure', from: actor('system', '协调服务'), to: from,
      title: item.status === 'expired' ? '反馈超时' : '反馈取消', time: item.resolvedAt, content: item.answer, status: item.status });
    after(item.requestId + ':question', item.memberRunId + ':request');
    after(item.requestId + ':answer', item.requestId + ':question');
    after(item.memberRunId + ':result', item.requestId + (item.status === 'answered' ? ':answer' : ':closed'));
  }
  // 仅接纳明确关联本会话 runId 的消息，防止同一成员在不同任务中的消息串入。
  const seenMessages = new Set();
  for (const message of channelMessages) {
    const run = runById.get(message.runId);
    if (!run || !message.id || seenMessages.has(message.id) || !message.content) continue;
    seenMessages.add(message.id);
    const sender = runById.get(message.runId);
    const from = member(message.fromAgentId, sender.agentId === message.fromAgentId ? sender.context?.agentName : null);
    const to = message.toAgentId ? member(message.toAgentId) : actor('broadcast', '团队频道', '广播消息');
    add(run, { id: 'channel:' + message.id, kind: 'message', from, to, title: message.replyTo ? '回复消息' : message.toAgentId ? '成员消息' : '团队广播',
      time: message.createdAt, content: message.content, replyTo: message.replyTo || null });
  }
  if ((conversation?.total || 0) > runs.length) warnings.add(`当前已加载 ${runs.length} / ${conversation.total} 次执行，其余执行尚未包含在图中。`);
  events.sort((left, right) => left.roundNumber - right.roundNumber || (left.time ?? Infinity) - (right.time ?? Infinity) || left.order - right.order);
  for (const run of runs) {
    after(run.runId + ':result', run.runId + ':request');
    if (run.context?.coordinatorRunId) after(run.context.coordinatorRunId + ':result', run.runId + ':result');
  }
  // 同一毫秒可能既答复又完成，只按已知因果排序同时间组，不篡改原始时间。
  for (let start = 0; start < events.length;) {
    let end = start + 1;
    while (end < events.length && events[end].time === events[start].time && events[end].roundNumber === events[start].roundNumber) end++;
    const pending = events.slice(start, end), ordered = [];
    while (pending.length) {
      const remaining = new Set(pending.map(event => event.id));
      const index = pending.findIndex(event => !(dependencies.get(event.id) || []).some(id => remaining.has(id)));
      ordered.push(...pending.splice(index < 0 ? 0 : index, 1));
    }
    events.splice(start, end - start, ...ordered); start = end;
  }
  const used = new Set(events.flatMap(event => [event.from, event.to]));
  return { actors: [...actors.values()].filter(entry => used.has(entry.id)), events, rounds, warnings: [...warnings] };
}
function filterInteractionEvents(sequence, { roundId = 'all', actorId = 'all', detailed = false } = {}) {
  return sequence.events.filter(event => (roundId === 'all' || event.roundId === roundId) &&
    (actorId === 'all' || event.from === actorId || event.to === actorId) &&
    (detailed || !['operation', 'progress'].includes(event.kind)));
}
if (typeof module !== 'undefined' && module.exports) module.exports = { buildInteractionSequence, filterInteractionEvents };
