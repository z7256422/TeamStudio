/* 前后端共用的运行状态投影；分析阶段只接收适配器提供的公开摘要。 */
const ACTIVE_JOB_STATES = ['queued', 'starting', 'running', 'waiting', 'retrying', 'reconnecting', 'stopping'];
function approvalKey(approval) { return `${approval.runId || approval.agentId || ''}:${approval.requestId}`; }
// 无新事件只表示可观测进度停顿，不能据此判定模型已死锁或自动结束运行。
function runInactivity(job, now = Date.now()) {
  if (!job || !ACTIVE_JOB_STATES.includes(job.status) || job.status === 'queued') return null;
  const value = job.updatedAt || job.startedAt || job.createdAt;
  const last = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(last)) return null;
  const seconds = Math.max(0, Math.floor((now - last) / 1000));
  // 协调器由事件唤醒，挂起期间没有输出是预期行为。
  if (seconds < (['coordinating', 'waiting-manager', 'answering-feedback'].includes(job.phase) ? 150 : 30)) return null;
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  const explanation = job.phase === 'waiting-manager' ? '成员正在等待项目经理答复，可在成员反馈中查看问题。'
    : job.phase === 'answering-feedback' ? '项目经理正在处理成员问题，请查看反馈记录。'
    : job.status === 'waiting' ? '请处理待审批请求或补充输入。'
    : job.status === 'reconnecting' ? '实时连接正在恢复，尚不能确认引擎进度。'
    : job.status === 'stopping' ? '正在等待引擎确认停止，请勿重复启动相同任务。'
    : job.phase === 'coordinating' ? '项目经理正在等待成员，请查看成员状态或待审批事项。'
    : '引擎可能仍在生成内容或等待响应；仅凭无新事件无法判断卡死。';
  return { seconds, duration, message: `最近 ${duration}没有新的执行事件。${explanation}` };
}
function jobFromRunEvent(previous = {}, event) {
  if (event.type === 'reasoning_summary' && previous.runId && event.runId && previous.runId !== event.runId) return previous;
  const now = Date.parse(event.time) || Date.now();
  const job = { ...previous, runId: event.runId || previous.runId };
  // 同一运行结束后，迟到的输出和工具事件不能让成员重新显示执行中。
  if (['done', 'failed', 'cancelled'].includes(previous.status) && !['completed', 'error', 'cancelled', 'submitted'].includes(event.type)) return job;
  const projectSummary = typeof module !== 'undefined' && module.exports ? require('./run-reasoning.js').projectReasoningSummaries : typeof projectReasoningSummaries === 'function' ? projectReasoningSummaries : null;
  if (event.type === 'reasoning_summary') {
    const summaries = projectSummary(previous.reasoningSummaries, event);
    if (summaries === previous.reasoningSummaries) return previous;
    job.reasoningSummaries = summaries;
  }
  const activity = (label, status = 'running', phase = 'waiting-engine') => {
    job.activity = label; job.status = status; job.phase = phase; job.updatedAt = now;
    job.startedAt ||= now;
  };
  const step = (item, label, finished) => {
    const steps = [...(job.steps || [])];
    let index = steps.findIndex(entry => entry.id === item.id);
    const waitingForMembers = item.type === 'dynamicToolCall' && item.tool === 'team_wait';
    const repeatedWait = index < 0 && waitingForMembers && steps.at(-1)?.waitingForMembers;
    if (repeatedWait) index = steps.length - 1;
    const old = index < 0 ? {} : steps[index];
    const failed = item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0);
    const entry = { ...old, id: item.id, label, time: now, startedAt: old.startedAt || now, endedAt: finished ? now : null,
      status: finished ? (failed ? 'failed' : 'done') : 'running',
      detail: item.command || item.changes?.map(change => change.path).join('\n') || [item.server, item.tool].filter(Boolean).join(' / ') || old.detail || '',
      waitingForMembers, waitCount: waitingForMembers ? (old.waitCount || 0) + (repeatedWait || !old.waitCount ? 1 : 0) : undefined,
      output: (item.aggregatedOutput || item.error?.message || old.output || '').slice(-8000), exitCode: item.exitCode };
    if (waitingForMembers) entry.label = entry.waitCount > 1 ? `等待成员（${entry.waitCount} 次合并）` : '等待成员';
    if (index < 0) steps.push(entry); else steps[index] = entry;
    job.steps = steps.slice(-40);
    activity(finished ? (failed ? `${label}失败，等待 Agent 处理` : `${label}完成，等待下一步`) : label, 'running', finished ? 'waiting-engine' : item.type);
  };
  if (event.type === 'submitted') activity('正在连接执行引擎', 'starting');
  if (event.type === 'thread_started') activity('会话已建立，正在启动任务', 'starting');
  if (['started', 'turn_accepted'].includes(event.type)) activity('正在分析任务', 'running', 'thinking');
  if (event.type === 'reasoning_summary' && job.reasoningSummaries.at(-1)?.id === event.itemId &&
    !previous.reasoningSummaries?.some(entry => entry.id === event.itemId && entry.status !== 'streaming')) {
    activity(event.stage === 'completed' ? '分析阶段已结束，等待引擎下一步' : event.stage === 'delta' ? '正在分析任务 · 接收思考摘要' : '正在分析任务', 'running', event.stage === 'completed' ? 'waiting-engine' : 'thinking');
  }
  if (event.type === 'message_delta') {
    const phase = job.messageItemId === event.itemId ? job.messagePhase : null;
    activity(phase === 'commentary' ? '正在汇报进展' : phase === 'final_answer' ? '正在整理最终回复' : '正在输出回复', 'running', phase === 'commentary' ? 'reporting' : phase === 'final_answer' ? 'writing' : 'replying'); job.output = ((job.output || '') + (event.delta || '')).slice(-20000);
  }
  if (event.type === 'tool_output') {
    job.updatedAt = now;
    job.steps = (job.steps || []).map(entry => entry.id === event.itemId ? { ...entry, output: ((entry.output || '') + (event.delta || '')).slice(-8000) } : entry);
  }
  if (event.type === 'coordination') activity(event.message || '项目经理协调中', 'running', event.stage === 'waiting-members' ? 'coordinating' : 'reviewing');
  if (event.type === 'feedback_requested') {
    job.pendingFeedback = [...new Set([...(job.pendingFeedback || []), event.feedback.requestId])];
    job.feedbackRole = event.audience;
    activity(event.audience === 'manager' ? '收到成员提问，正在协调答复' : '已提问，等待项目经理答复', event.audience === 'manager' ? 'running' : 'waiting', event.audience === 'manager' ? 'answering-feedback' : 'waiting-manager');
  }
  if (event.type === 'feedback_resolved') {
    job.pendingFeedback = (job.pendingFeedback || []).filter(id => id !== event.feedback.requestId);
    activity(event.feedback.status === 'answered' ? (event.audience === 'manager' ? '已答复成员，继续协调' : '经理已答复，继续执行') : '反馈已结束，请查看阻塞原因');
  }
  if (event.type === 'provider_event') {
    const params = event.params || {}, item = params.item;
    if (event.method === 'item/started' || event.method === 'item/completed') {
      const finished = event.method === 'item/completed';
      const labels = { commandExecution: '执行命令', fileChange: '修改文件', mcpToolCall: '调用 MCP 工具', dynamicToolCall: '调用工具', webSearch: '搜索资料' };
      if (item && labels[item.type]) step(item, labels[item.type], finished);
      if (item?.type === 'agentMessage') {
        job.messageItemId = item.id; job.messagePhase = item.phase;
        activity(item.phase === 'commentary' ? '正在汇报进展' : item.phase === 'final_answer' ? '正在整理最终回复' : '正在输出回复', 'running', item.phase === 'commentary' ? 'reporting' : item.phase === 'final_answer' ? 'writing' : 'replying');
      }
      if (item?.type === 'reasoning') activity(finished ? '分析阶段已结束，等待引擎下一步' : '正在分析任务', 'running', finished ? 'waiting-engine' : 'thinking');
    }
    if (event.method === 'error') {
      const message = params.error?.message || '执行引擎发生错误';
      activity(params.willRetry ? `引擎正在重试：${message}` : message, params.willRetry ? 'retrying' : 'failed');
      if (!params.willRetry) { job.error = message; job.endedAt = now; }
    }
    if (event.method === 'thread/status/changed') {
      const flags = params.status?.activeFlags || [];
      if (flags.includes('waitingOnApproval')) activity('等待确认，可在消息中心、聊天或办公室处理', 'waiting');
      else if (flags.includes('waitingOnUserInput')) activity('等待你补充信息', 'waiting');
    }
  }
  if (event.type === 'approval_required') {
    job.pendingApprovals = [...new Set([...(job.pendingApprovals || []), approvalKey(event)])];
    activity('等待确认，可在消息中心、聊天或办公室处理', 'waiting');
  }
  if (event.type === 'approval_resolved') {
    job.pendingApprovals = (job.pendingApprovals || []).filter(key => key !== approvalKey(event));
    activity(event.resolution === 'timeout' ? '审批已超时，等待引擎返回结果' : '审批已处理，等待引擎继续');
  }
  if (event.type === 'connection_lost') activity('实时连接中断，正在重新连接', 'reconnecting');
  if (event.type === 'connection_restored') activity('连接已恢复，等待下一步');
  if (event.type === 'stopping') activity('正在停止执行', 'stopping');
  if (event.type === 'cancel_failed') activity(`停止失败：${event.message}；仍在跟踪原运行，可再次停止。`);
  if (event.type === 'completed' || event.type === 'error' || event.type === 'cancelled') {
    job.status = event.type === 'error' ? 'failed' : event.type === 'cancelled' ? 'cancelled' : event.status === 'completed' ? 'done' : event.status === 'cancelled' || event.turn?.status === 'interrupted' ? 'cancelled' : 'failed';
    job.error = event.message || event.turn?.error?.message || (job.status === 'failed' ? '引擎未能完成任务，请查看执行步骤' : '');
    job.activity = job.status === 'done' ? '执行完成' : job.status === 'failed' ? '执行失败' : '执行已停止';
    job.endedAt = now; job.updatedAt = now; job.pendingApprovals = []; job.pendingFeedback = [];
  } else if (job.pendingApprovals?.length && job.status !== 'stopping') {
    job.status = 'waiting'; job.activity = '等待确认，可在消息中心、聊天或办公室处理';
  } else if (job.pendingFeedback?.length && job.status !== 'stopping') {
    job.status = job.feedbackRole === 'manager' ? 'running' : 'waiting';
    job.phase = job.feedbackRole === 'manager' ? 'answering-feedback' : 'waiting-manager';
    job.activity = job.feedbackRole === 'manager' ? `正在处理 ${job.pendingFeedback.length} 条成员提问` : '等待项目经理答复';
  }
  if (event.type !== 'reasoning_summary' && job.reasoningSummaries?.length) {
    job.reasoningSummaries = projectSummary(job.reasoningSummaries, event);
  }
  return job;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { ACTIVE_JOB_STATES, approvalKey, jobFromRunEvent, runInactivity };
