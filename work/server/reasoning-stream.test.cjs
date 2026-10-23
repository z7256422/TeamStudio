const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { publicReasoningEvent } = require('./codex-reasoning.cjs');
const { projectReasoningSummaries } = require('../shared/run-reasoning.js');
const { jobFromRunEvent } = require('../shared/run-progress.js');
const { createRunStore } = require('./run-store.cjs');
const { emitRun, publicRun, JsonRpcClient, sessions, runs, startRun } = require('../agent-manager-server.cjs');
const time = '2026-09-22T10:00:00Z';
const summary = (stage, extra = {}) => ({ type: 'reasoning_summary', itemId: 'r1', stage, time, ...extra });
const provider = (method, params) => ({ type: 'provider_event', method, time, params });

test('公开摘要分片合并，完成快照不重复追加；重复/迟到增量不重启分析', () => {
  let job = jobFromRunEvent({}, summary('started', { runId: 'a', sequence: 1 }));
  job = jobFromRunEvent(job, summary('delta', { summaryIndex: 0, delta: '检查', sequence: 2 }));
  const before = job;
  job = jobFromRunEvent(job, summary('delta', { summaryIndex: 0, delta: '目录', sequence: 3 }));
  assert.equal(before.reasoningSummaries[0].parts[0], '检查', 'previous React snapshot must remain immutable');
  job = jobFromRunEvent(job, summary('delta', { summaryIndex: 1, delta: '验证接口', sequence: 4 }));
  const replay = jobFromRunEvent(job, summary('delta', { summaryIndex: 1, delta: '验证接口', sequence: 4 }));
  assert.deepEqual(replay, job);
  job = jobFromRunEvent(job, summary('completed', { summary: ['检查目录', '验证接口'], sequence: 5 }));
  assert.deepEqual(job.reasoningSummaries[0].parts, ['检查目录', '验证接口']);
  assert.equal(job.phase, 'waiting-engine');
  assert.deepEqual(jobFromRunEvent(job, summary('delta', { summaryIndex: 0, delta: '迟到', sequence: 6 })), job);
  const next = jobFromRunEvent(job, summary('started', { itemId: 'r2', sequence: 7 }));
  const late = jobFromRunEvent(next, summary('completed', { sequence: 8, summary: ['检查目录'] }));
  assert.equal(late.phase, 'thinking'); assert.equal(late.reasoningSummaries[1].status, 'streaming');
  assert.deepEqual(jobFromRunEvent(next, summary('delta', { runId: 'other', summaryIndex: 0, delta: '另一次执行' })), next);
});

test('工具/正文切换关闭分析，终态保留未完成摘要并防止迟到事件复活', () => {
  const streaming = jobFromRunEvent({}, summary('delta', { summaryIndex: 0, delta: '已收到摘要' }));
  for (const event of [{ type: 'message_delta', delta: '进展', time }, provider('item/started', { item: { id: 'cmd', type: 'commandExecution' } })]) {
    const executing = jobFromRunEvent(streaming, event);
    assert.equal(executing.reasoningSummaries[0].status, 'completed');
    assert.equal(jobFromRunEvent(executing, summary('completed', { summary: ['补全摘要'] })).phase, executing.phase, 'late summary snapshot must not override the current tool/reply phase');
  }
  for (const event of [{ type: 'error', message: 'failed', time }, { type: 'cancelled', time }, { type: 'completed', status: 'completed', time }]) {
    const finished = jobFromRunEvent(streaming, event);
    assert.equal(finished.reasoningSummaries[0].status, event.type === 'completed' ? 'completed' : 'interrupted');
    assert.equal(finished.reasoningSummaries[0].parts[0], '已收到摘要');
    assert.deepEqual(jobFromRunEvent(finished, summary('started', { itemId: 'late' })), finished);
  }
});

test('摘要投影约束非法输入和长任务体积，缺少摘要仍有阶段边界', () => {
  const entries = projectReasoningSummaries([], summary('started'));
  for (const index of [-1, 32, 1e9, 1.5, '__proto__']) assert.equal(projectReasoningSummaries(entries, summary('delta', { summaryIndex: index, delta: 'bad' })), entries);
  const empty = projectReasoningSummaries(entries, summary('completed', { summary: [] }));
  assert.equal(empty[0].status, 'completed'); assert.deepEqual(empty[0].parts, []);
  let many = [];
  for (let n = 0; n < 60; n++) many = projectReasoningSummaries(many, summary('delta', { itemId: 'r' + n, summaryIndex: 0, delta: '字'.repeat(30000) }));
  assert.ok(many.length <= 40); assert.ok(many.reduce((size, entry) => size + entry.parts.join('').length, 0) <= 120000);
  assert.ok(many.every(entry => entry.parts[0].length === 20000 && entry.truncated));
  assert.equal(many.at(-1).number, 60);
});

