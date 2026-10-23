const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { JsonRpcClient, startRun, continueRun, cancelRun, runs, sessions, route, teamCoordinator, publicRun } = require('../agent-manager-server.cjs');
const { createRunStore } = require('./run-store.cjs');
const { parseManagement } = require('./team-coordinator.cjs');
function fixture(t) {
  runs.clear(); sessions.clear();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-coordinator-'));
  const calls = [], responses = new Map(); let serial = 0;
  const members = ['pm', 'fe', 'be', 'qa'].map(id => ({ id, name: id, role: id === 'pm' ? 'ProjectManager' : id, prompt: id + ' original instructions', provider: 'codex-app-server', model: 'model-' + id, cwd }));
  for (const member of members) {
    const client = new JsonRpcClient(); client.start = async () => ({});
    client.child = { stdin: { writable: true, write: data => { const value = JSON.parse(data); responses.get(value.id)?.(value); } } };
    client.request = async (method, params) => {
    if (method === 'windowsSandbox/readiness') return { status: 'ready' };
    if (method === 'command/exec') return { exitCode: 0, stdout: '', stderr: '' };
      calls.push({ agent: member.id, method, params });
      if (method.startsWith('thread/')) return { thread: { id: params.threadId || 'thread-' + member.id } };
      if (method === 'turn/interrupt') return {};
      return { turn: { id: 'turn-' + ++serial } };
    };
    sessions.set(member.id, { client, agentId: member.id });
  }
  t.after(async () => {
    for (const run of runs.values()) { run.cancelRequested = true; run.status = 'cancelled'; }
    for (const { client } of sessions.values()) for (const pending of client.serverRequests.values()) clearTimeout(pending.timer);
    runs.clear(); sessions.clear(); fs.rmSync(cwd, { recursive: true, force: true });
  });
  const start = (goal = '实现实际交付物') => startRun({ agentId: 'pm', goal, cwd, approvalPolicy: 'on-request', management: { members, concurrency: 1 }, context: { taskId: 'task', teamId: 'team', agentName: 'pm', coordinatorAgentId: 'pm', dispatchMode: 'manager', taskTitle: goal, source: { kind: 'user' } } });
  const call = (run, tool, args = {}, overrides = {}) => new Promise(resolve => {
    const rpcId = ++serial; responses.set(rpcId, response => { responses.delete(rpcId); resolve(response.result); });
    run.client.handleServerRequest({ id: rpcId, method: 'item/tool/call', params: { threadId: run.threadId, turnId: run.turnId, callId: 'call-' + rpcId, tool, arguments: args, ...overrides } });
  });
  const complete = (run, status = 'completed', output = '修改完成；测试通过') => {
    run.client.emit({ type: 'notification', method: 'item/agentMessage/delta', params: { threadId: run.threadId, turnId: run.turnId, delta: output } });
    run.client.emit({ type: 'notification', method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status } } });
  };
  const final = (run, text, status = 'completed', phase = 'final_answer') => {
    run.client.emit({ type: 'notification', method: 'item/completed', params: { threadId: run.threadId, turnId: run.turnId,
      item: { id: 'final-' + run.id, type: 'agentMessage', phase, text } } });
    complete(run, status, '');
  };
  return { cwd, members, calls, start, call, complete, final };
}
test('生产任务接口提交整批后无需浏览器：接力继续、轻量增量、全文下载与重启中断', async t => {
  const f = fixture(t), server = http.createServer(route);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const members = ['fe', 'qa'].map(agentId => ({ agentId, goal: '检查接口与测试', cwd: f.cwd, approvalPolicy: 'never',
    context: { taskId: 'batch-test', agentName: agentId, taskTitle: '完整接力任务', source: { kind: 'user' } } }));
  const submitted = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ strategy: 'sequential', members }) });
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const root = (await submitted.json()).data, first = runs.get(root.runId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs.size, 2); assert.equal(first.status, 'running');
  assert.equal(f.calls.find(call => call.agent === 'fe' && call.method === 'turn/start').params.approvalPolicy, 'never');
  const second = [...runs.values()].find(run => run.id !== first.id);
  assert.equal(second.status, 'queued'); assert.equal(second.context.taskId, first.context.taskId);
  assert.equal((await (await fetch(base + '/api/conversations')).json()).data.length, 1);
  const store = createRunStore(path.join(f.cwd, 'batch.sqlite'));
  store.save(first, true); store.save(second, true); const recovered = store.load(); store.close();
  assert.ok(recovered.every(run => run.status === 'cancelled' && run.interruption === 'service-restart'));
  assert.equal(recovered.find(run => run.id === second.id).queuedInput.goal, members[1].goal);
  const report = '完整成果正文🙂'.repeat(3000);
  f.final(first, report);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.status, 'running', '未建立 SSE 或浏览器调度连接也会启动后续成员');
  assert.equal(f.calls.find(call => call.agent === 'qa' && call.method === 'turn/start').params.approvalPolicy, 'never');
  assert.equal(second.context.handoffFrom.runId, first.id);
  const read = async path => (await (await fetch(base + path)).json()).data;
  const conversationPath = `/api/runs/${first.id}/conversation?view=compact&limit=1`;
  const snapshot = await read(conversationPath);
  const executionPath = `/api/runs/${first.id}/execution?view=compact`;
  const execution = await read(executionPath);
  assert.equal(execution.runs.length, 2); assert.ok(execution.runs.every(run => !run.messages.length));
  assert.deepEqual((await read(executionPath + '&since=' + execution.revision)).runs, []);
  assert.equal(snapshot.runs[0].runId, second.id); assert.equal(snapshot.hasEarlier, true);
  const older = await read(conversationPath + '&offset=1');
  assert.equal(older.runs[0].runId, first.id); assert.equal(older.hasNewer, true);
  assert.deepEqual(older.runs[0].messages, []);
  const unchanged = await read(conversationPath + '&since=' + snapshot.revision);
  assert.deepEqual(unchanged.runs, []);
  f.final(second, '测试通过');
  const changed = await read(conversationPath + '&since=' + snapshot.revision);
  assert.deepEqual(changed.runs.map(run => run.runId), [second.id]);
  assert.equal(changed.summary.status, 'completed');
  const broadcasts = (await read('/api/messages')).filter(message => [first.id, second.id].includes(message.runId));
  assert.equal(broadcasts.length, 2, '成员完成广播也由服务端发布');
  const transcript = await (await fetch(base + `/api/runs/${first.id}/transcript`)).json();
  assert.equal(transcript.messages.find(message => message.phase === 'final_answer').text === report, true, '下载保留完整最终正文');
});

