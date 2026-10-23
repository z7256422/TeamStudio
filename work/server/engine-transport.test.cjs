const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { codexLaunch } = require('./codex-process.cjs');
const { stopProvider } = require('./service-lifecycle.cjs');
const { startRun, sessions, runs, customProviders } = require('../agent-manager-server.cjs');

test('真实 Codex app-server → 团队派发 → 长成果分段读取 → 验收（本机模拟模型，无付费调用）', { timeout: 60000 }, async t => {
  try { codexLaunch(process.env.CODEX_BIN || 'codex', { cwd: process.cwd() }); }
  catch (error) { if (process.env.REQUIRE_CODEX_TEST === '1') throw error; t.skip('未安装 Codex；发布检查设置 REQUIRE_CODEX_TEST=1 将此项设为必需'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-engine-test-'));
  const originalHome = process.env.CODEX_HOME; process.env.CODEX_HOME = directory;
  const report = 'REPORT BEGIN\n' + '中文证据🙂 "quoted"\\path\n'.repeat(1300) + '\nREPORT END';
  const failures = [], seenTools = new Set(); let serial = 0, pagesRead = 0;
  function send(res, item) {
    const response = { id: 'resp_' + ++serial, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      ...(item.type === 'message' ? [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text }] : []),
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
    for (const event of events) res.write('data: ' + JSON.stringify(event) + '\n\n'); res.end();
  }
  const answer = text => ({ type: 'message', id: 'message-' + ++serial, role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(req.url, '/v1/responses');
      const manager = (body.tools || []).some(tool => tool.name === 'team_dispatch');
      if (!manager) return send(res, answer(report));
      const calls = new Map((body.input || []).filter(item => item.type === 'function_call').map(item => [item.call_id, item.name]));
      const outputs = (body.input || []).filter(item => item.type === 'function_call_output').map(item => {
        const text = typeof item.output === 'string' ? item.output : item.output.map(value => value.text || '').join('');
        assert.ok(!/\u2026\d+ tokens truncated\u2026/.test(text));
        return { name: calls.get(item.call_id), value: JSON.parse(text) };
      });
      const reads = outputs.filter(item => item.name === 'team_read_result');
      const last = outputs.at(-1), dispatched = outputs.find(item => item.name === 'team_dispatch')?.value;
      let name, args = {};
      if (!last) { name = 'team_dispatch'; args = { agentId: 'engine-test-member', instruction: '检查测试数据并提交完整审查报告' }; }
      else if (last.name === 'team_dispatch') name = 'team_wait';
      else if (last.name === 'team_wait') { name = 'team_read_result'; args = { runId: dispatched.runId }; }
      else if (last.name === 'team_read_result' && last.value.hasMore) { name = 'team_read_result'; args = { runId: dispatched.runId, cursor: last.value.nextCursor }; }
      else if (last.name === 'team_read_result') {
        assert.equal(reads.map(item => item.value.content).join(''), report);
        pagesRead = reads.length; name = 'team_complete'; args = { summary: '完整审查报告已接收', artifacts: [], verification: ['分段内容与原始中文报告逐字一致'] };
      } else { assert.equal(last.name, 'team_complete'); return send(res, answer('已完成测试报告验收。')); }
      seenTools.add(name);
      send(res, { type: 'function_call', id: 'fc_' + ++serial, call_id: 'call_' + serial, name, arguments: JSON.stringify(args), status: 'completed' });
    } catch (error) { failures.push(error); res.writeHead(500); res.end('Local test assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.allSettled([...sessions.values()].map(session => stopProvider(session.client.child)));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    sessions.clear(); runs.clear();
    if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const provider = customProviders.save({ label: 'Isolated engine test', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, auth: 'none', defaultModel: 'deepseek-v4.1-flash', enabled: true });
  const members = [{ id: 'engine-test-manager', name: '经理', role: 'ProjectManager' }, { id: 'engine-test-member', name: '工程师', role: 'Engineer' }]
    .map(member => ({ ...member, provider: provider.id, model: 'default', cwd: directory }));
  const manager = await startRun({ agentId: members[0].id, adapter: provider.id, goal: '审查测试数据并提交报告', cwd: directory,
    approvalPolicy: 'never', sandbox: 'danger-full-access', management: { members, concurrency: 1 },
    context: { taskId: 'engine-test-task', agentName: '经理', source: { kind: 'user' }, dispatchMode: 'manager' } });
  if (!['completed', 'failed', 'cancelled'].includes(manager.status)) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(failures[0] || new Error('Engine transport timed out')); }, 45000);
    const off = manager.client.on(event => {
      if ((event.type === 'notification' && event.method === 'turn/completed' && event.params.threadId === manager.threadId) || event.type === 'provider_error') { clearTimeout(timer); off(); resolve(); }
    });
  });
  if (failures.length) throw failures[0];
  assert.equal(manager.status, 'completed', manager.error);
  assert.equal(manager.delivery.status, 'completed'); assert.ok(pagesRead > 2);
  assert.deepEqual([...seenTools], ['team_dispatch', 'team_wait', 'team_read_result', 'team_complete']);
  assert.equal(runs.size, 2); assert.ok([...runs.values()].every(run => run.status === 'completed'));
});
