const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { JsonRpcClient, sessions, runs, startRun, continueRun, route } = require('../agent-manager-server.cjs');
const { continuationInput, conversationRuns, groupedConversations } = require('./conversations.cjs');
const { createRunStore } = require('./run-store.cjs');
const original = (id = 'old', overrides = {}) => ({ id, agentId: 'dev', threadId: 'original-thread', adapter: 'codex-app-server', cwd: process.cwd(), goal: 'first', status: 'completed', createdAt: '2026-09-20T01:00:00Z', events: [], approvals: new Map(), subscribers: new Set(), output: 'first answer', ...overrides });
function setup(t) {
  runs.clear(); sessions.clear();
  t.after(() => { runs.clear(); sessions.clear(); });
  const calls = [], client = new JsonRpcClient();
  client.start = async () => ({});
  client.request = async (method, params) => {
    if (method === 'windowsSandbox/readiness') return { status: 'ready' };
    if (method === 'command/exec') return { exitCode: 0, stdout: '', stderr: '' };
    calls.push({ method, params });
    if (method === 'thread/resume' || method === 'thread/start') return { thread: { id: params.threadId || 'new-thread' } };
    return { turn: { id: 'new-turn' } };
  };
  sessions.set('dev', { agentId: 'dev', threadId: 'another-later-thread', client });
  return { client, calls };
}
test('历史续聊恢复选中 thread，保留目录、模型与指令，不依赖成员最近会话', async t => {
  const { calls, client } = setup(t);
  const first = original('old', { context: { teamId: 'original-team', teamName: '原团队', agentName: '原成员', source: { kind: 'user', name: '本机用户' } }, settings: { model: 'chosen-model', developerInstructions: 'original role', approvalPolicy: 'on-request' } });
  runs.set(first.id, first);
  const next = await continueRun('old', { goal: 'fix the previous result', threadId: 'must-not-use', cwd: os.tmpdir() });
  assert.equal(calls[0].method, 'thread/resume');
  assert.equal(calls[0].params.threadId, first.threadId);
  assert.ok(calls[0].params.developerInstructions.startsWith('original role'));
  assert.equal(next.settings.developerInstructions, 'original role');
  assert.equal(calls[1].params.model, 'chosen-model');
  assert.equal(calls[1].params.cwd, first.cwd);
  assert.equal(next.parentRunId, first.id); assert.equal(next.status, 'running');
  assert.equal(next.context.dispatchMode, 'continuation');
  assert.equal(next.context.teamId, 'original-team'); assert.equal(next.context.agentName, '原成员');
  assert.equal(next.goal, 'fix the previous result');
  client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: first.threadId, turn: { id: 'new-turn', status: 'completed' } } });
  assert.equal(next.status, 'completed');
});
test('旧记录缺少参数快照时保留 Codex 会话配置，连续两次续聊不创建新 thread', async t => {
  const { client, calls } = setup(t); runs.set('old', original());
  const next = await continueRun('old', { goal: 'second' });
  assert.equal(Object.hasOwn(calls[0].params, 'developerInstructions'), false);
  assert.equal(Object.hasOwn(calls[1].params, 'approvalPolicy'), false);
  client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: next.threadId, turn: { id: 'new-turn', status: 'completed' } } });
  const third = await continueRun(next.id, { goal: 'third' });
  assert.equal(third.threadId, 'original-thread'); assert.equal(third.parentRunId, next.id);
  assert.ok(calls.every(call => call.method !== 'thread/start'));
  assert.equal(conversationRuns(runs, third).length, 3);
});
test('并发重复提交被拒绝，运行中成员和无会话记录不能续聊', async t => {
  const { client } = setup(t); runs.set('old', original());
  let resolveStart; client.start = () => new Promise(resolve => { resolveStart = resolve; });
  const first = continueRun('old', { goal: 'second' });
  await assert.rejects(continueRun('old', { goal: 'duplicate' }), error => error.statusCode === 409);
  await assert.rejects(startRun({ agentId: 'dev', goal: 'different task' }), error => error.statusCode === 409);
  resolveStart({}); await first;
  assert.throws(() => continuationInput(new Map(), original('empty', { threadId: null }), 'text'), error => error.statusCode === 409);
  assert.throws(() => continuationInput(new Map(), original(), '   '), error => error.statusCode === 400);
  assert.throws(() => continuationInput(new Map(), original('waiting', { approvals: new Map([['1', {}]]) }), 'text'), error => error.statusCode === 409);
});
test('turn/start 响应前的事件仍完整接收，旧轮次的迟到输出不能串入新轮次', async t => {
  const { client } = setup(t); runs.set('old', original());
  client.request = async (method, params) => {
    if (method === 'windowsSandbox/readiness') return { status: 'ready' };
    if (method === 'command/exec') return { exitCode: 0, stdout: '', stderr: '' };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    client.emit({ type: 'notification', method: 'item/agentMessage/delta', params: { threadId: 'original-thread', turnId: 'old-turn', delta: 'wrong' } });
    client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: 'original-thread', turn: { id: 'old-turn', status: 'completed' } } });
    client.emit({ type: 'notification', method: 'turn/started', params: { threadId: 'original-thread', turn: { id: 'new-turn' } } });
    client.emit({ type: 'notification', method: 'item/agentMessage/delta', params: { threadId: 'original-thread', turnId: 'new-turn', delta: 'correct' } });
    client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: 'original-thread', turn: { id: 'new-turn', status: 'completed' } } });
    return { turn: { id: 'new-turn' } };
  };
  const next = await continueRun('old', { goal: 'second' });
  assert.equal(next.output, 'correct'); assert.equal(next.status, 'completed'); assert.equal(client.listeners.size, 0);
});
test('引擎缺少轮次标识时明确失败，释放成员席位且不反复回放早到事件', async t => {
  const { client } = setup(t); runs.set('old', original());
  client.request = async (method, params) => {
    if (method === 'windowsSandbox/readiness') return { status: 'ready' };
    if (method === 'command/exec') return { exitCode: 0, stdout: '', stderr: '' };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    client.emit({ type: 'notification', method: 'turn/started', params: { threadId: 'original-thread', turn: { id: 'early' } } });
    return {};
  };
  await assert.rejects(continueRun('old', { goal: 'second' }), /轮次标识/);
  assert.equal([...runs.values()].at(-1).status, 'failed'); assert.equal(client.listeners.size, 0);
});