test('恶意网页不能批准真实未决请求，同源确认才消费审批', async t => {
  const f = fixture(t), run = await f.start(), server = http.createServer(route);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  run.client.handleServerRequest({ id: 'origin-approval', method: 'item/commandExecution/requestApproval', params: { threadId: run.threadId, turnId: run.turnId, command: 'node --test', cwd: f.cwd } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ agentId: run.agentId, runId: run.id, decision: 'accept' });
  const url = base + '/api/approvals/origin-approval/respond';
  const rejected = await fetch(url, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body });
  assert.equal(rejected.status, 403); assert.equal(run.approvals.size, 1);
  assert.equal(run.client.serverRequests.size, 1);
  const accepted = await fetch(url, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body });
  assert.equal(accepted.status, 200); assert.equal(run.approvals.size, 0); assert.equal(run.client.serverRequests.size, 0);
  f.final(run, '本次问题已答复。');
});
test('项目经理主导必须由 ProjectManager 角色协调，不能静默降级到普通成员', async t => {
  const f = fixture(t);
  const withoutManager = f.members.map(member => ({ ...member, role: 'FrontendEngineer' }));
  assert.throws(
    () => parseManagement({ members: withoutManager, concurrency: 1 }, 'pm'),
    /ProjectManager/
  );

  const wrongCoordinator = f.members.map(member => ({ ...member }));
  wrongCoordinator[0].role = 'FrontendEngineer';
  assert.throws(
    () => parseManagement({ members: wrongCoordinator, concurrency: 1 }, 'pm'),
    /ProjectManager/
  );

  await assert.rejects(
    startRun({
      agentId: 'pm', goal: '需要项目经理协调', cwd: f.cwd,
      management: { members: withoutManager, concurrency: 1 },
      context: { taskId: 'missing-manager', dispatchMode: 'manager', agentRole: 'FrontendEngineer', source: { kind: 'user' } }
    }),
    /ProjectManager/
  );
  assert.equal(runs.size, 0);
});
test('实际工具链：仅经理启动 → 指定成员 → 接收结果 → 验收；遵守并发且全部归属一个任务', async t => {
  const f = fixture(t), manager = await f.start();
  assert.equal(runs.size, 1);
  const first = f.calls[0];
  assert.deepEqual(first.params.dynamicTools.map(tool => tool.name), ['team_dispatch', 'team_wait', 'team_read_result', 'team_reply_member', 'team_complete']);
  assert.equal(first.params.sandbox, 'danger-full-access');
  assert.equal(f.calls[1].params.sandboxPolicy.type, 'dangerFullAccess');
  assert.match(first.params.developerInstructions, /最终交付负责/);
  assert.equal((await f.call(manager, 'team_dispatch', { agentId: 'outsider', instruction: 'bad' })).success, false);
  assert.equal((await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '实现页面并测试' })).success, true);
  const worker = [...runs.values()].at(-1);
  assert.equal(worker.agentId, 'fe'); assert.equal(worker.model, 'model-fe'); assert.equal(worker.context.source.id, 'pm');
  assert.equal(worker.settings.sandbox, 'danger-full-access');
  assert.equal(worker.settings.sandboxPolicy.type, 'dangerFullAccess');
  assert.equal(worker.settings.approvalPolicy, 'on-request');
  assert.equal(worker.context.taskId, manager.context.taskId); assert.equal(worker.settings.management, undefined);
  assert.equal(manager.approvals.size, 0);
  assert.equal((await f.call(manager, 'team_dispatch', { agentId: 'be', instruction: 'too early' })).success, false);
  const waiting = f.call(manager, 'team_wait'); f.complete(worker);
  const reply = await waiting; assert.equal(reply.success, true); assert.match(reply.contentItems[0].text, /测试通过/);
  fs.writeFileSync(path.join(f.cwd, 'index.html'), '<h1>Done</h1>');
  assert.equal((await f.call(manager, 'team_complete', { summary: '实际完成', artifacts: ['index.html'], verification: ['node --test：通过'] })).success, true);
  f.complete(manager); assert.equal(manager.status, 'completed'); assert.equal(manager.delivery.status, 'completed');
  assert.equal(manager.client.listeners.size, 0);
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = (await (await fetch(base + '/api/conversations')).json()).data;
  assert.equal(list.length, 1); assert.equal(list[0].coordination.status, 'completed'); assert.equal(list[0].runIds.length, 2);
  assert.equal(list[0].turnCount, 1); assert.equal(list[0].executionCount, 2);
  const detail = (await (await fetch(base + '/api/runs/' + manager.id + '/conversation?limit=1')).json()).data;
  assert.equal(detail.runs.length, 1); assert.equal(detail.rounds[0].runIds.length, 2); assert.equal(detail.summary.turnCount, 1);
  const notices = (await (await fetch(base + '/api/notifications')).json()).data;
  assert.equal(notices.length, 1); assert.equal(notices[0].runId, manager.id); assert.equal(notices[0].round, 1);
  const execution = (await (await fetch(base + '/api/runs/' + manager.id + '/execution')).json()).data;
  assert.equal(execution.members.length, 4); assert.equal(execution.runs.length, 2);
  assert.ok(execution.runs.every(run => run.status === 'completed'));
  const office = (await (await fetch(base + '/api/office')).json()).data;
  assert.equal(office.agents.find(agent => agent.agentId === 'fe').context.handoffFrom.runId, manager.id);
  const followup = await continueRun(manager.id, { goal: '继续修正' });
  const secondRound = (await (await fetch(base + '/api/runs/' + manager.id + '/execution')).json()).data;
  assert.equal(secondRound.round, 2); assert.equal(secondRound.members.length, 4);
  assert.deepEqual(secondRound.runs.map(run => run.runId), [followup.id]);
  const currentOffice = (await (await fetch(base + '/api/office?scope=task&taskId=task')).json()).data;
  assert.deepEqual(currentOffice.agents.map(run => run.runId), [followup.id]);
  const repair = await fetch(base + '/api/providers/codex-app-server/repair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setup', cwd: f.cwd }) });
  assert.equal(repair.status, 409);
});
test('成员可在执行中提问，项目经理 team_wait 收到反馈并回复后成员继续原会话', async t => {
  const f = fixture(t), manager = await f.start();
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '实现接口并在不确定时向项目经理提问' });
  const worker = [...runs.values()].at(-1);
  const workerStart = f.calls.find(call => call.agent === 'fe' && call.method === 'thread/start');
  assert.deepEqual(workerStart.params.dynamicTools.map(tool => tool.name), ['team_ask_manager']);
  const waiting = f.call(manager, 'team_wait');
  const asking = f.call(worker, 'team_ask_manager', { question: '接口返回字段是否允许兼容旧格式？', context: '已检查现有调用方，发现两个旧字段仍在使用。' });
  const managerReply = await waiting;
  assert.equal(managerReply.success, true);
  const waitResult = JSON.parse(managerReply.contentItems[0].text);
  assert.equal(waitResult.reason, 'feedback');
  assert.equal(waitResult.feedbackRequests.length, 1);
  const request = waitResult.feedbackRequests[0];
  assert.match(request.question, /旧格式/);
  const waitAgain = JSON.parse((await f.call(manager, 'team_wait')).contentItems[0].text);
  assert.equal(waitAgain.reason, 'feedback'); assert.equal(waitAgain.feedbackRequests[0].requestId, request.requestId);
  assert.equal((await f.call(worker, 'team_dispatch', { agentId: 'be', instruction: '越权派发' })).success, false);
  assert.equal(manager.feedback[0].status, 'pending');
  const replied = await f.call(manager, 'team_reply_member', { requestId: request.requestId, answer: '保留旧字段一轮，新增字段同时返回，并补充兼容测试。' });
  assert.equal(replied.success, true);
  const workerReply = await asking;
  assert.equal(workerReply.success, true);
  assert.equal(JSON.parse(workerReply.contentItems[0].text).status, 'answered');
  assert.equal(worker.feedback[0].status, 'answered');
  assert.match(worker.feedback[0].answer, /兼容测试/);
  assert.equal(runs.size, 2, '问答不新增运行或用户轮次');
  const store = createRunStore(path.join(f.cwd, 'feedback.sqlite'));
  store.save(manager, true); store.save(worker, true);
  const loaded = store.load(); store.close();
  assert.equal(loaded.find(run => run.id === worker.id).feedback[0].answer, worker.feedback[0].answer);
  f.complete(worker, 'completed', '按回复完成实现');
  f.complete(manager, 'completed', '已收到成员反馈并完成验收');
});
test('取消成员会同步关闭经理反馈；等待不会遗留为审批，也不会接受旧 turn 的回复', async t => {
  const f = fixture(t), manager = await f.start();
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '有问题先咨询' });
  const worker = [...runs.values()].at(-1), asking = f.call(worker, 'team_ask_manager', { question: '边界是什么？' });
  const requestId = manager.feedback[0].requestId;
  assert.equal(worker.approvals.size, 0); assert.equal(manager.approvals.size, 0);
  assert.equal((await f.call(manager, 'team_reply_member', { requestId, answer: '旧轮次' }, { turnId: 'old-turn' })).success, false);
  await cancelRun(worker); await asking;
  assert.equal(manager.feedback[0].status, 'cancelled'); assert.equal(worker.feedback[0].status, 'cancelled');
  assert.equal((await f.call(manager, 'team_reply_member', { requestId, answer: '继续' })).success, false);
});
test('服务重启取消持久化的待答问题，保留问题原文与取消原因', async t => {
  const f = fixture(t), manager = await f.start();
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '先确认约定' });
  const worker = [...runs.values()].at(-1), asking = f.call(worker, 'team_ask_manager', { question: '确认约定' });
  const store = createRunStore(path.join(f.cwd, 'feedback-restart.sqlite'));
  store.save(manager, true); store.save(worker, true);
  const loaded = store.load(); store.close();
  assert.ok(loaded.every(run => run.feedback[0].status === 'cancelled'));
  assert.ok(loaded.every(run => run.feedback[0].question === '确认约定' && run.feedback[0].answer.includes('服务重启')));
  await cancelRun(manager); await asking;
});
test('旧线程首次续聊显式迁移团队工具，保留近期公开结果与任务归属', async t => {
  const f = fixture(t), manager = await f.start('审查代码');
  f.final(manager, '审查已完成：保留兼容约定。');
  delete manager.settings.teamProtocolVersion;
  const next = await continueRun(manager.id, { goal: '继续复核' });
  assert.equal(next.threadMigration.fromThreadId, manager.threadId);
  assert.equal(next.context.taskId, manager.context.taskId);
  assert.equal(next.parentRunId, manager.id);
  const starts = f.calls.filter(call => call.method === 'thread/start');
  assert.equal(starts.length, 2); assert.match(starts.at(-1).params.developerInstructions, /保留兼容约定/);
  assert.ok(starts.at(-1).params.dynamicTools.some(tool => tool.name === 'team_reply_member'));
  assert.equal(starts.at(-1).params.teamProtocolVersion, undefined, '内部协议标识不能传入引擎');
});

