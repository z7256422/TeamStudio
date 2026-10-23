const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { JsonRpcClient, emitRun, attachClient, publicRun, startRun, sessions, runs, findApproval } = require('./agent-manager-server.cjs');

test('JSON-RPC 超时释放 pending，正常响应清理计时器', async () => {
  const client = new JsonRpcClient(15), writes = [];
  client.child = { stdin: { writable: true, write: data => writes.push(JSON.parse(data)) } };
  await assert.rejects(client.request('turn/start', {}), /timed out/);
  assert.equal(client.pending.size, 0);
  const next = client.request('thread/start', {});
  client.consume(JSON.stringify({ id: writes.at(-1).id, result: { ok: true } }) + '\n');
  assert.deepEqual(await next, { ok: true }); assert.equal(client.pending.size, 0);
  client.sendNotification('initialized');
  assert.equal(writes.at(-1).method, 'initialized'); assert.equal(writes.at(-1).id, undefined);
});

test('挂起工具不受审批期限影响，审批自身仍有一次性截止', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new JsonRpcClient(), writes = [];
  client.child = { stdin: { writable: true, write: data => writes.push(JSON.parse(data)) } };
  client.handleServerRequest({ id: 1, method: 'item/tool/call', params: { tool: 'team_wait' } });
  client.handleServerRequest({ id: 2, method: 'item/tool/call', params: { tool: 'team_ask_manager' } });
  client.handleServerRequest({ id: 3, method: 'item/commandExecution/requestApproval', params: {} });
  t.mock.timers.tick(60 * 60 * 1000);
  assert.deepEqual([...client.serverRequests.keys()], ['1', '2']);
  assert.equal(writes[0].id, 3); assert.match(writes[0].error.message, /timed out/);
  client.respondServerRequest('1', { success: true }); client.respondServerRequest('2', { success: true });
  assert.equal(client.serverRequests.size, 0);
});

test('SSE 断线重连只重放 Last-Event-ID 之后的事件，详情保留文本', () => {
  const run = { id: 'r1', agentId: 'a', events: [], subscribers: new Set(), approvals: new Map() };
  emitRun(run, { type: 'message_delta', delta: '你' }); emitRun(run, { type: 'message_delta', delta: '好' });
  const res = new EventEmitter(); const chunks = [];
  res.writeHead = () => {}; res.write = data => chunks.push(data);
  attachClient(run, res, 1); res.emit('close');
  assert.ok(!chunks.join('').includes('id: 1\n')); assert.match(chunks.join(''), /id: 2/);
  assert.equal(publicRun(run, true).output, '你好'); assert.equal(run.subscribers.size, 0);
});

test('运行终态不在回放窗口时，连接快照仍给出权威状态', () => {
  const run = { id: 'ended', status: 'failed', error: 'engine stopped', events: [], subscribers: new Set() };
  const res = new EventEmitter(), chunks = [];
  res.writeHead = () => {}; res.write = data => chunks.push(data);
  attachClient(run, res, 999); res.emit('close');
  assert.match(chunks.join(''), /event: snapshot/);
  assert.match(chunks.join(''), /"status":"failed"/);
  assert.match(chunks.join(''), /engine stopped/);
});

test('不同 Agent 的同号审批必须用 runId 区分', () => {
  sessions.clear(); runs.clear();
  for (const n of [1, 2]) {
    const client = { serverRequests: new Map([['1', { requestId: '1' }]]) };
    sessions.set('a' + n, { client });
    runs.set('r' + n, { id: 'r' + n, client, approvals: new Map([['1', {}]]) });
  }
  assert.throws(() => findApproval('1'), /ambiguous/);
  assert.equal(findApproval('1', 'r2').run.id, 'r2');
  sessions.clear(); runs.clear();
});

test('Codex 不再重试的错误结束运行，重试事件保留运行', async () => {
  const client = new JsonRpcClient();
  client.start = async () => ({});
  client.request = async method => method === 'thread/start' ? { thread: { id: 'thread-test' } } : { turn: { id: 'turn-test' } };
  sessions.set('test', { agentId: 'test', client });
  const run = await startRun({ agentId: 'test', goal: 'fixture only', cwd: process.cwd() });
  client.emit({ type: 'notification', method: 'turn/started', params: { threadId: 'thread-test', turn: { id: 'turn-test' } } });
  client.emit({ type: 'notification', method: 'error', params: { threadId: 'thread-test', error: { message: 'retry' }, willRetry: true } });
  assert.equal(run.status, 'running');
  client.emit({ type: 'notification', method: 'error', params: { threadId: 'thread-test', error: { message: 'fatal' }, willRetry: false } });
  assert.equal(run.status, 'failed'); assert.equal(run.error, 'fatal'); assert.equal(client.listeners.size, 0);
  sessions.clear(); runs.clear();
});
