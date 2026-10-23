const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTaskQueue } = require('./task-queue.cjs');
const { conversationRounds, deliveryNotifications } = require('./conversation-rounds.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(fail = false) {
  const runs = new Map(), launched = [], saved = []; let queue;
  const emitRun = run => queue.notify(run);
  queue = createTaskQueue({ runs, prepareInput: input => input,
    persist: list => saved.push(list.map(run => ({ id: run.id, status: run.status }))), emitRun,
    startRun: async (input, run) => { launched.push({ input, run }); if (fail) throw new Error('启动失败'); run.status = 'running'; },
    cancelRun: async run => { run.status = 'cancelled'; emitRun(run); } });
  const submit = (strategy = 'sequential', concurrency = 1) => queue.submit({ strategy, concurrency,
    members: ['a', 'b', 'c'].map(agentId => ({ agentId, goal: '检查', adapter: 'codex-app-server', context: { taskId: 'task', agentName: agentId }, cwd: process.cwd() })) });
  const complete = run => { run.status = 'completed'; run.output = '已经完成'; emitRun(run); };
  return { runs, queue, launched, saved, submit, complete };
}
test('全部队列席位先持久化，浏览器无连接时仍按终态事件继续接力', async () => {
  const f = fixture(); f.submit();
  assert.equal(f.saved[0].length, 3); assert.ok(f.saved[0].every(run => run.status === 'queued')); assert.equal(f.launched.length, 0);
  await tick(); assert.equal(f.launched.length, 1);
  assert.notEqual(conversationRounds([...f.runs.values()])[0].status, 'completed');
  assert.deepEqual(deliveryNotifications([[...f.runs.values()]]), []);
  f.complete(f.launched[0].run); await tick(); assert.equal(f.launched.length, 2);
  assert.equal(f.launched[1].input.context.handoffFrom.runId, f.launched[0].run.id);
  f.complete(f.launched[1].run); await tick(); f.complete(f.launched[2].run); await tick();
  assert.equal(conversationRounds([...f.runs.values()])[0].status, 'completed');
  assert.equal(deliveryNotifications([[...f.runs.values()]]).length, 1);
});
test('并发上限、整批停止和启动失败都不会留下永远排队的成员', async () => {
  const f = fixture(), root = f.submit('parallel', 2); await tick(); assert.equal(f.launched.length, 2);
  await f.queue.cancel(root.batch.id); await tick();
  assert.equal(f.launched.length, 2); assert.ok([...f.runs.values()].every(run => run.status === 'cancelled'));
  const broken = fixture(true); broken.submit(); await tick(); await tick();
  assert.deepEqual([...broken.runs.values()].map(run => run.status), ['failed', 'cancelled', 'cancelled']);
  assert.deepEqual(deliveryNotifications([[...broken.runs.values()]]), []);
});
test('重复成员、占用成员与非法并发在启动前拒绝，停止调度后不自动执行新任务', async () => {
  const f = fixture();
  assert.throws(() => f.submit('parallel', 0)); assert.equal(f.runs.size, 0);
  f.submit(); assert.throws(() => f.submit(), /已有运行/);
  f.queue.stop(); await tick(); assert.equal(f.launched.length, 0);
  assert.throws(() => f.submit(), /停止/);
});