test('旧版负责人续聊注册成果工具，直接分段读取旧成员全文，不重复派工', async t => {
  const f = fixture(t), manager = await f.start('审查代码并给出报告');
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '审查页面并给出报告' });
  const worker = [...runs.values()].at(-1), report = '开头结论\n' + '中文报告🙂与代码依据\n'.repeat(2500) + '最后一条建议';
  f.final(worker, report); f.final(manager, '已汇总审查报告。');
  manager.settings.teamProtocolVersion = 1;
  const next = await continueRun(manager.id, { goal: '继续核对成员报告中的依据' });
  const started = f.calls.filter(call => call.method === 'thread/start').at(-1);
  assert.ok(started.params.dynamicTools.some(tool => tool.name === 'team_read_result'));
  assert.ok(started.params.developerInstructions.includes(worker.id));
  assert.equal(next.threadMigration.fromThreadId, manager.threadId);
  let cursor, restored = '';
  do {
    const response = await f.call(next, 'team_read_result', { runId: worker.id, ...(cursor ? { cursor } : {}) });
    assert.equal(response.success, true);
    assert.ok(Buffer.byteLength(response.contentItems[0].text) <= 6000);
    const page = JSON.parse(response.contentItems[0].text);
    restored += page.content; cursor = page.nextCursor;
  } while (cursor);
  assert.equal(restored, report); assert.equal(runs.size, 3, '读取不能重新派发成员或新增用户轮次');
  f.final(next, '已完整核对原报告。');
});
test('计划结束不冒充交付；成员失败后可恢复原线程返工，验证前拒绝完成', async t => {
  const f = fixture(t), manager = await f.start();
  assert.equal((await f.call(manager, 'team_complete', { summary: '计划完成', artifacts: [], verification: ['未执行'] })).success, false);
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '实现' });
  const failed = [...runs.values()].at(-1); f.complete(failed, 'failed', '测试失败');
  assert.equal((await f.call(manager, 'team_complete', { summary: '完成', artifacts: ['index.html'], verification: ['测试失败'] })).success, false);
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '修复失败测试' });
  const retried = [...runs.values()].at(-1);
  assert.equal(retried.threadId, failed.threadId); assert.equal(retried.parentRunId, failed.id);
  assert.ok(f.calls.some(call => call.agent === 'fe' && call.method === 'thread/resume'));
  f.complete(retried);
  assert.equal((await f.call(manager, 'team_complete', { summary: '完成', artifacts: ['nonexistent.html'], verification: ['测试通过'] })).success, false);
  f.complete(manager, 'completed', '我写了一个计划');
  assert.equal(manager.status, 'failed'); assert.equal(manager.delivery.status, 'blocked');
});
test('停止经理联动成员、等待工具返回且不能继续派发；不同 turn 的调用被拒绝', async t => {
  const f = fixture(t), manager = await f.start();
  assert.equal((await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '实现' }, { turnId: 'wrong-turn' })).success, false);
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '实现' });
  const worker = [...runs.values()].at(-1);
  const waiting = teamCoordinator.call(manager, 'team_wait', {}, 'waiting').catch(error => error);
  await cancelRun(manager);
  assert.equal(worker.status, 'cancelled'); assert.equal(manager.status, 'cancelled');
  assert.ok(await waiting instanceof Error);
  await assert.rejects(teamCoordinator.call(manager, 'team_dispatch', { agentId: 'be', instruction: 'no' }, 'no'), /停止/);
});
test('团队快照与交付状态可持久恢复，续聊接项目经理且保留调度能力', async t => {
  const f = fixture(t), manager = await f.start(); f.complete(manager);
  const store = createRunStore(path.join(f.cwd, 'runs.sqlite')); store.save(manager, true); const loaded = store.load()[0]; store.close();
  assert.deepEqual(loaded.settings.management.members.map(member => member.id), ['pm', 'fe', 'be', 'qa']);
  assert.equal(publicRun(loaded).coordination.status, 'blocked');
  const followup = await continueRun(manager.id, { goal: '继续实现' });
  assert.equal(followup.threadId, manager.threadId); assert.equal(followup.settings.management.members.length, 4);
  assert.equal((await f.call(followup, 'team_dispatch', { agentId: 'qa', instruction: '补充验证' })).success, true);
});
test('旧版规划任务在原历史批次中升级，携带原输出与当前团队快照，创建支持工具的新线程', async t => {
  const f = fixture(t);
  const old = await startRun({ agentId: 'pm', goal: '旧任务', cwd: f.cwd, context: { taskId: 'task', taskTitle: '旧任务', agentRole: 'ProjectManager', dispatchMode: 'manager', source: { kind: 'user' } } });
  f.complete(old, 'completed', '此前只有一个计划');
  const continued = await continueRun(old.id, { goal: '补充计划' });
  f.complete(continued, 'completed', '更新后的计划');
  const next = await continueRun(old.id, { goal: '实际交付', management: { members: f.members, concurrency: 1 } });
  assert.match(next.goal, /更新后的计划/); assert.equal(next.context.taskId, old.context.taskId);
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 2);
  assert.equal(next.settings.management.members.length, 4);
});