test('历史会话 HTTP 接口返回真实多轮及可续聊状态', async t => {
  const { client } = setup(t); runs.set('old', original());
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/runs/old`;
  const post = await fetch(url + '/continue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'second' }) });
  assert.equal(post.status, 202); const next = (await post.json()).data;
  let conversation = (await (await fetch(url + '/conversation')).json()).data;
  assert.equal(conversation.runs.length, 2); assert.equal(conversation.canContinue, false);
  assert.equal(conversation.runs[0].output, 'first answer');
  client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: next.threadId, turn: { id: 'new-turn', status: 'completed' } } });
  conversation = (await (await fetch(url + '/conversation')).json()).data;
  assert.equal(conversation.canContinue, true);
});

test('会话连接期间停止，完成连接后不再派发 turn，也不传空轮次进行中断', async t => {
  const { client, calls } = setup(t); runs.set('old', original());
  let release; client.start = () => new Promise(resolve => { release = resolve; });
  const pending = continueRun('old', { goal: 'stop during startup' });
  const active = [...runs.values()].at(-1);
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runs/${active.id}/cancel`, { method: 'POST' });
  assert.equal(response.status, 202); assert.equal(active.progress.status, 'stopping');
  release({}); const stopped = await pending;
  assert.equal(stopped.status, 'cancelled'); assert.equal(calls.length, 0); assert.equal(client.listeners.size, 0);
});

