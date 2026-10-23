/* 真实 Codex + 本地模拟模型：验证三级调度、双向反馈、原线程返工；不使用用户付费 API。 */
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { customProviders, startRun, continueRun, cancelRun, sessions, runs, route } = require('../agent-manager-server.cjs');
const { conversationRounds, deliveryNotifications } = require('../server/conversation-rounds.cjs');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'company-engine-'));
const steps = { director: 0, lead: 0, engineer: 0 }, calls = [];
let serial = 0;
const tool = (name, args) => ({ type: 'function_call', id: 'fc_' + ++serial, call_id: 'call_' + serial, name, arguments: JSON.stringify(args), status: 'completed' });
const message = text => ({ type: 'message', id: 'msg_' + ++serial, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
function findQuestion(value, memberId) {
  if (typeof value === 'string') { try { return findQuestion(JSON.parse(value), memberId); } catch { return null; } }
  if (!value || typeof value !== 'object') return null;
  if (value.memberId === memberId && value.requestId && value.status === 'pending') return value.requestId;
  for (const child of Object.values(value)) { const found = findQuestion(child, memberId); if (found) return found; }
  return null;
}
function send(res, item) {
  const response = { id: 'response_' + ++serial, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    ...(item.type === 'message' ? [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text }] : []),
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
  events.forEach(event => res.write('data: ' + JSON.stringify(event) + '\n\n')); res.end();
}
const mock = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer company-fixture-key');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text), role = body.model;
    assert.ok(Object.hasOwn(steps, role));
    const flatten = tools => tools.flatMap(value => value.type === 'namespace' ? flatten(value.tools || []) : [value.name]);
    const names = flatten(body.tools || []);
    if (role === 'lead') assert.ok(names.includes('team_dispatch') && names.includes('team_ask_manager'));
    if (role === 'engineer') assert.ok(names.includes('team_ask_manager') && !names.includes('team_dispatch'));
    let item;
    if (role === 'director') {
      const step = steps[role]++ % 6;
      if (step === 0) item = tool('team_dispatch', { agentId: 'lead', instruction: 'Review the software interface and return an evidence-based report.' });
      if (step === 1 || step === 3) item = tool('team_wait', {});
      if (step === 2) { const requestId = findQuestion([...body.input].reverse(), 'lead'); assert.ok(requestId); item = tool('team_reply_member', { requestId, answer: 'Keep compatibility with the previous protocol version.' }); }
      if (step === 4) item = tool('team_complete', { summary: 'Product interface review complete.', artifacts: [], verification: ['Department report checked; compatibility decision recorded.'] });
      if (step === 5) item = message('产品接口评审完成，部门反馈已逐级解决。');
    } else if (role === 'lead') {
      const step = steps[role]++ % 7;
      if (step === 0) item = tool('team_dispatch', { agentId: 'engineer', instruction: 'Review the protocol compatibility requirements and report.' });
      if (step === 1 || step === 4) item = tool('team_wait', {});
      if (step === 2) item = tool('team_ask_manager', { question: 'Should the product support the previous protocol?', context: 'An engineer needs a cross-team compatibility decision.' });
      if (step === 3) { const requestId = findQuestion([...body.input].reverse(), 'engineer'); assert.ok(requestId); item = tool('team_reply_member', { requestId, answer: 'The director confirmed backward compatibility.' }); }
      if (step === 5) item = tool('team_complete', { summary: 'Software interface reviewed.', artifacts: [], verification: ['Engineer report checked against the director decision.'] });
      if (step === 6) item = message('软件部门评审完成，已将产品兼容决定回复工程师并核验报告。');
    } else {
      const step = steps[role]++ % 2;
      item = step === 0 ? tool('team_ask_manager', { question: 'Which protocol version should remain compatible?', context: 'Reviewing the assigned interface.' }) : message('协议兼容评审完成，按负责人回复保留旧版支持；未执行实物验证。');
    }
    calls.push({ role, tool: item.name || 'final' }); send(res, item);
  } catch (error) { console.error('Mock: ' + error.message); res.writeHead(500); res.end('fixture assertion failed'); }
});
async function finished(run) {
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); run.subscribers.delete(observer); };
    const check = () => {
      if (run.approvals.size) { cleanup(); reject(new Error('Unexpected approval')); }
      else if (['completed', 'failed', 'cancelled'].includes(run.status)) { cleanup(); resolve(); }
    };
    const observer = { write: () => queueMicrotask(check) };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Hierarchy smoke exceeded 60 seconds')); }, 60000);
    run.subscribers.add(observer); check();
  });
  if (run.status !== 'completed') console.error(JSON.stringify([...runs.values()].map(value => ({ agent: value.agentId, status: value.status, error: value.error, delivery: value.delivery?.status }))));
  assert.equal(run.status, 'completed', run.error || run.output);
}
async function main() {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const provider = customProviders.save({ label: 'Company mock', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'company-fixture-key', defaultModel: 'director', reasoningEffort: 'low' });
  const members = ['director', 'lead', 'engineer'].map(id => ({ id, name: { director: '总项目经理', lead: '软件负责人', engineer: '协议工程师' }[id], model: id, provider: provider.id, role: id === 'engineer' ? 'Engineer' : 'ProjectManager' }));
  try {
    const first = await startRun({ agentId: 'director', adapter: provider.id, cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', goal: 'Review the product interface and provide an audit report.',
      management: { concurrency: 1, rootTeamId: 'company', members, teams: [
        { id: 'company', name: '研发管理', leaderId: 'director', memberIds: ['director'], children: ['software'], concurrency: 1 },
        { id: 'software', name: '软件开发', leaderId: 'lead', memberIds: ['lead', 'engineer'], children: [], concurrency: 1 }
      ] }, context: { taskId: 'company-native-smoke', roundId: 'first', agentName: '总项目经理', agentRole: 'ProjectManager', coordinatorAgentId: 'director', dispatchMode: 'manager', source: { kind: 'user' } } });
    await finished(first);
    const firstRuns = [...runs.values()]; assert.equal(firstRuns.length, 3);
    assert.ok(firstRuns.every(run => run.status === 'completed' && (run.feedback || []).every(item => item.status === 'answered')));
    assert.equal(firstRuns[2].context.coordinatorRunId, firstRuns[1].id);
    const next = await continueRun(first.id, { goal: 'Review the interface again and report.' }); await finished(next);
    const nextRuns = [...runs.values()].slice(3); assert.equal(nextRuns.length, 3);
    nextRuns.forEach((run, i) => assert.equal(run.threadId, firstRuns[i].threadId));
    assert.equal(conversationRounds([...runs.values()]).length, 2);
    assert.equal(deliveryNotifications([[...runs.values()]]).length, 2);
    assert.deepEqual(fs.readdirSync(cwd), []);
    console.log('PASS: native Codex, director → department leader → engineer, scoped tools, two-level feedback, event wakeups, single conversation, resumed threads. Model responses=' + calls.length);
    if (process.argv.includes('--ui')) {
      const server = http.createServer(async (req, res) => {
        if (req.url === '/fixture/config') { res.setHeader('content-type', 'application/json'); return res.end(fs.readFileSync(path.join(__dirname, '../../outputs/product-company.json'))); }
        if (req.url === '/fixture/legacy') { res.setHeader('content-type', 'application/json'); return res.end(fs.readFileSync(path.join(__dirname, '../../outputs/example-team.json'))); }
        if (['/api/codex/skills', '/api/codex/mcp'].includes(req.url)) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [] })); }
        if (req.method === 'POST') { res.writeHead(405); return res.end('UI fixture is read-only'); }
        return route(req, res);
      });
      server.listen(33216, '127.0.0.1', () => console.log('Company UI fixture: http://127.0.0.1:33216'));
      const close = () => { server.closeAllConnections(); server.close(); };
      process.on('SIGINT', close); process.on('SIGTERM', close);
    }
  } finally {
    for (const run of runs.values()) if (!['completed', 'failed', 'cancelled'].includes(run.status)) await cancelRun(run).catch(error => console.error(error.message));
    for (const session of sessions.values()) session.client.child?.stdin.end();
    mock.closeAllConnections(); mock.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
