const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { listDirectories } = require('./directories.cjs');
const { parseTaskContext, updateRunProjection, officeSnapshot, deleteRunHistory } = require('./run-metadata.cjs');
const { route, runs, sessions } = require('../agent-manager-server.cjs');
const fixture = (id, overrides = {}) => ({ id, agentId: 'dev', createdAt: '2026-09-20T00:00:00Z', status: 'running', approvals: new Map(), subscribers: new Set(), events: [], ...overrides });

test('目录浏览只列文件夹，支持中文空格、上级及默认目录，拒绝无效路径', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-office-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const child = path.join(folder, '中文 项目');
  await fs.mkdir(child); await fs.writeFile(path.join(folder, 'secret.txt'), 'not returned');
  const data = await listDirectories(null, folder);
  assert.deepEqual(data.directories, [{ name: '中文 项目', path: child }]);
  assert.equal(data.path, await fs.realpath(folder));
  assert.equal((await listDirectories(child, folder)).parent, data.path);
  assert.equal((await listDirectories(path.parse(folder).root, folder)).parent, null);
  for (const invalid of ['relative', 'bad\0path', 123, 'a'.repeat(401), path.join(folder, 'secret.txt')]) {
    await assert.rejects(listDirectories(invalid, folder), error => error.statusCode === 400);
  }
  await assert.rejects(listDirectories(path.join(folder, 'missing'), folder), error => error.statusCode === 404);
});

test('任务上下文保留发起人与接力链、过滤未知字段，兼容旧客户端', () => {
  const context = parseTaskContext({ taskId: 'task', taskTitle: '开发功能', source: { kind: 'agent', id: 'pm', name: '项目经理' }, handoffFrom: { agentId: 'fe', name: '前端', runId: 'r1' }, secret: 'discard' });
  assert.equal(context.source.name, '项目经理'); assert.equal(context.handoffFrom.runId, 'r1');
  assert.equal(context.secret, undefined); assert.equal(parseTaskContext(undefined), null);
  assert.throws(() => parseTaskContext({ source: { kind: 'fiction' } }));
  assert.throws(() => parseTaskContext({ source: { kind: 'user' }, agentName: 'x'.repeat(161) }));
});

