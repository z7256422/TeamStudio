const { randomUUID } = require('node:crypto');
const { TERMINAL_RUN_STATES } = require('./run-metadata.cjs');
const { resultDocument } = require('./team-results.cjs');

// 先持久化全部席位，再执行；浏览器断开不改变队列，终态事件负责唤醒后续派发。
function createTaskQueue({ runs, startRun, cancelRun, emitRun, prepareInput, persist = () => {} }) {
  const scheduled = new Set(); let stopped = false;
  const members = id => [...runs.values()].filter(run => run.batch?.id === id).sort((a, b) => a.batch.order - b.batch.order);
  function cancelQueued(list, message) {
    for (const run of list) if (run.status === 'queued') {
      run.status = 'cancelled'; run.error = message; delete run.queuedInput;
      emitRun(run, { type: 'cancelled', status: run.status, message });
    }
  }
  function schedule(batchId) {
    if (stopped || scheduled.has(batchId)) return;
    scheduled.add(batchId);
    queueMicrotask(() => {
      scheduled.delete(batchId); if (stopped) return;
      const list = members(batchId);
      if (!list.length) return;
      if (list.some(run => ['failed', 'cancelled'].includes(run.status))) { cancelQueued(list, '前序成员未完成，后续成员未启动。'); return; }
      const active = list.filter(run => run.status !== 'queued' && !TERMINAL_RUN_STATES.has(run.status)).length;
      for (const run of list.filter(run => run.status === 'queued').slice(0, Math.max(0, list[0].batch.concurrency - active))) {
        run.status = 'starting';
        run.progress = { ...run.progress, startedAt: Date.now() };
        const input = { ...run.queuedInput }, previous = list[run.batch.order - 1];
        if (run.batch.strategy === 'sequential' && previous) {
          input.context = { ...input.context, handoffFrom: { agentId: previous.agentId, name: previous.context.agentName, runId: previous.id } };
          input.developerInstructions = (input.developerInstructions || '') + '\n\n接力执行：先核验共享工作区与前序产物，再完成本职工作。前序公开结果预览（超长时省略后文，完整内容保留在原运行记录）：\n' + resultDocument(previous).content.slice(0, 6000);
        }
        emitRun(run, { type: 'submitted' });
        void startRun(input, run).catch(error => {
          if (!TERMINAL_RUN_STATES.has(run.status)) { run.status = 'failed'; run.error = error.message; emitRun(run, { type: 'error', message: error.message }); }
        }).finally(() => { delete run.queuedInput; persist([run]); schedule(batchId); });
      }
    });
  }
  function submit(body) {
    if (stopped) throw new Error('服务正在停止，不能提交任务');
    if (!body || !['parallel', 'sequential', 'current'].includes(body.strategy) || !Array.isArray(body.members) || !body.members.length || body.members.length > 200) throw Object.assign(new Error('任务需包含有效执行方式和 1–200 个成员'), { statusCode: 400 });
    const concurrency = body.strategy === 'parallel' ? body.concurrency ?? 1 : 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200 || (body.strategy === 'current' && body.members.length !== 1)) throw Object.assign(new Error('无效的任务并发数或成员数量'), { statusCode: 400 });
    const inputs = body.members.map(prepareInput), ids = inputs.map(input => input.agentId);
    if (new Set(ids).size !== ids.length) throw Object.assign(new Error('同一队列不能重复包含成员'), { statusCode: 400 });
    if ([...runs.values()].some(run => ids.includes(run.agentId) && !TERMINAL_RUN_STATES.has(run.status))) throw Object.assign(new Error('成员已有运行或排队任务，请先等待或停止'), { statusCode: 409 });
    if (inputs[0].context?.taskId && [...runs.values()].some(run => run.context?.taskId === inputs[0].context.taskId)) throw Object.assign(new Error('该任务标识已经提交，请查看历史记录，勿重复启动'), { statusCode: 409 });
    const batchId = randomUUID(), taskId = inputs[0].context?.taskId || randomUUID(), started = Date.now();
    const list = inputs.map((input, order) => {
      const context = { ...input.context, taskId, roundId: batchId, dispatchMode: body.strategy, expectedAgentIds: ids,
        coordinatorRunId: null, coordinatorAgentId: inputs[0].agentId, coordinatorAgentName: inputs[0].context?.agentName, source: { kind: 'user', name: '本机用户' } };
      const createdAt = new Date(started + order).toISOString();
      return { id: 'run-' + randomUUID(), agentId: input.agentId, adapter: input.adapter, cwd: input.cwd, goal: input.goal, model: input.model || 'default', context,
        batch: { id: batchId, strategy: body.strategy, concurrency, order }, queuedInput: { ...input, context },
        settings: { sandbox: input.sandbox, approvalPolicy: input.approvalPolicy }, status: 'queued', events: [], output: '', approvals: new Map(), subscribers: new Set(),
        createdAt, updatedAt: createdAt, progress: { status: 'queued', activity: '等待服务端派发' } };
    });
    persist(list);
    for (const run of list) runs.set(run.id, run);
    for (const run of list) emitRun(run, { type: 'queued' });
    schedule(batchId); return list[0];
  }
  async function cancel(batchId) {
    const list = members(batchId); cancelQueued(list, '用户停止了本轮队列，成员未启动。');
    const results = await Promise.allSettled(list.filter(run => !TERMINAL_RUN_STATES.has(run.status)).map(cancelRun));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new Error(errors.map(result => result.reason.message).join('；'));
    return { runId: list[0]?.id, status: list.some(run => !TERMINAL_RUN_STATES.has(run.status)) ? 'stopping' : 'cancelled' };
  }
  return { submit, cancel, notify: run => { if (run.batch && TERMINAL_RUN_STATES.has(run.status)) schedule(run.batch.id); }, stop: () => { stopped = true; } };
}
module.exports = { createTaskQueue };