test('服务重启后管理任务与交付状态同时中断，不再显示仍在验收', async t => {
  const f = fixture(t), manager = await f.start();
  const store = createRunStore(path.join(f.cwd, 'restart.sqlite'));
  store.save(manager, true); const loaded = store.load()[0]; store.close();
  assert.equal(loaded.status, 'cancelled'); assert.equal(loaded.delivery.status, 'cancelled');
  assert.match(loaded.delivery.summary, /服务重启/);
});

test('已经完成的成员仍可被经理派发修正，恢复同线程且继承只读权限', async t => {
  const f = fixture(t);
  const manager = await startRun({ agentId: 'pm', goal: '只读检查', cwd: f.cwd, sandbox: 'read-only', management: { members: f.members, concurrency: 1 }, context: { taskId: 'task', roundId: 'first', source: { kind: 'user' }, dispatchMode: 'manager' } });
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '检查问题' });
  const first = [...runs.values()].at(-1); f.complete(first);
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '复核遗漏问题并更新结论' });
  const next = [...runs.values()].at(-1);
  assert.equal(next.threadId, first.threadId); assert.equal(next.parentRunId, first.id);
  assert.equal(next.context.roundId, 'first'); assert.equal(next.context.assignment, '复核遗漏问题并更新结论');
  assert.equal(next.settings.sandbox, 'read-only'); assert.equal(next.settings.sandboxPolicy.type, 'readOnly');
  assert.ok(f.calls.some(call => call.agent === 'fe' && call.method === 'turn/start' && call.params.sandboxPolicy.type === 'readOnly'));
});

