/* UI 回归夹具：调度、审批、历史接口走生产代码，供应商由内存假客户端代替。 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { route, runs, sessions, JsonRpcClient } = require('../agent-manager-server.cjs');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../outputs/example-team.json'), 'utf8'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ui-'));
config.teams[0].team.cwd = cwd;
const toolCalls = []; let serial = 0, diagnosticBlocked = false;
// 反馈回归可暂停自动答复，便于观察成员等待态；只存在于隔离夹具。
let releaseFeedback;
function install(agentId) {
  if (sessions.has(agentId)) return;
  const client = new JsonRpcClient(), replies = new Map(); let manager = false;
  client.start = async () => ({});
  client.child = { stdin: { writable: true, write: data => { const reply = JSON.parse(data); replies.get(reply.id)?.(reply.result); replies.delete(reply.id); } } };
  const notify = (threadId, turnId, method, extra) => client.emit({ type: 'notification', method, params: { threadId, turnId, ...extra } });
  const invoke = (threadId, turnId, tool, args = {}) => new Promise(resolve => {
    const id = ++serial; replies.set(id, resolve); toolCalls.push(tool);
    client.handleServerRequest({ id, method: 'item/tool/call', params: { threadId, turnId, callId: 'fixture-' + id, tool, arguments: args } });
  });
  const requestApproval = (threadId, turnId, params) => new Promise(resolve => {
    const id = ++serial; replies.set(id, resolve);
    client.handleServerRequest({ id, method: params.fixtureMethod || 'item/commandExecution/requestApproval', params: { threadId, turnId, ...params } });
  });
  const message = (threadId, turnId, phase, text) => {
    const item = { id: 'message-' + ++serial, type: 'agentMessage', phase, text };
    notify(threadId, turnId, 'item/started', { item: { ...item, text: '' } });
    notify(threadId, turnId, 'item/agentMessage/delta', { itemId: item.id, delta: text });
    notify(threadId, turnId, 'item/completed', { item });
  };
  client.request = async (method, params) => {
    if (method === 'windowsSandbox/readiness') return { status: 'ready' };
    if (method === 'command/exec') return { exitCode: 0, stderr: '', stdout: '' };
    if (method === 'thread/start') { manager = !!params.dynamicTools?.some(tool => tool.name === 'team_dispatch'); return { thread: { id: 'fixture-thread-' + agentId } }; }
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/interrupt') return {};
    if (method !== 'turn/start') throw new Error('Fixture rejects engine method ' + method);
    const turnId = 'fixture-turn-' + ++serial, threadId = params.threadId;
    setTimeout(async () => {
      try {
        if (manager) {
          const run = [...runs.values()].find(run => run.turnId === turnId);
          const workers = run.settings.management.members.filter(member => member.id !== agentId);
          message(threadId, turnId, 'commentary', '根据任务依赖安排开发与验证，先完成实现，再由测试验收。');
          for (const worker of (run.goal.includes('审批') ? workers : [workers[0], workers.at(-1)])) {
            install(worker.id);
            const result = await invoke(threadId, turnId, 'team_dispatch', { agentId: worker.id, instruction: '完成子任务并提供验证结果' });
            if (!result?.success) return;
            let pending = true;
            while (pending) {
              const result = await invoke(threadId, turnId, 'team_wait');
              if (!result?.success) return;
              const update = JSON.parse(result.contentItems[0].text);
              for (const question of update.feedbackRequests || []) {
                await new Promise(resolve => { releaseFeedback = resolve; });
                await invoke(threadId, turnId, 'team_reply_member', { requestId: question.requestId, answer: '保留旧接口字段，新增字段同时返回；补充兼容验证后继续交付。' });
              }
              pending = update.pending;
            }
          }
          await invoke(threadId, turnId, 'team_complete', { summary: '已完成实际派发和交付验收（隔离模拟）', artifacts: ['fixture.txt'], verification: ['模拟测试通过，未调用真实 Codex'] });
          message(threadId, turnId, 'final_answer', '文件已交付，开发与测试已验收。');
        } else {
          message(threadId, turnId, 'commentary', '正在检查工作目录，准备实现文件并运行验证。');
          if (params.input[0].text.includes('反馈')) {
            const response = await invoke(threadId, turnId, 'team_ask_manager', { question: '新接口是否需要兼容旧字段？', context: '已发现两处调用仍依赖旧格式，请确认兼容策略。' });
            if (!response?.success || JSON.parse(response.contentItems[0].text).status !== 'answered') return;
            message(threadId, turnId, 'commentary', '已收到经理的兼容约定，按答复继续实现并验证。');
          }
          if (params.input[0].text.includes('文件审批')) {
            const item = { id: 'file-' + ++serial, type: 'fileChange', changes: [{ path: path.join(params.cwd, 'fixture.txt'), kind: { type: 'add' }, diff: '+fixture artifact\n+中文文件审批验证' }] };
            notify(threadId, turnId, 'item/started', { item });
            const decision = await requestApproval(threadId, turnId, { fixtureMethod: 'item/fileChange/requestApproval', itemId: item.id, reason: '隔离回归：确认文件变更' });
            if (decision?.decision !== 'accept') { notify(threadId, turnId, 'turn/completed', { turn: { id: turnId, status: 'failed' } }); return; }
          } else if (params.input[0].text.includes('审批')) {
            const decision = await requestApproval(threadId, turnId, { command: 'node --test ./test/fixture.test.cjs', cwd: params.cwd, reason: '隔离回归：需要运行文件验证测试', additionalPermissions: { fileSystem: { read: [params.cwd] }, network: { enabled: false } } });
            if (decision?.decision !== 'accept') { notify(threadId, turnId, 'turn/completed', { turn: { id: turnId, status: 'failed', error: { message: '模拟请求未获允许' } } }); return; }
          }
          const step = { id: 'command-' + ++serial, type: 'commandExecution', command: 'node --test ./test/fixture.test.cjs' };
          notify(threadId, turnId, 'item/started', { item: step });
          fs.writeFileSync(path.join(params.cwd, 'fixture.txt'), 'fixture artifact');
          notify(threadId, turnId, 'item/completed', { item: { ...step, exitCode: 0, status: 'completed', aggregatedOutput: '隔离模拟测试通过' } });
          message(threadId, turnId, 'final_answer', '已完成 fixture.txt，文件验证通过（隔离模拟）。');
        }
        notify(threadId, turnId, 'turn/completed', { turn: { id: turnId, status: 'completed' } });
      } catch (error) { console.error(error); }
    }, manager ? 50 : 4000);
    return { turn: { id: turnId } };
  };
  sessions.set(agentId, { agentId, client });
}
const server = http.createServer(async (req, res) => {
  const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); };
  if (req.url === '/fixture/diagnostic-blocked' && req.method === 'POST') { diagnosticBlocked = true; return json({}); }
  if (req.url === '/fixture/reply' && req.method === 'POST') { releaseFeedback?.(); releaseFeedback = null; return json({ released: true }); }
  if (req.url.startsWith('/api/providers/codex-app-server/diagnostics')) return json({ provider: 'codex-app-server', status: diagnosticBlocked ? 'blocked' : 'ready', summary: diagnosticBlocked ? 'Windows 沙箱启动检查失败（隔离模拟）' : '沙箱已就绪（隔离模拟）', detail: diagnosticBlocked ? 'LookupAccountNameW 1788: CodexSandboxOffline（隔离模拟）' : '', repair: { available: true } });
  if (req.url === '/api/providers/codex-app-server/repair' && req.method === 'POST') { diagnosticBlocked = false; return json({ status: 'completed' }); }
  if (req.url === '/fixture/config') return json(config);
  if (req.url === '/fixture/state') return json({ calls: toolCalls, runs: [...runs.values()].map(run => ({ agentId: run.agentId, status: run.status, sandbox: run.settings.sandbox, threadId: run.threadId })) });
  if (req.url === '/api/codex/skills' || req.url === '/api/codex/mcp') return json([]);
  if (['/api/runs', '/api/tasks'].includes(req.url) && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); for (const member of input.members || [input]) install(member.agentId);
    // 生产路由继续从一个新的可读请求消费原始 JSON。
    const { Readable } = require('node:stream'); const replay = Readable.from([body]);
    replay.url = req.url; replay.method = req.method; replay.headers = req.headers;
    return route(replay, res);
  }
  return route(req, res);
});
server.listen(33212, '127.0.0.1', () => console.log('Team fixture: http://127.0.0.1:33212 (no real engine)'));
