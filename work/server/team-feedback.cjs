const { randomUUID } = require('node:crypto');
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const isStopped = run => !run || run.cancelRequested || TERMINAL.has(run.status);
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}必须填写 1–${max} 个字符`);
  return value.trim();
};

// 数据归属经理运行并随历史持久化；仅 Promise 和定时器留在内存，不能跨重启恢复。
function createTeamFeedback({ runs, emitRun, timeoutMs = 5 * 60 * 1000 }) {
  const pending = new Map();
  // 子团队负责人同时是上级的成员；向上提问不能被当作自己的待答问题。
  const records = manager => (manager.feedback || []).filter(item => item.managerRunId === manager.id);
  const requests = manager => records(manager).filter(item => item.status === 'pending');
  const publish = (manager, member, record, type) => {
    emitRun(manager, { type, feedback: { ...record }, audience: 'manager' });
    emitRun(member, { type, feedback: { ...record }, audience: 'member' });
  };
  const result = record => ({ requestId: record.requestId, status: record.status, answer: record.answer || '',
    ...(record.status === 'answered' ? {} : { blocked: true, instruction: '不要猜测答案或继续依赖此答案的工作；说明阻塞并结束本次执行，等待经理重新安排。' }) });
  const settle = (entry, status, answer) => {
    if (!pending.has(entry.record.requestId)) return;
    pending.delete(entry.record.requestId); clearTimeout(entry.timer);
    Object.assign(entry.record, { status, answer, resolvedAt: new Date().toISOString(), ...(status === 'answered' ? { answeredAt: new Date().toISOString() } : {}) });
    publish(entry.manager, entry.member, entry.record, 'feedback_resolved');
    entry.resolve(result(entry.record));
  };
  function ask(member, args, callId) {
    const manager = runs.get(member.context?.coordinatorRunId);
    if (isStopped(member) || isStopped(manager) || manager.delivery?.status === 'completed') throw new Error('当前成员或项目经理已结束，不能继续提问');
    if (!manager.settings?.management?.members.some(item => item.id === member.agentId && item.id !== manager.agentId)
      || !member.context?.taskId || member.context.taskId !== manager.context?.taskId || runs.get(member.id) !== member) throw new Error('成员不属于此项目经理的任务');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('反馈参数必须是对象');
    const question = text(args.question, '问题', 4000), context = args.context == null || args.context === '' ? '' : text(args.context, '补充背景', 6000);
    const key = text(callId, '工具调用标识', 200);
    const old = records(manager).find(item => item.memberRunId === member.id && item.callId === key);
    if (old) {
      if (old.question !== question || old.context !== context) throw new Error('相同调用标识不能用于不同问题');
      return pending.get(old.requestId)?.promise || Promise.resolve(result(old));
    }
    if (requests(manager).some(item => item.memberRunId === member.id)) throw new Error('已有问题等待经理答复，请等待原提问返回');
    if (records(manager).length >= 100) throw new Error('本轮反馈已达 100 条，请整理问题后结束本轮，再继续此会话');
    const record = { requestId: 'feedback-' + randomUUID(), callId: key, memberRunId: member.id, managerRunId: manager.id,
      memberId: member.agentId, memberName: member.context.agentName || member.agentId, managerId: manager.agentId,
      managerName: manager.context?.agentName || '项目经理', question, context, status: 'pending', askedAt: new Date().toISOString() };
    const entry = { manager, member, record };
    entry.promise = new Promise(resolve => { entry.resolve = resolve; });
    pending.set(record.requestId, entry);
    entry.timer = setTimeout(() => settle(entry, 'expired', '项目经理超过 5 分钟未答复，本次反馈已超时。请在成员结束后重新派发处理。'), timeoutMs);
    entry.timer.unref?.();
    publish(manager, member, record, 'feedback_requested');
    return entry.promise;
  }
  function reply(manager, args) {
    if (isStopped(manager)) throw new Error('项目经理本轮已结束');
    const requestId = text(args?.requestId, '问题标识', 160), answer = text(args?.answer, '答复', 8000);
    const record = records(manager).find(item => item.requestId === requestId);
    if (!record) throw new Error('此问题不属于当前项目经理的本轮任务');
    // 相同答复重试幂等；内容冲突不覆盖成员已经收到的决定。
    if (record.status === 'answered' && record.answer === answer) return result(record);
    const entry = pending.get(requestId);
    if (!entry || entry.manager !== manager || record.status !== 'pending' || isStopped(entry.member)) throw new Error('问题已回复、超时或取消，请查看成员状态后重新安排');
    settle(entry, 'answered', answer);
    return result(entry.record);
  }
  function synchronize(changedRun) {
    for (const entry of [...pending.values()]) {
      if (changedRun && entry.manager !== changedRun && entry.member !== changedRun) continue;
      if (isStopped(entry.manager) || entry.manager.delivery?.status === 'completed') settle(entry, 'cancelled', '项目经理已结束或停止，本次等待已取消。');
      else if (isStopped(entry.member)) settle(entry, 'cancelled', '成员已结束或停止，本次等待已取消。');
    }
  }
  return { ask, reply, requests, synchronize };
}
module.exports = { createTeamFeedback };
