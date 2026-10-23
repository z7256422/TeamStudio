const { test } = require('node:test');
const assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { writeStream } = require('./sse.cjs');
const { createEngineReadiness } = require('./engine-readiness.cjs');
const { createHistorySnapshots, compactRun } = require('./history-view.cjs');
const { interruptionMessage, recordRunAlert, runAlertNotifications } = require('./run-alerts.cjs');
const { installServiceLifecycle } = require('./service-lifecycle.cjs');

test('坏连接、异步写失败与背压隔离，不影响另一个 SSE 客户端', () => {
  const bad = new EventEmitter(); bad.destroy = () => { bad.destroyed = true; }; bad.write = () => { throw new Error('broken pipe'); };
  assert.equal(writeStream(bad, 'event'), false); assert.equal(bad.destroyed, true);
  const asyncBad = new EventEmitter(); asyncBad.destroy = () => { asyncBad.destroyed = true; }; asyncBad.write = (_value, callback) => callback(new Error('closed'));
  writeStream(asyncBad, 'event'); assert.equal(asyncBad.destroyed, true);
  const slow = new EventEmitter(); slow.writableLength = 300000; slow.destroy = () => { slow.destroyed = true; }; slow.write = () => assert.fail('不能继续堆积');
  assert.equal(writeStream(slow, 'event'), false);
  const received = [], good = new EventEmitter(); good.write = value => received.push(value);
  assert.equal(writeStream(good, 'next'), true); assert.deepEqual(received, ['next']);
});

test('引擎检查区分未安装、未登录、未知协议与自定义模型，并且不返回账户资料', async () => {
  let starts = 0, account = { requiresOpenaiAuth: true, account: null }, fail;
  const client = { start: async () => { starts++; if (fail) throw fail; }, request: async method => { assert.equal(method, 'account/read'); return account; } };
  const check = createEngineReadiness({ getClient: () => client });
  assert.equal(check.current('codex-app-server').status, 'unknown');
  assert.equal((await check.check()).authentication, 'required');
  await check.check(); assert.equal(starts, 1);
  account = { requiresOpenaiAuth: true, account: { email: 'private@example.test', token: 'secret' } };
  const ready = await check.check(undefined, { force: true }); assert.equal(ready.status, 'ready'); assert.ok(!JSON.stringify(ready).includes('private'));
  account = {}; assert.equal((await check.check(undefined, { force: true })).status, 'unknown');
  fail = new Error('ENOENT'); assert.equal((await check.check(undefined, { force: true })).status, 'blocked'); fail = null;
  const custom = await check.check('custom', { execution: {} }); assert.equal(custom.authentication, 'custom-provider'); assert.equal(custom.modelConnectivity, 'unverified');
});

test('长会话轻量快照只同步变化运行，正文只在显式读取时返回有界预览', () => {
  const snapshots = createHistorySnapshots(), text = '报告'.repeat(100000);
  const runs = Array.from({ length: 50 }, (_, index) => ({ id: 'run-' + index, status: 'completed', updatedAt: 'now', messages: [{ text, phase: 'final_answer' }], progress: { steps: [] } }));
  const project = run => compactRun(run, { runId: run.id, status: run.status });
  const first = snapshots.project('scope', null, runs, {}, project);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 50000, '10 MB 原文不随摘要重传');
  assert.equal(first.runs.length, 50); assert.ok(first.runs.every(run => !run.messages.length));
  assert.ok(first.runs.every(run => run.transcriptAvailable === true && run.transcriptOmitted === true && run.transcriptTruncated === false));
  const unchanged = snapshots.project('scope', first.revision, runs, {}, project);
  assert.equal(unchanged.runs.length, 0); assert.equal(unchanged.revision, first.revision);
  runs[1].sequence = 2;
  assert.deepEqual(snapshots.project('scope', first.revision, runs, {}, project).runs.map(run => run.runId), ['run-1']);
  const detail = compactRun(runs[0], { runId: runs[0].id }, true);
  assert.equal(detail.transcriptOmitted, false);
  assert.ok(detail.messages[0].text.length <= 8000); assert.equal(detail.transcriptTruncated, true);
  assert.equal(runs[0].messages[0].text, text, '展示裁剪不能修改持久原文');
  assert.equal(snapshots.project('another-scope', first.revision, runs, {}, project).reset, true);
});

test('审批超时保存具体事务，失败与重启中断均有可重建通知', () => {
  const run = { id: 'run', agentId: 'worker', status: 'failed', context: { taskId: 'task' }, goal: '任务', events: [], createdAt: '2026-09-23', endedAt: '2026-09-24', error: '服务中断', interruption: 'service-restart' };
  const event = { type: 'approval_resolved', resolution: 'timeout', requestId: '1', time: '2026-09-24', approval: { params: { command: 'node --test example.cjs' } } };
  recordRunAlert(run, event); recordRunAlert(run, event);
  const notices = runAlertNotifications([[run]]);
  assert.equal(notices.length, 2); assert.match(notices[0].summary, /example.cjs/); assert.equal(notices[1].kind, 'interrupted');
  assert.equal(notices[1].runId, 'run');
  assert.equal(notices[1].summary, interruptionMessage(run));
  assert.doesNotMatch(notices[1].summary, /Codex app-server exited/);
});

test('未知进程异常先记录中断再刷盘关闭，不假装恢复正常，不重复退出', async () => {
  const events = [], processRef = new EventEmitter(); processRef.exit = code => events.push('exit:' + code);
  const lifecycle = installServiceLifecycle({ processRef, server: { close: () => events.push('close'), closeAllConnections: () => events.push('disconnect') },
    sessions: new Map(), runStore: { flush: () => events.push('flush'), close: () => events.push('store-close') }, beforeStop: reason => events.push(reason) });
  processRef.emit('unhandledRejection', new Error('test failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['service-error', 'flush', 'close', 'disconnect', 'exit:1']);
  await lifecycle.shutdown(); assert.equal(events.filter(item => item.startsWith('exit:')).length, 1);
});