test('代码审查无需派发和写文件，最终报告正常完成并出现在历史、办公室和通知', async t => {
  const f = fixture(t), manager = await f.start('审查当前项目的代码质量，重点检查正确性、异常处理和可维护性，按影响程度给出建议。');
  assert.equal(manager.settings.management.deliveryMode, 'report');
  assert.match(f.calls[0].params.developerInstructions, /允许项目经理独立调查/);
  f.final(manager, '发现 2 个问题。\nP2：app.js:10 的异常恢复未重新启用按钮。依据：事件注入已复现；真实后退路径未验证。');
  assert.equal(manager.status, 'completed'); assert.equal(manager.delivery.mode, 'report');
  assert.deepEqual(manager.delivery.artifacts, []);
  assert.match(manager.delivery.report, /真实后退路径未验证/);
  assert.equal(runs.size, 1); assert.deepEqual(fs.readdirSync(f.cwd), []);
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const conversations = (await (await fetch(base + '/api/conversations')).json()).data;
  assert.equal(conversations[0].status, 'completed'); assert.equal(conversations[0].coordination.mode, 'report');
  const notifications = (await (await fetch(base + '/api/notifications')).json()).data;
  assert.equal(notifications.length, 1); assert.match(notifications[0].title, /报告已完成/);
  const office = (await (await fetch(base + '/api/office')).json()).data;
  assert.equal(office.agents[0].status, 'done');
});

