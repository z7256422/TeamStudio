/* 真实 Codex + 本机模拟 Responses；不调用付费模型，只在临时目录验证协作协议。 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { customProviders, startRun, continueRun, cancelRun, sessions, runs, route } = require('../agent-manager-server.cjs');
const { testProvider } = require('../server/custom-providers.cjs');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-model-engine-'));
const managerId = 'custom-smoke-manager', memberId = 'custom-smoke-worker';
let managerStep = 0, workerStep = 0, serial = 0, toolNames = [], requestCount = 0;
let managerEffort = 'low';
let replyOnly = false;
const keys = { manager: 'smoke-only-manager-key', worker: 'smoke-only-worker-key' };
const call = (name, args) => ({ type: 'function_call', id: 'fc_' + ++serial, call_id: 'call_' + serial, name, arguments: JSON.stringify(args), status: 'completed' });
const message = text => ({ type: 'message', id: 'msg_' + ++serial, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
function findRequest(value) {
  if (typeof value === 'string') { try { return findRequest(JSON.parse(value)); } catch { return null; } }
  if (!value || typeof value !== 'object') return null;
  if (value.requestId && value.question && value.status === 'pending') return value.requestId;
  for (const child of Object.values(value)) { const found = findRequest(child); if (found) return found; }
  return null;
}
function send(res, item) {
  const summaryText = 'Fixture summary: check the next team action.';
  const reasoning = { type: 'reasoning', id: 'rs_' + ++serial, summary: [{ type: 'summary_text', text: summaryText }] };
  const response = { id: 'resp_' + ++serial, object: 'response', status: 'completed', output: [reasoning, item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } },
    { type: 'response.reasoning_summary_part.added', item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    ...[summaryText.slice(0, 17), summaryText.slice(17)].map(delta => ({ type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, output_index: 0, summary_index: 0, delta })),
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item },
    ...(item.type === 'message' ? [{ type: 'response.output_text.delta', item_id: item.id, output_index: 1, content_index: 0, delta: item.content[0].text }] : []),
    { type: 'response.output_item.done', output_index: 1, item }, { type: 'response.completed', response }];
  for (const event of events) res.write('data: ' + JSON.stringify(event) + '\n\n');
  res.end();
}
const mock = http.createServer(async (req, res) => {
  try {
    const role = req.url.startsWith('/worker/') ? 'worker' : 'manager';
    assert.equal(req.headers.authorization, `Bearer ${keys[role]}`);
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requestCount++;
    assert.equal(body.reasoning?.effort, role === 'worker' ? 'high' : managerEffort, 'explicit reasoning effort must reach the upstream API');
    if (body.tools?.some(tool => tool.name === 'connection_probe')) return send(res, call('connection_probe', { value: 'ok' }));
    assert.equal(body.model, role === 'worker' ? 'worker-model' : 'manager-model');
    // 普通问答直接返回无 phase 消息，验证真实引擎的消息边界与自动完成。
    if (replyOnly) { assert.equal(role, 'manager'); return send(res, message('你好，我可以回答问题，也可以按需安排团队执行任务。')); }
    const flatten = tools => tools.flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools || []) : [tool.name]).filter(Boolean);
    toolNames = [...new Set([...toolNames, ...flatten(body.tools || [])])];
    let item;
    if (role === 'manager') {
      const step = managerStep++ % 6;
      if (step === 0) item = call('team_dispatch', { agentId: memberId, instruction: 'Ask for the report format, inspect the directory, then report.' });
      if (step === 1 || step === 3) item = call('team_wait', {});
      if (step === 2) {
        const requestId = findRequest([...body.input].reverse());
        assert.ok(requestId, 'manager must receive the member question');
        item = call('team_reply_member', { requestId, answer: 'Return a concise audit report with the inspected directory.' });
      }
      if (step === 4) item = call('team_complete', { summary: 'Audit completed with member feedback.', artifacts: [], verification: ['Member question answered; directory inspected.'] });
      if (step === 5) item = message('Audit delivered. Member feedback was resolved.');
    } else {
      const step = workerStep++ % 3;
      if (step === 0) item = call('team_ask_manager', { question: 'Which format should the audit use?', context: 'Ready to inspect the isolated directory.' });
      if (step === 1) {
        const tool = flatten(body.tools || []).find(name => ['exec_command', 'shell_command'].includes(name));
        assert.ok(tool, 'native command tool remains available');
        item = call(tool, tool === 'exec_command' ? { cmd: 'Get-Location', workdir: cwd } : { command: 'Get-Location', workdir: cwd });
      }
      if (step === 2) item = message('Audit complete. Directory inspected after manager reply.');
    }
    send(res, item);
  } catch (error) { console.error(error.message); res.writeHead(500); res.end('fixture assertion failed'); }
});
async function finished(run, expectMember = true) {
  await new Promise((resolve, reject) => {
    const observer = { write: () => queueMicrotask(check) };
    const cleanup = () => { clearTimeout(timer); run.subscribers.delete(observer); };
    const check = () => {
      if (run.approvals.size) { cleanup(); reject(new Error('Unexpected approval in isolated smoke')); }
      else if (['completed', 'failed', 'cancelled'].includes(run.status)) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Custom engine smoke exceeded 60 seconds')); }, 60000);
    run.subscribers.add(observer); check();
  });
  assert.equal(run.status, 'completed', run.error || run.output);
  if (expectMember) assert.equal(run.feedback?.[0]?.status, 'answered');
  return [...runs.values()].find(child => child.context?.coordinatorRunId === run.id);
}
async function main() {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  const manager = customProviders.save({ label: 'Mock manager', baseUrl: baseUrl + '/manager/v1', apiKey: keys.manager, defaultModel: 'manager-model', reasoningEffort: managerEffort });
  const worker = customProviders.save({ label: 'Mock worker', baseUrl: baseUrl + '/worker/v1', apiKey: keys.worker, defaultModel: 'worker-model', reasoningEffort: 'high' });
  if (process.argv.includes('--ui')) {
    const server = http.createServer(route); server.listen(33213, '127.0.0.1', () => console.log('UI fixture http://127.0.0.1:33213 · mock API ' + baseUrl + '/manager/v1'));
    const close = () => { server.closeAllConnections(); server.close(); mock.closeAllConnections(); mock.close(); for (const session of sessions.values()) session.client.child?.stdin.end(); };
    process.on('SIGINT', close); process.on('SIGTERM', close);
    return;
  }
  try {
    await testProvider(customProviders.candidate({ ...manager, apiKey: '' }, manager.id));
    await testProvider(customProviders.candidate({ ...worker, apiKey: '' }, worker.id));
    const members = [{ id: managerId, name: 'Manager', role: 'ProjectManager', provider: manager.id }, { id: memberId, name: 'Worker', role: 'Engineer', provider: worker.id }];
    const first = await startRun({ agentId: managerId, adapter: manager.id, cwd, sandbox: 'danger-full-access', approvalPolicy: 'never', goal: 'Review code and provide an audit report only; do not change files.',
      management: { members, concurrency: 1 }, context: { taskId: 'custom-engine-task', agentName: 'Manager', agentRole: 'ProjectManager', dispatchMode: 'manager', coordinatorAgentId: managerId, source: { kind: 'user' } } });
    const firstWorker = await finished(first);
    managerEffort = 'max';
    customProviders.save({ ...manager, apiKey: '', reasoningEffort: managerEffort }, manager.id);
    const second = await continueRun(first.id, { goal: 'Review code again and return the audit report only.' });
    const secondWorker = await finished(second);
    assert.equal(first.threadId, second.threadId); assert.equal(firstWorker.threadId, secondWorker.threadId);
    assert.equal(first.settings.reasoningEffort, 'low'); assert.equal(second.settings.reasoningEffort, 'max');
    assert.equal(firstWorker.settings.reasoningEffort, 'high'); assert.equal(secondWorker.settings.reasoningEffort, 'high');
    assert.equal(runs.size, 4, 'feedback does not create extra rounds');
    assert.ok(firstWorker.events.some(event => event.params?.item?.type === 'commandExecution'), 'built-in command was executed');
    assert.ok(toolNames.includes('team_dispatch') && toolNames.includes('team_ask_manager'));
    for (const run of [first, firstWorker, second, secondWorker]) {
      assert.ok(run.events.some(event => event.type === 'reasoning_summary' && event.stage === 'delta'), 'native Codex forwards summary deltas');
      assert.ok(run.progress.reasoningSummaries.every(entry => entry.status === 'completed' && entry.parts.join('') === 'Fixture summary: check the next team action.'));
      assert.ok(!run.output.includes('Fixture summary:'), 'summary must stay separate from the final report');
    }
    replyOnly = true;
    const question = await continueRun(second.id, { goal: '你能做什么？' });
    await finished(question, false);
    assert.equal(question.threadId, second.threadId); assert.equal(question.delivery.mode, 'reply');
    assert.match(question.delivery.reply, /回答问题/); assert.deepEqual(question.delivery.artifacts, []);
    assert.equal(runs.size, 5, 'a question must not dispatch workers');
    const solo = await startRun({ agentId: managerId, adapter: manager.id, cwd, sandbox: 'danger-full-access', approvalPolicy: 'never', goal: '你好',
      management: { members: [members[0]], concurrency: 1 }, context: { taskId: 'solo-reply', agentName: 'Manager', agentRole: 'ProjectManager', dispatchMode: 'manager', source: { kind: 'user' } } });
    await finished(solo, false); assert.equal(solo.delivery.mode, 'reply'); assert.equal(runs.size, 6);
    assert.deepEqual(fs.readdirSync(cwd), [], 'questions and reports must not manufacture files');
    const publicEvents = JSON.stringify([...runs.values()].map(run => ({ settings: run.settings, events: run.events })));
    for (const key of Object.values(keys)) assert.ok(!publicEvents.includes(key));
    console.log('PASS: native Codex, two providers/models/keys, explicit low/high/max effort, streaming summaries, dispatch, feedback, command tool, resumed threads and direct replies without workers/files/completion tools. Requests=' + requestCount);
  } finally {
    for (const run of runs.values()) if (!['completed', 'failed', 'cancelled'].includes(run.status)) await cancelRun(run).catch(error => console.error(error.message));
    for (const session of sessions.values()) session.client.child?.stdin.end();
    mock.closeAllConnections(); mock.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