test('适配器仅输出公开摘要，SSE/详情/嵌套快照及持久化不包含原始推理', t => {
  const run = { id: 'privacy', agentId: 'a', createdAt: time, status: 'running', events: [], approvals: new Map(), subscribers: new Set() };
  const sent = []; run.subscribers.add({ write: text => sent.push(text) });
  emitRun(run, provider('item/reasoning/textDelta', { itemId: 'r1', delta: 'PRIVATE_RAW' }));
  emitRun(run, provider('codex/event/agent_reasoning', { message: 'PRIVATE_RAW' }));
  assert.equal(sent.length, 0);
  const item = { type: 'reasoning', id: 'r1', summary: ['公开摘要'], text: 'PRIVATE_RAW', content: ['PRIVATE_RAW'], encrypted_content: 'PRIVATE_RAW' };
  emitRun(run, provider('item/started', { item }));
  emitRun(run, provider('item/reasoning/summaryTextDelta', { itemId: 'r1', summaryIndex: 1, delta: '追加摘要' }));
  emitRun(run, { type: 'thread_started', thread: { turns: [{ items: [item] }] } });
  const view = publicRun(run, true);
  assert.equal(view.progress.reasoningSummaries[0].parts[1], '追加摘要');
  assert.equal(view.output, ''); assert.deepEqual(view.messages, []);
  assert.ok(!JSON.stringify({ sent, view, run: run.events }).includes('PRIVATE_RAW'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-store-'));
  const store = createRunStore(path.join(dir, 'runs.sqlite')); t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // 同时覆盖旧版本已保存的原始通知。
  run.events.push(provider('item/reasoning/textDelta', { delta: 'PRIVATE_RAW' }));
  assert.ok(!JSON.stringify(publicRun(run, true)).includes('PRIVATE_RAW'));
  store.save(run, true); const restored = store.load()[0];
  assert.equal(restored.status, 'cancelled'); assert.equal(restored.progress.reasoningSummaries[0].status, 'interrupted');
  assert.ok(!JSON.stringify(restored).includes('PRIVATE_RAW'));
  assert.equal(publicReasoningEvent(provider('item/reasoning/textDelta', {})), null);
});

test('真实适配入口接收 turn/start 前摘要，过滤其他线程/轮次，并向浏览器发送通用事件', async t => {
  const client = new JsonRpcClient(), sent = [];
  client.start = async () => ({});
  client.request = async method => {
    if (method === 'windowsSandbox/readiness') return { status: 'ready' };
    if (method === 'command/exec') return { exitCode: 0 };
    if (method === 'thread/start') return { thread: { id: 'test-thread' } };
    if (method === 'turn/start') {
      for (const [threadId, turnId, delta] of [['test-thread', 'test-turn', '正确摘要'], ['test-thread', 'old-turn', '旧轮次'], ['other-thread', 'test-turn', '其他线程']]) {
        client.emit({ type: 'notification', method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: 'r1', summaryIndex: 0, delta } });
      }
      return { turn: { id: 'test-turn' } };
    }
    throw new Error('Unexpected method: ' + method);
  };
  sessions.set('summary-agent', { agentId: 'summary-agent', client });
  t.after(() => { sessions.delete('summary-agent'); for (const [id, run] of runs) if (run.agentId === 'summary-agent') { run.detach?.(); runs.delete(id); } });
  const run = await startRun({ agentId: 'summary-agent', goal: '检查', cwd: os.tmpdir(), sandbox: 'danger-full-access' });
  assert.deepEqual(run.progress.reasoningSummaries[0].parts, ['正确摘要']);
  run.subscribers.add({ write: text => sent.push(text) });
  client.emit({ type: 'notification', method: 'item/reasoning/summaryTextDelta', params: { threadId: run.threadId, turnId: run.turnId, itemId: 'r1', summaryIndex: 0, delta: '完成' } });
  assert.ok(sent.some(text => text.includes('event: reasoning_summary')));
  client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed' } } });
  assert.equal(run.progress.reasoningSummaries[0].status, 'completed');
});
