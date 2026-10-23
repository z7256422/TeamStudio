/* 仅供本地 UI 回归：所有 API 都由内存夹具响应，绝不连接真实 Codex。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const runs = [], subscribers = new Map();
let sequence = 0;
const json = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })); };
function emit(run, event) {
  const entry = { ...event, runId: run.runId, agentId: run.agentId, sequence: ++sequence, time: new Date().toISOString() };
  run.events.push(entry); run.updatedAt = entry.time;
  if (entry.type === 'message_delta') run.output += entry.delta;
  for (const res of subscribers.get(run.runId) || []) res.write(`id: ${entry.sequence}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`);
}
const server = http.createServer(async (req, res) => {
  const route = req.url.split('?')[0];
  let body = ''; for await (const chunk of req) body += chunk;
  const input = body ? JSON.parse(body) : {};
  if (route === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, '../../outputs/agent-manager.html'))); }
  if (route === '/api/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, providers: [{ id: 'codex-app-server', status: 'available' }] })); }
  if (route === '/api/messages/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': connected\n\n'); }
  if (route === '/api/approvals') return json(res, runs.flatMap(run => run.approvals));
  if (route === '/api/runs' && req.method === 'GET') return json(res, [...runs].reverse());
  if (route === '/api/runs' && req.method === 'POST') {
    const run = { ...input, runId: `fixture-${runs.length + 1}`, status: 'running', createdAt: new Date().toISOString(), output: '', events: [], approvals: [] };
    run.eventsUrl = `/api/runs/${run.runId}/events`; runs.push(run); json(res, run);
    setTimeout(() => {
      emit(run, { type: 'started' });
      emit(run, { type: 'provider_event', method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution', command: 'Get-ChildItem C:/demo' } } });
      emit(run, { type: 'provider_event', method: 'item/completed', params: { item: { id: 'cmd', type: 'commandExecution', exitCode: 1, status: 'failed', aggregatedOutput: 'Fixture: sandbox unavailable' } } });
      if (run.goal.includes('失败')) {
        run.status = 'failed'; run.error = 'Fixture: provider authentication failed';
        emit(run, { type: 'error', message: run.error }); return;
      }
      const approval = { requestId: '1', runId: run.runId, agentId: run.agentId, method: 'item/commandExecution/requestApproval', params: { command: 'Get-ChildItem C:/demo', reason: 'Fixture: 验证审批状态展示' } };
      run.approvals.push(approval); emit(run, { type: 'approval_required', ...approval });
    }, 250);
    return;
  }
  const match = route.match(/^\/api\/runs\/([^/]+)(\/events|\/cancel)?$/);
  if (match) {
    const run = runs.find(entry => entry.runId === match[1]);
    if (!run) { res.writeHead(404); return res.end('{}'); }
    if (match[2] === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n');
      for (const entry of run.events) if (entry.sequence > Number(req.headers['last-event-id'] || 0)) res.write(`id: ${entry.sequence}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`);
      if (!subscribers.has(run.runId)) subscribers.set(run.runId, new Set());
      subscribers.get(run.runId).add(res); res.on('close', () => subscribers.get(run.runId).delete(res)); return;
    }
    if (match[2] === '/cancel') { run.status = 'cancelled'; run.approvals = []; emit(run, { type: 'cancelled', status: 'cancelled' }); }
    return json(res, run);
  }
  if (route.startsWith('/api/approvals/') && req.method === 'POST') {
    const run = runs.find(entry => entry.runId === input.runId); run.approvals = [];
    emit(run, { type: 'approval_resolved', requestId: '1', resolution: input.decision });
    emit(run, { type: 'message_delta', delta: '隔离回归完成：没有启动真实 Codex。' });
    run.status = 'completed'; emit(run, { type: 'completed', status: 'completed' }); return json(res, {});
  }
  return json(res, []);
});
server.listen(33210, '127.0.0.1', () => console.log('Fixture only: http://127.0.0.1:33210'));
