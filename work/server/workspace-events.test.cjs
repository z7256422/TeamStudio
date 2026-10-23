const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorkspaceEvents } = require('./workspace-events.cjs');
function response() {
  const res = new EventEmitter(); res.chunks = []; res.writeHead = () => {};
  res.write = value => res.chunks.push(value);
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return res;
}
test('连接即同步，变更批量推送，空闲只发保活，最后客户端关闭后释放计时器', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = createWorkspaceEvents(), res = response();
  hub.publish(['runs']); hub.attach(res);
  assert.match(res.chunks[0], /event: ready/);
  for (let i = 0; i < 30; i++) hub.publish(['runs'], { runId: 'r', taskId: 't' });
  hub.publish(['approvals']); t.mock.timers.tick(250);
  assert.equal(res.chunks.length, 2);
  const event = JSON.parse(res.chunks[1].split('data: ')[1]);
  assert.deepEqual(event.topics, ['runs', 'approvals']); assert.equal(event.runs.length, 1);
  t.mock.timers.tick(15000); assert.match(res.chunks.at(-1), /heartbeat/);
  assert.equal(res.chunks.filter(value => value.includes('event: change')).length, 1);
  hub.publish(['runs']); res.destroy(); const count = res.chunks.length;
  t.mock.timers.tick(60000); assert.equal(res.chunks.length, count);
  const next = response(); hub.attach(next); assert.match(next.chunks[0], /event: ready/); next.destroy();
});
test('背压超过限制断开慢客户端，避免无限积压', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const hub = createWorkspaceEvents(), res = response(); hub.attach(res);
  res.writableLength = 300000; hub.publish(['runs']); t.mock.timers.tick(250);
  assert.equal(res.destroyed, true);
});

test('真实路由推送运行变化及删除范围，重连无需丢失期间的日志即可恢复', async t => {
  const http = require('node:http');
  const { route, emitRun, runs } = require('../agent-manager-server.cjs');
  const server = http.createServer(route);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const abort = new AbortController();
  const stream = await fetch(base + '/api/events', { signal: abort.signal });
  const reader = stream.body.getReader();
  t.after(async () => { abort.abort(); await reader.cancel().catch(() => {}); runs.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const read = async () => Buffer.from((await reader.read()).value).toString();
  assert.match(await read(), /event: ready/);
  const run = { id: 'event-run', agentId: 'worker', status: 'completed', createdAt: new Date().toISOString(),
    events: [], subscribers: new Set(), approvals: new Map(), context: { taskId: 'event-task' } };
  runs.set(run.id, run); emitRun(run, { type: 'completed', status: 'completed' });
  const update = JSON.parse((await read()).split('data: ')[1]);
  assert.ok(update.topics.includes('history')); assert.ok(update.topics.includes('notifications'));
  assert.deepEqual(update.runs[0], { runId: run.id, taskId: 'event-task', conversationKey: '["task","event-task"]' });
  const deletion = await fetch(base + '/api/runs/event-run', { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  assert.ok(JSON.parse((await read()).split('data: ')[1]).topics.includes('deleted'));
});