test('报告也可用完成工具提交依据，不强制文件或其他成员', async t => {
  const f = fixture(t);
  const manager = await startRun({ agentId: 'pm', goal: '分析代码并给出建议', cwd: f.cwd,
    management: { members: [f.members[0]], concurrency: 1 }, context: { taskId: 'solo-review', source: { kind: 'user' } } });
  assert.equal((await f.call(manager, 'team_complete', { summary: '发现异常日志丢失调用栈', artifacts: [], verification: [] })).success, false);
  assert.equal((await f.call(manager, 'team_complete', { summary: '发现异常日志丢失调用栈', artifacts: [], verification: ['已检查 server.js 的错误分支，未进行运行时复现'] })).success, true);
  f.complete(manager); assert.equal(manager.status, 'completed'); assert.equal(manager.delivery.mode, 'report');
});

test('只有进度消息、真实引擎失败或仍有成员执行时，报告任务不会误报完成', async t => {
  const f = fixture(t), progressOnly = await f.start('审查代码');
  f.complete(progressOnly, 'completed', '我将开始检查代码');
  assert.equal(progressOnly.status, 'failed');
  const engineFailed = await continueRun(progressOnly.id, { goal: '继续审查代码' });
  f.final(engineFailed, '初步发现一个问题，调查仍未完成', 'failed');
  assert.equal(engineFailed.status, 'failed');
  const pending = await continueRun(progressOnly.id, { goal: '继续审查代码' });
  await f.call(pending, 'team_dispatch', { agentId: 'qa', instruction: '复核异常分支' });
  f.final(pending, '报告尚待测试成员的结果');
  assert.equal(pending.status, 'failed'); assert.notEqual(pending.delivery.status, 'completed');
});

test('报告续聊保留类型；要求修复时恢复开发验收，不接受只有文字的成果', async t => {
  const f = fixture(t), review = await f.start('审查本次改动，只给出优化建议，不要修改代码');
  f.final(review, '未发现阻塞问题，建议补充边界覆盖；依据：静态检查。');
  const explanation = await continueRun(review.id, { goal: '继续' });
  assert.equal(explanation.settings.management.deliveryMode, 'report');
  f.final(explanation, '边界覆盖建议：增加空输入和超时恢复检查。');
  const fix = await continueRun(review.id, { goal: '修复审查发现的问题' });
  assert.equal(fix.settings.management.deliveryMode, 'files');
  f.final(fix, '我计划先修复异常处理，再执行测试');
  assert.equal(fix.status, 'failed'); assert.notEqual(fix.delivery.status, 'completed');
});

test('普通提问只需经理完整答复，历史、办公室和通知均显示成功且不派工', async t => {
  const f = fixture(t), manager = await f.start('这个功能怎么使用？');
  assert.equal(manager.settings.management.deliveryMode, 'reply');
  assert.match(f.calls[0].params.developerInstructions, /最终答复本身就代表本轮完成/);
  const answer = '选择团队，填写你的问题并发送即可。\n' + '可沿用当前会话继续提问。'.repeat(60);
  f.final(manager, answer);
  assert.equal(manager.status, 'completed'); assert.equal(manager.delivery.mode, 'reply'); assert.equal(manager.delivery.reply, answer);
  assert.equal(runs.size, 1); assert.deepEqual(fs.readdirSync(f.cwd), []); assert.equal(manager.client.listeners.size, 0);
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const conversations = (await (await fetch(base + '/api/conversations')).json()).data;
  assert.equal(conversations.length, 1); assert.equal(conversations[0].status, 'completed'); assert.equal(conversations[0].coordination.mode, 'reply');
  const notices = (await (await fetch(base + '/api/notifications')).json()).data;
  assert.equal(notices.length, 1); assert.equal(notices[0].title, '项目经理已回复');
  const office = (await (await fetch(base + '/api/office')).json()).data;
  assert.equal(office.agents[0].status, 'done'); assert.equal(office.agents[0].resultMode, 'reply'); assert.equal(office.agents[0].activity, '已回复用户问题');
});

