/* 摘要交互夹具：仅内存数据和生产 SSE，不启动引擎或修改真实历史。 */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { route, runs, emitRun } = require('../agent-manager-server.cjs');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../outputs/example-team.json'), 'utf8'));
const agent = config.teams[0].agents[0];
let run = { id: 'reasoning-preview', agentId: agent.id, adapter: 'codex-app-server', threadId: 'reasoning-thread', turnId: 'reasoning-turn',
  cwd: process.cwd(), model: 'default', goal: '验证流式思考摘要展示', createdAt: new Date().toISOString(), status: 'running',
  settings: { sandbox: 'danger-full-access' }, context: { taskId: 'reasoning-preview-task', taskTitle: '验证流式思考摘要展示', agentName: agent.name,
    agentRole: agent.role, teamId: config.teams[0].id, teamName: config.teams[0].team.name, roundId: 'reasoning-preview-round', dispatchMode: 'current', source: { kind: 'user' } },
  events: [], approvals: new Map(), subscribers: new Set() };
runs.set(run.id, run);
let segment = 0, execution = 1;
const begin = () => {
  segment++;
  emitRun(run, { type: 'provider_event', method: 'item/started', params: { item: { id: 'analysis-' + segment, type: 'reasoning', summary: [] } } });
};
const delta = text => emitRun(run, { type: 'provider_event', method: 'item/reasoning/summaryTextDelta', params: { itemId: 'analysis-' + segment, summaryIndex: 0, delta: text } });
emitRun(run, { type: 'started' }); begin(); delta('先检查接口与事件订阅，确认摘要能够按成员分开显示。');
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ data })); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/fixture/config') return json(res, config);
  if (url.pathname === '/api/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, providers: [{ id: 'codex-app-server', kind: 'codex', label: '本机 Codex', status: 'available' }] })); }
  if (['/api/codex/skills', '/api/codex/mcp'].includes(url.pathname)) return json(res, []);
  if (url.pathname === '/fixture/update' && req.method === 'POST') {
    const action = url.searchParams.get('action');
    if (action === 'delta') delta('\n摘要实时追加：接下来验证完成后保持展开和历史恢复。');
    else if (action === 'long') delta('\n' + '流式摘要的长段落与窄屏换行验证。'.repeat(600));
    else if (action === 'begin') begin();
    else if (action === 'complete') emitRun(run, { type: 'provider_event', method: 'item/completed', params: { item: { id: 'analysis-' + segment, type: 'reasoning', summary: [] } } });
    else if (action === 'tool') emitRun(run, { type: 'provider_event', method: 'item/started', params: { item: { id: 'command-' + segment, type: 'commandExecution', command: 'node --version' } } });
    else if (action === 'tool-complete') emitRun(run, { type: 'provider_event', method: 'item/completed', params: { item: { id: 'command-' + segment, type: 'commandExecution', command: 'node --version', exitCode: 0, aggregatedOutput: 'v24.15.0' } } });
    else if (action === 'reply') emitRun(run, { type: 'provider_event', method: 'item/completed', params: { item: { id: 'reply-' + segment, type: 'agentMessage', phase: 'final_answer', text: '本次补充回复已完成，之前的操作保留在上一次执行中。' } } });
    else if (['finish', 'fail', 'cancel'].includes(action)) { run.status = action === 'finish' ? 'completed' : action === 'cancel' ? 'cancelled' : 'failed'; emitRun(run, { type: 'completed', status: run.status, message: action === 'fail' ? '夹具模拟执行失败' : '' }); }
    else if (action === 'reassign') {
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) return json(res, { error: '请先结束本次执行' }, 409);
      // 新分工创建独立记录；不覆盖第一次的摘要、操作、消息或界面状态。
      const { progress, messages, output, endedAt, updatedAt, sequence, ...previous } = run;
      run = { ...previous, id: 'reasoning-preview-' + (++execution), parentRunId: previous.id, createdAt: new Date().toISOString(), startedAt: null,
        status: 'running', events: [], approvals: new Map(), subscribers: new Set() };
      runs.set(run.id, run); segment = 0; emitRun(run, { type: 'started' }); begin(); delta('沿用上下文，只补充上一份答复，不需要再次执行命令。');
    }
    else return json(res, { error: 'unknown action' }, 400);
    return json(res, {});
  }
  if (req.method === 'POST') return json(res, { error: '夹具禁止启动真实任务' }, 405);
  return route(req, res);
});
server.listen(33215, '127.0.0.1', () => console.log('Reasoning fixture: http://127.0.0.1:33215'));
