/* 对话展示模型：使用服务端轮次与公开进展，兼容旧记录缺少消息边界的情况。 */
function conversationJob(run) {
  let job = run.progress || (run.events || []).reduce(jobFromRunEvent, { status: 'starting', startedAt: Date.parse(run.startedAt || run.createdAt) });
  if (['completed', 'failed', 'cancelled'].includes(run.status)) job = jobFromRunEvent(job, { type: 'completed', status: run.status, message: run.error, time: run.endedAt || run.updatedAt });
  return job;
}
function conversationMessages(run) {
  if (run.messages?.some(message => message.text)) return run.messages.filter(message => message.text);
  if (!run.output) return [];
  // 旧版只保存整段输出，明确标记，不能伪造逐条消息时间或猜测哪段是最终结论。
  return [{ id: 'legacy-output', text: run.output, phase: null, legacy: true }];
}
function taskStatusLabel(status) {
  return ({ completed: '已完成', queued: '排队中', running: '执行中', starting: '启动中', cancelled: '已停止', failed: '未完成' })[status] || status;
}
function displayTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function assignmentText(run) {
  return run.context?.assignment || run.goal?.split('项目经理分配的子任务：')[1]?.trim() || run.context?.taskTitle || run.goal;
}