test('启动响应尚未返回时停止，拿到轮次后才中断；中断失败仍跟踪实际运行', async t => {
  const { client, calls } = setup(t); runs.set('old', original());
  let release, arrived; const turnRequested = new Promise(resolve => { arrived = resolve; });
  client.request = async (method, params) => {
    if (method === 'windowsSandbox/readiness') return { status: 'ready' };
    if (method === 'command/exec') return { exitCode: 0, stdout: '', stderr: '' };
    calls.push({ method, params });
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') { arrived(); return new Promise(resolve => { release = resolve; }); }
    if (method === 'turn/interrupt') throw new Error('interrupt timeout');
  };
  const pending = continueRun('old', { goal: 'stop before turn response' }); await turnRequested;
  const active = [...runs.values()].at(-1);
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await fetch(`http://127.0.0.1:${server.address().port}/api/runs/${active.id}/cancel`, { method: 'POST' });
  assert.ok(calls.every(call => call.method !== 'turn/interrupt'));
  release({ turn: { id: 'accepted-turn' } }); const running = await pending;
  assert.equal(calls.at(-1).params.turnId, 'accepted-turn'); assert.equal(running.status, 'running');
  assert.match(running.progress.activity, /停止失败/); assert.equal(running.cancelRequested, false);
  client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: running.threadId, turn: { id: 'accepted-turn', status: 'completed' } } });
  assert.equal(running.status, 'completed');
});
test('持久记录可跨进程恢复对话、继承参数和删除结果；活动记录明确标记中断', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-conversation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runs.sqlite'); let store = createRunStore(file);
  const first = original('old', { settings: { developerInstructions: 'saved prompt' } });
  store.save(first, true); store.save(original('active', { status: 'running' }), true); store.close();
  store = createRunStore(file);
  const loaded = store.load();
  assert.equal(loaded[0].output, 'first answer'); assert.equal(loaded[0].settings.developerInstructions, 'saved prompt');
  assert.equal(loaded[1].status, 'cancelled'); assert.match(loaded[1].error, /重启/); assert.equal(loaded[1].approvals.size, 0);
  const input = continuationInput(new Map(), loaded[0], 'continue after restart');
  assert.equal(input.threadId, 'original-thread');
  store.remove(['old']); store.close(); store = createRunStore(file);
  assert.deepEqual(store.load().map(run => run.id), ['active']); store.close();
});
test('办公室姿态忠实对应公开事件，审批优先于无事件提示，终态不再敲键盘', () => {
  const context = vm.createContext({});
  for (const file of ['../shared/run-progress.js','../panel-src/office/model.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),context);
  const now = Date.now(), scene = (status, phase, time = now) => context.officeScene({ status, run: { status, phase, updatedAt: time } }, now).pose;
  assert.equal(scene('running','thinking'),'thinking'); assert.equal(scene('running','commandExecution'),'coding');
  assert.equal(scene('running','webSearch'),'reading'); assert.equal(scene('running','fileChange'),'building');
  assert.equal(scene('running','writing'),'writing'); assert.equal(scene('running','commandExecution',now-60000),'quiet');
  assert.equal(scene('waiting','commandExecution',now-60000),'approval'); assert.equal(scene('done','commandExecution'),'celebrate');
  assert.equal(scene('failed','writing'),'failed'); assert.equal(scene('idle',''),'coffee');
});

test('历史目录先按会话合并再截取，多次续聊只更新轮数与状态，不挤掉其他会话', async t => {
  setup(t);
  runs.set('old', original());
  runs.set('other', original('other', { threadId: 'another-thread', createdAt: '2026-09-20T00:00:00Z' }));
  for (let i = 0; i < 105; i++) runs.set('round-' + i, original('round-' + i, { goal: 'followup ' + i, createdAt: new Date(Date.parse('2026-09-20T02:00:00Z') + i * 1000).toISOString(), status: i === 104 ? 'running' : 'completed' }));
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = (await (await fetch(base + '/api/conversations')).json()).data;
  assert.equal(list.length, 2); assert.equal(list[0].runId, 'old'); assert.equal(list[0].goal, 'first');
  assert.equal(list[0].turnCount, 106); assert.equal(list[0].status, 'running'); assert.equal(list[0].canDelete, false);
  const detail = (await (await fetch(base + '/api/runs/round-60/conversation')).json()).data;
  assert.equal(detail.summary.runId, 'old'); assert.equal(detail.total, 106); assert.equal(detail.runs.length, 50);
  assert.equal(detail.summary.conversationKey, list[0].conversationKey);
  // 相同 thread 文本在另一供应商中，以及没有 thread 的失败记录，都必须独立。
  runs.set('adapter', original('adapter', { adapter: 'another-provider' }));
  runs.set('no-thread-a', original('no-thread-a', { threadId: null }));
  runs.set('no-thread-b', original('no-thread-b', { threadId: null }));
  assert.equal((await (await fetch(base + '/api/conversations')).json()).data.length, 5);
});

test('整会话删除与清空保护活动及审批中的所有轮次，结束后从任一轮可完整删除', async t => {
  setup(t);
  runs.set('old', original());
  runs.set('next', original('next', { status: 'running', createdAt: '2026-09-20T02:00:00Z' }));
  runs.set('ended', original('ended', { threadId: 'ended-thread' }));
  runs.set('approval-root', original('approval-root', { threadId: 'approval-thread' }));
  runs.set('approval', original('approval', { threadId: 'approval-thread', approvals: new Map([['request', { requestId: 'request', params: {} }]]) }));
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/runs/old/conversation', { method: 'DELETE' })).status, 409);
  assert.equal(runs.size, 5);
  assert.equal((await fetch(base + '/api/conversations?scope=finished', { method: 'DELETE', headers: { Origin: 'https://example.com' } })).status, 403);
  const deleted = (await (await fetch(base + '/api/conversations?scope=finished', { method: 'DELETE' })).json()).data;
  assert.deepEqual(deleted.deletedIds, ['ended']); assert.equal(deleted.deletedConversations, 1); assert.equal(runs.size, 4);
  runs.get('next').status = 'completed';
  const removed = (await (await fetch(base + '/api/runs/next/conversation', { method: 'DELETE' })).json()).data;
  assert.deepEqual(removed.deletedIds, ['old', 'next']); assert.equal(runs.size, 2);
  assert.equal((await fetch(base + '/api/runs/next/conversation')).status, 404);
});

test('历史成员恢复时办公室显示只读工位，真实活动不会被旧页面状态覆盖', () => {
  const context = vm.createContext({});
  for (const file of ['../shared/run-progress.js', '../panel-src/office/model.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  const teams = [{ id: 'other', team: { name: '当前团队', children: [] }, agents: [] }];
  const snapshot = { agents: [{ agentId: 'dev', status: 'running', phase: 'writing', runId: 'resumed', context: { teamId: 'original', teamName: '原团队', taskId: 'old', agentName: '原成员' }, createdAt: '2026-09-20T00:00:00Z' }] };
  const roster = context.officeTeams(teams, snapshot);
  assert.equal(teams.length, 1); assert.equal(roster.length, 2); assert.equal(roster[1].agents[0].name, '原成员');
  const members = context.officeMembers(roster, snapshot, { dev: { status: 'done', context: { taskId: 'new' }, createdAt: '2026-09-20T01:00:00Z' } });
  assert.equal(members[0].status, 'running'); assert.equal(members[0].run.runId, 'resumed');
});


test('同一任务的项目经理与成员运行合并为一个会话，并以项目经理作为续聊入口', async t => {
  setup(t);
  const taskContext = { taskId: 'task-batch', taskTitle: '实现功能', teamId: 'team', teamName: '团队', coordinatorAgentId: 'pm', coordinatorAgentName: '项目经理', source: { kind: 'user', name: '本机用户' }, dispatchMode: 'manager' };
  runs.set('pm', original('pm', { agentId: 'pm', threadId: 'pm-thread', context: { ...taskContext, agentName: '项目经理', agentRole: 'ProjectManager' }, createdAt: '2026-09-20T01:00:00Z' }));
  runs.set('fe', original('fe', { agentId: 'fe', adapter: 'another-provider', threadId: 'fe-thread', context: { ...taskContext, agentName: '前端工程师', agentRole: 'FrontendEngineer' }, createdAt: '2026-09-20T01:01:00Z' }));
  assert.equal(groupedConversations(runs).length, 1);
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runs/fe/conversation`);
  assert.equal(response.status, 200);
  const detail = (await response.json()).data;
  assert.equal(detail.summary.runId, 'pm');
  assert.equal(detail.summary.continuationRunId, 'pm');
  assert.deepEqual(detail.summary.runIds, ['pm', 'fe']);
  assert.equal(detail.total, 2);
});