test('自定义模型不带 phase 的完整问答成功；单经理也可用完成工具回复', async t => {
  const f = fixture(t);
  const manager = await startRun({ agentId: 'pm', goal: '你好', cwd: f.cwd,
    management: { members: [f.members[0]], concurrency: 1 }, context: { taskId: 'solo-reply', source: { kind: 'user' } } });
  f.final(manager, '你好，请告诉我你想了解的问题。', 'completed', null);
  assert.equal(manager.status, 'completed'); assert.equal(manager.delivery.reply, '你好，请告诉我你想了解的问题。');
  const next = await continueRun(manager.id, { goal: '你是什么模型？' });
  assert.equal(next.threadId, manager.threadId);
  assert.equal((await f.call(next, 'team_complete', { summary: '我是当前配置的自定义模型。', artifacts: [], verification: [] })).success, true);
  f.final(next, '我是当前配置的自定义模型，具体版本以供应商设置为准。', 'completed', null);
  assert.equal(next.status, 'completed'); assert.match(next.delivery.reply, /具体版本/);
});

test('开发后的新提问不再要求文件交付，再次开发仍须验收', async t => {
  const f = fixture(t), first = await f.start(); f.complete(first);
  const question = await continueRun(first.id, { goal: '如何使用这个功能？' });
  assert.equal(question.settings.management.deliveryMode, 'reply'); assert.equal(question.threadId, first.threadId);
  f.final(question, '打开首页，选择团队即可。'); assert.equal(question.status, 'completed');
  const develop = await continueRun(question.id, { goal: '帮我修改首页' });
  assert.equal(develop.settings.management.deliveryMode, 'files');
  f.final(develop, '准备开始修改首页'); assert.equal(develop.status, 'failed');
});

test('问答不掩盖空答复、进度消息、引擎失败或仍在工作的成员', async t => {
  const f = fixture(t), empty = await f.start('你好'); f.final(empty, ''); assert.equal(empty.status, 'failed');
  const commentary = await continueRun(empty.id, { goal: '你是什么模型？' });
  f.final(commentary, '我正在查询', 'completed', 'commentary'); assert.equal(commentary.status, 'failed');
  const failed = await continueRun(commentary.id, { goal: '你是什么模型？' });
  f.final(failed, '部分输出', 'failed', null); assert.equal(failed.status, 'failed');
  const pending = await continueRun(failed.id, { goal: '这个功能怎么使用？' });
  await f.call(pending, 'team_dispatch', { agentId: 'qa', instruction: '查阅使用说明' });
  f.final(pending, '等成员答复'); assert.equal(pending.status, 'failed'); assert.notEqual(pending.delivery.status, 'completed');
});

function companyFixture(t) {
  const f = fixture(t);
  f.members.find(member => member.id === 'fe').role = 'ProjectManager';
  const management = { members: f.members, concurrency: 1, rootTeamId: 'company', teams: [
    { id: 'company', name: '产品管理', leaderId: 'pm', memberIds: ['pm', 'qa'], children: ['software'], concurrency: 1 },
    { id: 'software', name: '软件开发', leaderId: 'fe', memberIds: ['fe', 'be'], children: [], concurrency: 1 }
  ] };
  const start = goal => startRun({ agentId: 'pm', goal, cwd: f.cwd, management,
    context: { taskId: 'company-task', roundId: 'company-first', agentName: '总项目经理', agentRole: 'ProjectManager', coordinatorAgentId: 'pm', dispatchMode: 'manager', source: { kind: 'user' } } });
  return { ...f, start };
}

test('公司→部门负责人→工程师真实分级派发、逐级验收，历史仍为一轮一个任务', async t => {
  const f = companyFixture(t), manager = await f.start('实现产品接口');
  assert.equal((await f.call(manager, 'team_dispatch', { agentId: 'be', instruction: '越级实现' })).success, false);
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '实现接口并完成验证' });
  const lead = [...runs.values()].at(-1);
  assert.equal(lead.settings.management.rootTeamId, 'software'); assert.deepEqual(lead.settings.management.members.map(member => member.id), ['fe', 'be']);
  const start = f.calls.find(call => call.agent === 'fe' && call.method === 'thread/start');
  assert.deepEqual(start.params.dynamicTools.map(tool => tool.name), ['team_dispatch', 'team_wait', 'team_read_result', 'team_reply_member', 'team_complete', 'team_ask_manager']);
  assert.equal((await f.call(lead, 'team_dispatch', { agentId: 'qa', instruction: '跨部门越权' })).success, false);
  assert.equal((await f.call(manager, 'team_dispatch', { agentId: 'qa', instruction: '超过上级并发' })).success, false);
  let parentAwake = false;
  const parentWaiting = f.call(manager, 'team_wait').then(result => { parentAwake = true; return result; });
  await f.call(lead, 'team_dispatch', { agentId: 'be', instruction: '实现接口' });
  const worker = [...runs.values()].at(-1), childWaiting = f.call(lead, 'team_wait');
  assert.equal(worker.context.coordinatorRunId, lead.id); assert.equal(worker.context.roundId, manager.context.roundId);
  assert.equal((await f.call(lead, 'team_complete', { summary: '未完成', artifacts: [], verification: [] })).success, false);
  fs.writeFileSync(path.join(f.cwd, 'api.js'), 'module.exports = () => 1;');
  f.complete(worker); await childWaiting;
  assert.equal((await f.call(lead, 'team_complete', { summary: '接口实现完成', artifacts: ['api.js'], verification: ['已验证返回值'] })).success, true);
  await Promise.resolve(); assert.equal(parentAwake, false, '子团队提交成果工具后仍在整理最终回复，上级应等待真实结束');
  f.final(lead, '接口实现完成，api.js 已验证'); await parentWaiting;
  assert.equal((await f.call(manager, 'team_complete', { summary: '产品接口交付', artifacts: ['api.js'], verification: ['检查子团队实现与验证证据'] })).success, true);
  f.final(manager, '产品接口已交付'); assert.equal(manager.status, 'completed');
  const { conversationRounds, deliveryNotifications } = require('./conversation-rounds.cjs');
  const chain = [...runs.values()], rounds = conversationRounds(chain);
  assert.equal(rounds.length, 1); assert.equal(rounds[0].runIds.length, 3); assert.equal(rounds[0].manager.id, manager.id);
  assert.equal(deliveryNotifications([chain]).length, 1);
  const next = await continueRun(worker.id, { goal: '继续修复接口' });
  assert.equal(next.agentId, 'pm'); assert.equal(next.settings.management.teams.length, 2);
});

