const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

function harness(fetch) {
  const sources = [], timers = new Map();
  class EventSource {
    constructor() { this.listeners = {}; this.closed = false; sources.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    close() { this.closed = true; }
    send(type, payload, sequence = 1) {
      const event = { data: JSON.stringify({ type, ...payload }), lastEventId: String(sequence) };
      this.listeners[type]?.(event);
      if (type === 'error') this.onerror?.(event);
    }
  }
  let counter = 0;
  const context = vm.createContext({ window: { location: { protocol: 'http:' } }, fetch, EventSource, AbortSignal, AbortController, URL,
    setInterval: callback => { timers.set(++counter, callback); return counter; }, clearInterval: id => timers.delete(id) });
  for (const file of ['workspace-events.js', 'control-plane.js', '../../shared/run-progress.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  return { context, sources, timers, runtime: vm.runInContext('new ControlPlaneRuntime()', context) };
}
const response = data => ({ ok: true, json: async () => ({ data }) });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('分析结束更新活动时间并等待下一步，不保留过时分析状态或覆盖审批', () => {
  const { context } = harness();
  const event = { type: 'provider_event', method: 'item/completed', time: '2026-09-20T05:20:02Z', params: { item: { id: 'analysis', type: 'reasoning' } } };
  const job = context.jobFromRunEvent({ status: 'running', activity: '正在分析任务', updatedAt: 1000 }, event);
  assert.equal(job.activity, '分析阶段已结束，等待引擎下一步');
  assert.equal(job.updatedAt, Date.parse(event.time));
  const waiting = context.jobFromRunEvent({ pendingApprovals: ['r1:1'], status: 'waiting' }, event);
  assert.equal(waiting.status, 'waiting');
});

test('无新事件提示兼容服务端时间与本地时间，不误报排队或已结束任务', () => {
  const { context } = harness(); const check = context.runInactivity;
  const updatedAt = '2026-09-20T05:20:02Z', now = Date.parse(updatedAt) + 210000;
  for (const time of [updatedAt, Date.parse(updatedAt)]) {
    const result = check({ status: 'running', updatedAt: time }, now);
    assert.equal(result.duration, '3 分 30 秒');
    assert.match(result.message, /无法判断卡死/);
  }
  for (const status of ['queued','done','failed','cancelled','idle']) assert.equal(check({ status, updatedAt }, now), null);
  assert.equal(check({ status: 'running', updatedAt }, Date.parse(updatedAt) + 29000), null);
  assert.equal(check({ status: 'running', updatedAt: 'invalid' }, now), null);
  assert.match(check({ status: 'waiting', updatedAt }, now).message, /审批/);
  assert.match(check({ status: 'reconnecting', updatedAt }, now).message, /连接/);
});

test('工具调用可见，命令失败与任务失败分开，终止错误保留原因', () => {
  const { context } = harness();
  const apply = context.jobFromRunEvent;
  let job = apply({}, { type: 'submitted' });
  assert.equal(job.status, 'starting');
  job = apply(job, { type: 'provider_event', method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution', command: 'Get-ChildItem' } } });
  job = apply(job, { type: 'tool_output', itemId: 'cmd', delta: 'access denied' });
  job = apply(job, { type: 'provider_event', method: 'item/completed', params: { item: { id: 'cmd', type: 'commandExecution', exitCode: 1, status: 'failed' } } });
  assert.equal(job.steps[0].status, 'failed');
  assert.equal(job.steps[0].detail, 'Get-ChildItem');
  assert.equal(job.steps[0].output, 'access denied');
  assert.equal(job.status, 'running');
  job = apply(job, { type: 'completed', status: 'failed', turn: { error: { message: 'sandbox unavailable' } } });
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'sandbox unavailable');
});

test('审批等待不被普通输出覆盖，多会话重复审批编号分别处理', () => {
  const { context } = harness(); const apply = context.jobFromRunEvent;
  let job = apply({}, { type: 'approval_required', runId: 'r1', requestId: '1' });
  job = apply(job, { type: 'message_delta', delta: '等待授权' });
  assert.equal(job.status, 'waiting');
  assert.notEqual(context.approvalKey({ runId: 'r1', requestId: '1' }), context.approvalKey({ runId: 'r2', requestId: '1' }));
  job = apply(job, { type: 'approval_resolved', runId: 'r1', requestId: '1', resolution: 'timeout' });
  assert.equal(job.status, 'running');
  assert.match(job.activity, /超时/);
});

test('引擎重试显示重试状态，成功完成后清除等待和错误', () => {
  const { context } = harness(); const apply = context.jobFromRunEvent;
  let job = apply({}, { type: 'provider_event', method: 'error', params: { error: { message: 'network timeout' }, willRetry: true } });
  assert.equal(job.status, 'retrying');
  assert.match(job.activity, /network timeout/);
  job = apply(job, { type: 'completed', status: 'completed' });
  assert.equal(job.status, 'done'); assert.equal(job.error, '');
});

test('启动响应尚未返回时点停止，拿到 runId 后仍中断后端', async () => {
  let resolveStart; const calls = [], events = [];
  const { runtime, sources } = harness(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/runs') return new Promise(resolve => { resolveStart = resolve; });
    assert.equal(url, '/api/runs/r1/cancel'); return response({ status: 'cancelled' });
  });
  const handle = runtime.startRun({ agents: [{ id: 'a' }], goal: 'test' }, event => events.push(event));
  const stopped = handle.cancel();
  resolveStart(response({ runId: 'r1', eventsUrl: '/api/runs/r1/events' }));
  await stopped;
  assert.equal(calls.length, 2); assert.equal(sources.length, 0);
  assert.equal(events.at(-1).type, 'cancelled');
  await handle.cancel(); assert.equal(calls.length, 2);
});

test('SSE error 业务事件只结束一次，不覆盖为断线错误', async () => {
  const events = [];
  const { runtime, sources, timers } = harness(async () => response({ runId: 'r1', eventsUrl: '/events' }));
  runtime.startRun({ agents: [{ id: 'a' }], goal: 'test' }, event => events.push(event));
  await flush(); sources[0].send('error', { message: 'engine failed' });
  sources[0].send('completed', { status: 'completed' }, 2);
  assert.equal(events.filter(e => e.type === 'error').length, 1);
  assert.equal(events.at(-1).message, 'engine failed');
  assert.equal(sources[0].closed, true); assert.equal(timers.size, 0);
});

test('临时断线不完成任务，重连去重，由连接快照收敛漏掉的终态且无轮询', async () => {
  const events = [];
  const { runtime, sources, timers } = harness(() => assert.fail('等待期间不应查询状态'));
  runtime.watchRun({ runId: 'r1', eventsUrl: '/events' }, event => events.push(event));
  sources[0].send('message_delta', { delta: '你好' });
  sources[0].onerror({}); sources[0].onopen();
  sources[0].send('message_delta', { delta: '你好' });
  assert.equal(events.filter(e => e.type === 'message_delta').length, 1);
  assert.ok(events.some(e => e.type === 'connection_lost'));
  assert.ok(!events.some(e => e.type === 'error'));
  assert.equal(timers.size, 0);
  sources[0].send('snapshot', { status: 'completed' });
  assert.equal(events.at(-1).status, 'completed'); assert.equal(timers.size, 0);
});

test('公开进展与最终回复分开，未知阶段中性显示，迟到输出不重开运行', () => {
  const { context } = harness(), apply = context.jobFromRunEvent;
  let job = apply({}, { type: 'provider_event', method: 'item/started', params: { item: { id: 'm1', type: 'agentMessage', phase: 'commentary' } } });
  job = apply(job, { type: 'message_delta', itemId: 'm1', delta: '公开内容' }); assert.equal(job.phase, 'reporting');
  job = apply(job, { type: 'message_delta', itemId: 'unknown', delta: '内容' }); assert.equal(job.phase, 'replying');
  job = apply(job, { type: 'provider_event', method: 'item/started', params: { item: { id: 'm2', type: 'agentMessage', phase: 'final_answer' } } });
  job = apply(job, { type: 'message_delta', itemId: 'm2', delta: '公开内容' }); assert.equal(job.phase, 'writing');
  job = apply(job, { type: 'completed', status: 'completed' });
  job = apply(job, { type: 'message_delta', itemId: 'm2', delta: 'late' }); assert.equal(job.status, 'done');
});

test('受控等待不误报卡顿，连续 team_wait 合并且保留等待次数', () => {
  const { context } = harness(), apply = context.jobFromRunEvent;
  assert.equal(context.runInactivity({ status: 'running', phase: 'coordinating', updatedAt: 1000 }, 121000), null);
  let job = {};
  for (const id of ['wait-1', 'wait-2']) {
    job = apply(job, { type: 'provider_event', method: 'item/started', params: { item: { id, type: 'dynamicToolCall', tool: 'team_wait' } } });
    job = apply(job, { type: 'provider_event', method: 'item/completed', params: { item: { id, type: 'dynamicToolCall', tool: 'team_wait', status: 'completed' } } });
  }
  assert.equal(job.steps.length, 1); assert.equal(job.steps[0].waitCount, 2);
});
