const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceEvents, workspaceResourceChanged } = require('./workspace-events.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(request, target) {
  const sources = [];
  class Source {
    constructor(url) { this.url = url; this.listeners = {}; sources.push(this); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    send(type, data) { this.listeners[type]?.({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  return { hub: new WorkspaceEvents({ request, Source, target }), sources };
}
test('共享连接与同路径请求，空闲一小时没有自动查询，重连补快照', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0; const first = [], second = [];
  const { hub, sources } = fixture(async () => ({ value: ++calls }));
  const stop1 = hub.watch('/api/approvals', { onData: data => first.push(data) });
  const stop2 = hub.watch('/api/approvals', { onData: data => second.push(data) });
  await flush(); assert.equal(calls, 1); assert.equal(sources.length, 1);
  t.mock.timers.tick(3600000); await flush(); assert.equal(calls, 1);
  sources[0].send('change', { topics: ['messages'] }); await flush(); assert.equal(calls, 1);
  sources[0].send('change', { topics: ['approvals'] }); await flush(); assert.equal(calls, 2);
  sources[0].send('ready', {}); await flush(); assert.equal(calls, 3);
  assert.deepEqual(first, second);
  stop1(); assert.equal(sources[0].closed, undefined);
  stop2(); assert.equal(sources[0].closed, true); assert.equal(hub.resources.size, 0);
});
test('慢请求期间变化合并且最后状态不丢，切换后取消请求并丢弃迟到数据', async () => {
  const requests = [], data = [];
  const { hub, sources } = fixture((route, options) => new Promise(resolve => requests.push({ resolve, signal: options.signal })));
  const stop = hub.watch('/api/approvals', { onData: value => data.push(value) });
  for (let i = 0; i < 10; i++) sources[0].send('change', { topics: ['approvals'] });
  assert.equal(requests.length, 1);
  requests[0].resolve('initial'); await flush(); assert.equal(requests.length, 2);
  requests[1].resolve('latest'); await flush(); assert.deepEqual(data, ['initial', 'latest']);
  sources[0].send('change', { topics: ['approvals'] });
  stop(); assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve('old'); await flush(); assert.equal(data.length, 2);
});
test('读取失败不盲目重试，下一次事件或重连才恢复', async () => {
  let calls = 0; const errors = [], data = [];
  const { hub, sources } = fixture(async () => { if (++calls === 1) throw new Error('offline'); return 'ok'; });
  const stop = hub.watch('/api/notifications', { onData: value => data.push(value), onError: error => errors.push(error.message) });
  await flush(); assert.deepEqual(errors, ['offline']); assert.equal(calls, 1);
  sources[0].onerror(); assert.match(errors.at(-1), /等待自动重连/);
  sources[0].send('ready', {}); await flush(); assert.deepEqual(data, ['ok']); stop();
});
test('任务/会话定向更新覆盖续聊新运行，删除通知刷新已有视图', () => {
  const event = { topics: ['runs'], runs: [{ runId: 'new', taskId: 'task', conversationKey: 'conversation' }] };
  assert.equal(workspaceResourceChanged('/api/runs/old/conversation', event, { summary: { conversationKey: 'conversation' } }), true);
  assert.equal(workspaceResourceChanged('/api/runs/old/execution', event, { conversationKey: 'other' }), false);
  assert.equal(workspaceResourceChanged('/api/runs/old', event), false);
  assert.equal(workspaceResourceChanged('/api/office?scope=task&taskId=task', event), true);
  assert.equal(workspaceResourceChanged('/api/office?scope=task&taskId=another', event), false);
  assert.equal(workspaceResourceChanged('/api/runs/old', { topics: ['runs', 'deleted'] }), true);
});

test('SSE 未断开但快照因离线失败时，网络恢复事件补取最终结果', async () => {
  let calls = 0; const target = new EventTarget(), data = [];
  const { hub } = fixture(async () => { if (++calls === 1) throw new Error('offline'); return 'completed'; }, target);
  const stop = hub.watch('/api/conversations', { onData: value => data.push(value) });
  await flush(); target.dispatchEvent(new Event('online')); await flush();
  assert.deepEqual(data, ['completed']); assert.equal(calls, 2);
  stop(); target.dispatchEvent(new Event('online')); await flush(); assert.equal(calls, 2);
});

for (const endpoint of ['conversation', 'execution']) test(`${endpoint} 轻量增量带版本，只替换变更运行，重置快照删除旧运行`, async () => {
  const routes = [], data = [];
  const { hub, sources } = fixture(async route => {
    routes.push(route);
    if (routes.length === 1) return { revision: 'v1', reset: true, runOrder: ['a', 'b'], runs: [{ runId: 'a', status: 'completed' }, { runId: 'b', status: 'running' }] };
    if (routes.length === 2) return { revision: 'v2', reset: false, runOrder: ['a', 'b'], runs: [{ runId: 'b', status: 'completed' }] };
    return { revision: 'v3', reset: true, runOrder: ['b'], runs: [{ runId: 'b', status: 'completed' }] };
  });
  const stop = hub.watch(`/api/runs/a/${endpoint}?view=compact`, { onData: value => data.push(value) });
  await flush(); sources[0].send('change', { topics: ['runs'], runs: [{ runId: 'a' }] }); await flush();
  assert.ok(routes[1].endsWith('&since=v1')); assert.equal(data[1].runs[0], data[0].runs[0]); assert.equal(data[1].runs[1].status, 'completed');
  sources[0].send('ready', {}); await flush(); assert.deepEqual(data[2].runs.map(run => run.runId), ['b']); stop();
});