test('下级问题可经部门负责人向总经理升级，再逐级回复，原等待由事件唤醒', async t => {
  const f = companyFixture(t), manager = await f.start('分析产品架构并给出报告');
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '分析软件接口并给出报告' });
  const lead = [...runs.values()].at(-1);
  await f.call(lead, 'team_dispatch', { agentId: 'be', instruction: '检查接口约定' });
  const worker = [...runs.values()].at(-1);
  const rootWaiting = f.call(manager, 'team_wait'), leadWaiting = f.call(lead, 'team_wait');
  const asking = f.call(worker, 'team_ask_manager', { question: '设备接口是否必须兼容旧版？' });
  const childRequest = JSON.parse((await leadWaiting).contentItems[0].text).feedbackRequests[0];
  const escalating = f.call(lead, 'team_ask_manager', { question: '需确认产品旧版兼容范围', context: '工程师发现两种协议版本。建议保留一版兼容。' });
  const rootRequest = JSON.parse((await rootWaiting).contentItems[0].text).feedbackRequests[0];
  assert.equal(rootRequest.memberId, 'fe'); assert.equal(childRequest.memberId, 'be');
  const leadSnapshot = JSON.parse((await f.call(lead, 'team_wait')).contentItems[0].text);
  assert.deepEqual(leadSnapshot.feedbackRequests.map(item => item.requestId), [childRequest.requestId], '向上提问不能当作自己需要回答的问题');
  await f.call(manager, 'team_reply_member', { requestId: rootRequest.requestId, answer: '保持兼容旧版协议。' }); await escalating;
  await f.call(lead, 'team_reply_member', { requestId: childRequest.requestId, answer: '总经理确认：保持兼容旧版协议。' });
  assert.equal(JSON.parse((await asking).contentItems[0].text).status, 'answered');
  f.final(worker, '接口分析完成。'); f.final(lead, '兼容旧协议，依据：现有接口规格。'); f.final(manager, '架构报告完成。');
  assert.equal(lead.status, 'completed'); assert.equal(manager.status, 'completed'); assert.equal(runs.size, 3);
});

test('开发产品中的需求分析工作包允许报告交付；部门返工沿用其原线程与花名册', async t => {
  const f = companyFixture(t), manager = await f.start('开发产品');
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '分析产品需求并给出验收标准' });
  const first = [...runs.values()].at(-1); assert.equal(first.settings.management.deliveryMode, 'report');
  f.final(first, '需求与验收标准已整理，待用户确认范围。'); assert.equal(first.status, 'completed');
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '继续' });
  const second = [...runs.values()].at(-1);
  assert.equal(second.threadId, first.threadId); assert.equal(second.parentRunId, first.id);
  assert.equal(second.settings.teamToolRole, 'leader'); assert.equal(second.settings.management.rootTeamId, 'software');
  assert.equal(second.settings.management.deliveryMode, 'report', '部门续办沿用本部门上次类型，不继承产品开发门槛');
  f.final(second, '已补充异常与权限路径。');
  f.final(manager, '计划已经完成'); assert.equal(manager.status, 'failed', '产品开发仍不能只交计划');
});

test('停止上级递归停止部门与工程师，释放逐级挂起的反馈与等待', async t => {
  const f = companyFixture(t), manager = await f.start('审查产品');
  await f.call(manager, 'team_dispatch', { agentId: 'fe', instruction: '审查软件' });
  const lead = [...runs.values()].at(-1);
  await f.call(lead, 'team_dispatch', { agentId: 'be', instruction: '审查接口' });
  const worker = [...runs.values()].at(-1);
  const question = f.call(worker, 'team_ask_manager', { question: '需要哪个版本？' });
  const escalating = f.call(lead, 'team_ask_manager', { question: '确认产品版本？' });
  await cancelRun(manager);
  assert.equal(manager.status, 'cancelled'); assert.equal(lead.status, 'cancelled'); assert.equal(worker.status, 'cancelled');
  await Promise.all([question, escalating]);
  assert.ok([...runs.values()].every(run => !run.feedback?.some(item => item.status === 'pending')));
});