test('办公室优先展示活动运行，按真实事件显示审批与失败，输出不重复存储', () => {
  const active = fixture('active');
  const finished = fixture('finished', { createdAt: '2026-09-20T01:00:00Z', status: 'completed' });
  const data = new Map([['active', active], ['finished', finished]]);
  updateRunProjection(active, { type: 'provider_event', method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution', command: 'npm test' } } });
  assert.equal(officeSnapshot(data).agents[0].currentStep, 'npm test');
  active.approvals.set('1', {});
  updateRunProjection(active, { type: 'message_delta', delta: 'text' });
  assert.equal(active.progress.output, undefined);
  assert.equal(officeSnapshot(data).agents[0].status, 'waiting');
  active.approvals.clear(); active.status = 'failed';
  updateRunProjection(active, { type: 'error', message: 'failed', time: '2026-09-20T00:02:00Z' });
  assert.equal(active.endedAt, '2026-09-20T00:02:00Z');
  assert.equal(officeSnapshot(data).agents[0].runId, 'finished');
});

test('删除整批先验证活动及审批，失败不会部分删除，只关闭对应订阅', () => {
  let closed = 0;
  const finished = fixture('done', { status: 'completed', subscribers: new Set([{ end: () => closed++ }]) });
  const active = fixture('active');
  const data = new Map([['done', finished], ['active', active]]);
  assert.throws(() => deleteRunHistory(data, ['done', 'active']), error => error.statusCode === 409);
  assert.equal(data.size, 2); assert.equal(closed, 0);
  finished.approvals.set('1', {});
  assert.throws(() => deleteRunHistory(data, ['done']), error => error.statusCode === 409);
  finished.approvals.clear();
  assert.deepEqual(deleteRunHistory(data, ['done']).deletedIds, ['done']);
  assert.equal(data.size, 1); assert.equal(closed, 1);
});

test('真实 HTTP 接口：目录读取、办公室、删除及跨来源保护，不调用执行引擎', async t => {
  const server = http.createServer(route);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); runs.clear(); sessions.clear(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  runs.set('done', fixture('done', { status: 'completed' }));
  runs.set('active', fixture('active', { agentId: 'active' }));
  sessions.set('dev', { threadId: 'preserve-session' });
  assert.equal((await fetch(base + '/api/office')).status, 200);
  assert.equal((await (await fetch(base + '/api/office')).json()).data.agents.length, 2);
  assert.equal((await fetch(base + '/api/filesystem/directories')).status, 200);
  assert.equal((await fetch(base + '/api/filesystem/directories', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(base + '/api/runs/done', { method: 'DELETE', headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(base + '/api/runs/active', { method: 'DELETE' })).status, 409);
  assert.equal((await fetch(base + '/api/runs', { method: 'DELETE' })).status, 400);
  const deleted = await fetch(base + '/api/runs?scope=finished', { method: 'DELETE', headers: { Origin: base } });
  assert.deepEqual((await deleted.json()).data.deletedIds, ['done']);
  assert.equal(runs.has('active'), true); assert.equal(sessions.get('dev').threadId, 'preserve-session');
  assert.equal((await fetch(base + '/api/runs/done')).status, 404);
});

test('办公室模型：树范围去重，新队列优先，已结束计时冻结，旧来源不虚构', async () => {
  const context = vm.createContext({});
  for (const file of ['../shared/run-progress.js', '../panel-src/office/model.js']) vm.runInContext(await fs.readFile(path.join(__dirname, file), 'utf8'), context);
  const teams = [{ id: 'root', team: { name: '主团队', children: ['child', 'child'] }, agents: [{ id: 'dev' }] }, { id: 'child', team: { name: '子团队', children: ['root'] }, agents: [] }];
  assert.equal(context.officeTeamScope(teams, 'root').size, 2);
  assert.equal(context.officeMembers(teams, null)[0].status, 'unknown');
  assert.equal(context.officeMembers(teams, { agents: [] })[0].status, 'idle');
  const remote = { agents: [{ agentId: 'dev', runId: 'old', status: 'done', context: { taskId: 'old' }, createdAt: '2026-09-20T00:00:00Z' }] };
  const jobs = { dev: { status: 'queued', context: { taskId: 'new', taskTitle: '新任务' }, createdAt: '2026-09-20T01:00:00Z' } };
  assert.equal(context.officeMembers(teams, remote, jobs)[0].status, 'queued');
  remote.agents[0].context.taskId = 'new'; remote.agents[0].status = 'waiting';
  assert.equal(context.officeMembers(teams, remote, jobs)[0].status, 'waiting');
  const ended = { startedAt: '2026-09-20T00:00:00Z', endedAt: '2026-09-20T00:01:15Z' };
  assert.equal(context.officeElapsed(ended, Date.now()), '1 分 15 秒');
  assert.equal(context.officeElapsed({}, Date.now()), '尚未开始');
  assert.equal(context.officeSourceLabel(null), '未记录来源');
});

test('办公室按任务过滤运行状态，新任务不会继承上一任务的已交付成员', () => {
  const old = fixture('old', { agentId: 'dev', status: 'completed', context: { taskId: 'old-task', source: { kind: 'user' }, agentName: '开发' } });
  const current = fixture('current', { agentId: 'dev', status: 'running', context: { taskId: 'current-task', source: { kind: 'user' }, agentName: '开发' } });
  const data = new Map([['old', old], ['current', current]]);
  assert.equal(officeSnapshot(data, 'old-task').agents[0].status, 'done');
  assert.equal(officeSnapshot(data, 'current-task').agents[0].status, 'running');
  assert.deepEqual(officeSnapshot(data, '__no_current_task__').agents, []);
});

test('办公室 HTTP 接口支持当前任务范围查询', async t => {
  const server = http.createServer(route);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); runs.clear(); sessions.clear(); });
  runs.set('old', fixture('old', { context: { taskId: 'old-task', source: { kind: 'user' } } }));
  runs.set('current', fixture('current', { context: { taskId: 'current-task', source: { kind: 'user' } } }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const scoped = await (await fetch(`${base}/api/office?scope=task&taskId=current-task`)).json();
  assert.deepEqual(scoped.data.agents.map(agent => agent.runId), ['current']);
  const empty = await (await fetch(`${base}/api/office?scope=task&taskId=__no_current_task__`)).json();
  assert.deepEqual(empty.data.agents, []);
});
