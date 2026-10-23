const { conversationRounds } = require('./conversation-rounds.cjs');
function interruptionMessage(run) {
  const reason = run?.interruption;
  if (!reason) return '';
  const label = reason === 'service-error' ? '服务发生异常' : reason === 'service-restart' ? '服务重启' : '服务停止';
  return `${label}，任务已中断；可在原会话查看已保存记录并继续。`;
}
function recordRunAlert(run, event) {
  if (event.type !== 'approval_resolved' || event.resolution !== 'timeout') return;
  const approval = event.approval, params = approval?.params || {};
  const detail = params.command || params.reason || params.cwd || approval?.method || event.method;
  const item = { id: `approval-timeout:${run.id}:${event.requestId}`, kind: 'approval-timeout', title: '权限审批已超时，操作未获批准',
    summary: `${run.context?.agentName || run.agentId}：${String(detail || '待确认操作').slice(0, 1200)}`, createdAt: event.time };
  run.alerts = [...(run.alerts || []).filter(value => value.id !== item.id), item].slice(-100);
}
function runAlertNotifications(chains) {
  return chains.flatMap(chain => conversationRounds(chain).flatMap(round => {
    const meta = { runId: chain[0].id, round: round.number, taskTitle: chain[0].context?.taskTitle || chain[0].goal, artifacts: [] };
    const notifications = round.runs.flatMap(run => (run.alerts || []).map(item => ({ ...meta, ...item })));
    if (['failed', 'cancelled'].includes(round.status)) {
      const interrupted = round.runs.some(run => run.interruption);
      notifications.push({ ...meta, id: `execution-${round.status}:${round.requestRunId}`, kind: interrupted ? 'interrupted' : round.status,
        title: interrupted ? '服务中断，任务尚未完成' : round.status === 'failed' ? '任务执行失败' : '任务已停止',
        summary: round.incompleteQueue ? '旧版浏览器队列中存在未启动的成员，本轮未完成。请查看原记录并重新安排未完成工作。' : round.runs.find(run => run.interruption) ? interruptionMessage(round.runs.find(run => run.interruption)) : round.runs.find(run => run.error)?.error || '任务未完成，可查看原会话中的状态并继续处理。', createdAt: round.endedAt });
    }
    return notifications;
  }));
}
module.exports = { interruptionMessage, recordRunAlert, runAlertNotifications };
