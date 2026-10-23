/* 独立端口的 UI 夹具：目录、状态、历史删除走生产路由，执行与能力接口隔离。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { route, runs, sessions, JsonRpcClient, emitRun, publicRun } = require('../agent-manager-server.cjs');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../outputs/example-team.json'), 'utf8'));
const main = config.teams[0];
const child = { id: 'design-team', team: { ...main.team, name: '体验设计团队', children: [] }, agents: [{ ...main.agents[1], id: 'designer', name: '交互设计师', role: 'Designer' }] };
main.team.children = [child.id]; config.teams.push(child);
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
function seed(agent, status, offset, extra = {}) {
  const run = { id: 'office-' + agent.id, agentId: agent.id, adapter: agent.provider, status, model: 'default', cwd: process.cwd(), threadId: 'fixture-session-' + agent.id, createdAt: iso(offset - 1000), startedAt: iso(offset), endedAt: status === 'completed' || status === 'failed' ? iso(offset + 90000) : null,
    context: { taskId: 'fixture-task', taskTitle: '实现项目工作台：目录选择、运行管理与团队办公室', teamId: main.id, teamName: main.team.name, memberTeamId: main.id, memberTeamName: main.team.name, agentName: agent.name, agentRole: agent.role, source: { kind: 'user', name: '本机用户' }, dispatchMode: 'parallel', ...extra },
    goal: '隔离 UI 回归任务', events: [], subscribers: new Set(), approvals: new Map(), output: '' };
  runs.set(run.id, run);
  emitRun(run, status === 'completed' ? { type: 'completed', status } : status === 'failed' ? { type: 'error', message: '测试用例未通过：需要检查空目录边界' } : { type: 'started' });
  return run;
}
seed(main.agents[0], 'completed', -250000);
const frontend = seed(main.agents[1], 'running', -180000, { handoffFrom: { agentId: main.agents[0].id, name: main.agents[0].name, runId: 'office-' + main.agents[0].id }, dispatchMode: 'sequential' });
emitRun(frontend, { type: 'provider_event', method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution', command: 'npm run build' } } });
const backend = seed(main.agents[2], 'running', -150000);
backend.approvals.set('fixture', {});
emitRun(backend, { type: 'approval_required', requestId: 'fixture' });
seed(main.agents[3], 'failed', -200000);
// 假客户端走真实续聊路由与事件处理器，测试上下文恢复但不启动 Codex。
let followupSerial = 0;
for (const agent of config.teams.flatMap(entry => entry.agents)) {
  const client = new JsonRpcClient(); client.start = async () => ({});
  client.request = async (method, params) => {
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/interrupt') { client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } }); return {}; }
    if (method !== 'turn/start') throw new Error('Fixture rejects engine method: ' + method);
    if (params.input[0].text.includes('[fail-start]')) throw new Error('Fixture: 无法启动后续轮次');
    const turnId = 'followup-' + ++followupSerial;
    const notify = (method, extra) => {
      if (![...runs.values()].some(run => run.turnId === turnId && run.status === 'running')) return;
      client.emit({ type: 'notification', method, params: { threadId: params.threadId, turnId, ...extra } });
    };
    setTimeout(() => notify('item/agentMessage/delta', { delta: '已接续原会话，正在根据上一轮结果修改。' }), 500);
    setTimeout(() => { notify('item/agentMessage/delta', { delta: '\n修改完成。本轮使用同一个会话和工作目录。' }); notify('turn/completed', { turn: { id: turnId, status: 'completed' } }); }, 4500);
    return { turn: { id: turnId } };
  };
  sessions.set(agent.id, { agentId: agent.id, client });
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ data })); };
let serial = 0, officeOffline = false;
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  // 以下分支覆盖一切可能触发真实引擎的接口，其他未声明写操作一律拒绝。
  if (pathname === '/fixture/config') return json(res, config);
  if (pathname === '/fixture/phase' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body);
    const run = runs.get('office-' + main.agents[1].id);
    run.progress.phase = input.phase; run.updatedAt = new Date().toISOString();
    return json(res, { phase: run.progress.phase });
  }
  if (pathname === '/fixture/offline' && req.method === 'POST') { officeOffline = !officeOffline; return json(res, { officeOffline }); }
  if (pathname === '/api/office' && officeOffline) return json(res, {}, 503);
  if (pathname === '/api/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, providers: [{ id: 'codex-app-server', status: 'available' }] })); }
  if (pathname === '/api/providers') return json(res, [{ id: 'codex-app-server', status: 'available' }]);
  if (['/api/codex/skills', '/api/codex/mcp', '/api/approvals', '/api/sessions'].includes(pathname)) return json(res, []);
  if (pathname === '/api/runs' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body), id = `ui-dispatch-${++serial}`;
    const run = { ...input, id, status: 'running', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), events: [], subscribers: new Set(), approvals: new Map(), output: '' };
    runs.set(id, run); emitRun(run, { type: 'started' }); json(res, publicRun(run));
    setTimeout(() => { emitRun(run, { type: 'message_delta', delta: '隔离任务已完成，未调用真实 Codex。' }); run.status = 'completed'; emitRun(run, { type: 'completed', status: 'completed' }); }, 1500);
    return;
  }
  if (req.method === 'POST') {
    if (/^\/api\/runs\/[^/]+\/(continue|cancel)$/.test(pathname)) return route(req, res);
    if (pathname === '/api/messages') return json(res, {}); return json(res, {}, 405);
  }
  return route(req, res);
});
server.listen(33211, '127.0.0.1', () => console.log('Office fixture: http://127.0.0.1:33211 (no real engine)'));
