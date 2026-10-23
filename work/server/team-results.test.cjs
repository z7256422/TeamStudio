const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTeamCoordinator } = require('./team-coordinator.cjs');
const { TOOL_RESULT_BYTES } = require('./team-results.cjs');
const { updateRunMessages } = require('../shared/run-activity.js');
const { createRunStore } = require('./run-store.cjs');

function fixture() {
  const manager = { id: 'manager', agentId: 'pm', status: 'running', context: { taskId: 'task' }, settings: { management: {} } };
  const runs = new Map([[manager.id, manager]]);
  const coordinator = createTeamCoordinator({ runs, emitRun: () => {} });
  const member = (id, text, parent = manager) => {
    const run = { id, agentId: id, status: 'completed', context: { taskId: parent.context.taskId, coordinatorRunId: parent.id, agentName: id }, events: [],
      output: '进展不应混入正文' + text, messages: [{ id: 'progress', phase: 'commentary', text: '正在检查', endedAt: 'now' },
        { id: 'answer', phase: 'final_answer', text, endedAt: 'now' }] };
    runs.set(run.id, run); return run;
  };
  const call = (name, args = {}, owner = manager) => coordinator.call(owner, name, args);
  return { manager, runs, member, coordinator, call };
}
async function readAll(f, runId, extra = {}, owner) {
  let cursor, content = '', pages = 0;
  do {
    const page = await f.call('team_read_result', { runId, ...extra, ...(cursor ? { cursor } : {}) }, owner);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= (extra.maxBytes || TOOL_RESULT_BYTES));
    assert.equal(page.offset, content.length);
    assert.equal(page.hasMore, Boolean(page.nextCursor));
    assert.equal(page.content.includes('\uFFFD'), false);
    content += page.content; cursor = page.nextCursor; pages++;
    assert.ok(pages < 1000, '分页必须有界前进');
  } while (cursor);
  return { content, pages };
}

test('长中文、emoji 和 JSON 转义逐页无损还原，已通知结果仍可重复读取', async () => {
  const f = fixture(), text = '开头证据\n' + '中文🙂\\"\n\t\u0000证据行'.repeat(2500) + '\n最后一条结论';
  f.member('research', text);
  const update = await f.call('team_wait');
  assert.ok(Buffer.byteLength(JSON.stringify(update)) <= TOOL_RESULT_BYTES);
  assert.equal(update.members[0].outputTruncated, true);
  assert.equal(update.members[0].result.totalChars, text.length);
  assert.ok(text.startsWith(update.members[0].output));
  assert.equal((await f.call('team_wait')).members[0].outputUnchanged, true);
  const first = await f.call('team_read_result', { runId: 'research' });
  assert.deepEqual(await f.call('team_read_result', { runId: 'research' }), first);
  const result = await readAll(f, 'research');
  assert.ok(result.pages > 2); assert.equal(result.content, text);
  assert.equal((await readAll(f, 'research', { maxBytes: 1024 })).content, text);
  assert.equal((await readAll(f, 'research', { section: 'progress' })).content, '正在检查');
});

test('多成员状态也按整个 JSON 限额分页；未读取页面不会被误标为已通知', async () => {
  const f = fixture();
  for (let index = 0; index < 80; index++) f.member('member-' + index, '报告内容'.repeat(5000));
  let page = await f.call('team_wait');
  const received = new Set(page.members.map(item => item.runId));
  assert.equal(page.totalMembers, 80); assert.equal(page.pending, false); assert.equal(page.hasMore, true);
  const discardedCursor = page.nextCursor;
  page = await f.call('team_wait');
  assert.equal(page.reason, 'changed'); assert.ok(page.members.every(item => !received.has(item.runId) && !item.outputUnchanged));
  await assert.rejects(f.call('team_wait', { cursor: discardedCursor }), /失效/);
  while (true) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= TOOL_RESULT_BYTES);
    for (const item of page.members) received.add(item.runId);
    if (!page.hasMore) break;
    const args = { cursor: page.nextCursor };
    page = await f.call('team_wait', args);
    assert.deepEqual(await f.call('team_wait', args), page, '同页可重读');
  }
  assert.equal(received.size, 80);
  assert.ok((await f.call('team_wait')).members.every(item => item.outputUnchanged));
});

test('部门逐级读取与续聊重读有权限隔离，不能跨任务或读取孙团队', async () => {
  const f = fixture(), lead = f.member('lead', '部门总结'); lead.settings = { management: {} };
  const worker = f.member('engineer', '工程师完整成果', lead);
  await assert.rejects(f.call('team_read_result', { runId: worker.id }), /直接派发/);
  lead.status = 'running';
  assert.equal((await readAll(f, worker.id, {}, lead)).content, '工程师完整成果');
  await assert.rejects(f.call('team_read_result', { runId: lead.id }, lead), /直接派发/);
  const other = { ...f.manager, id: 'other', context: { taskId: 'other-task' } }; f.runs.set(other.id, other);
  const foreign = f.member('foreign', '其他任务保密成果', other);
  await assert.rejects(f.call('team_read_result', { runId: foreign.id }), /同一任务/);
  const next = { ...f.manager, id: 'next', parentRunId: f.manager.id }; f.runs.set(next.id, next);
  assert.equal((await readAll(f, lead.id, {}, next)).content, '部门总结');
  const branch = { ...next, id: 'branch', parentRunId: undefined }; f.runs.set(branch.id, branch);
  await assert.rejects(f.call('team_read_result', { runId: lead.id }, branch), /续聊历史/);
});

test('参数错误、串用及过期 cursor 明确拒绝，更新后的成果可重新读取', async () => {
  const f = fixture(), run = f.member('child', '完整内容'.repeat(2000)); f.member('other', '完整内容'.repeat(2000));
  const first = await f.call('team_read_result', { runId: run.id });
  for (const args of [{ runId: '' }, { runId: '../outside' }, { runId: run.id, section: 'secret' },
    { runId: run.id, maxBytes: 999 }, { runId: run.id, maxBytes: 9000 }, { runId: run.id, maxBytes: '6000' },
    { runId: run.id, cursor: 'bad' }, { runId: run.id, cursor: first.nextCursor.split(':')[0] + ':999999' },
    { runId: 'other', cursor: first.nextCursor }, { runId: run.id, section: 'progress', cursor: first.nextCursor }]) {
    await assert.rejects(f.call('team_read_result', args));
  }
  run.messages.at(-1).text += '更新';
  await assert.rejects(f.call('team_read_result', { runId: run.id, cursor: first.nextCursor }), /更新/);
  assert.equal((await readAll(f, run.id)).content, run.messages.at(-1).text);
  f.manager.cancelRequested = true;
  await assert.rejects(f.call('team_read_result', { runId: run.id }), /停止/);
});

test('长问题和错误只返回有标记的预览，可读取完整原文且仍受总大小约束', async () => {
  const f = fixture(), child = f.member('child', '成果'); child.status = 'running';
  const record = { requestId: 'question', memberRunId: child.id, managerRunId: f.manager.id, memberId: child.agentId, status: 'pending',
    question: '问题'.repeat(2000), context: '背景'.repeat(3000) };
  child.feedback = [record]; f.manager.feedback = [record]; child.error = '错误'.repeat(2000);
  const update = await f.call('team_wait');
  assert.ok(Buffer.byteLength(JSON.stringify(update)) <= TOOL_RESULT_BYTES);
  assert.equal(update.reason, 'feedback'); assert.equal(update.feedbackRequests[0].truncated, true);
  assert.equal(JSON.parse((await readAll(f, child.id, { section: 'feedback' })).content)[0].question, record.question);
  assert.equal((await readAll(f, child.id, { section: 'error' })).content, child.error);
  assert.equal((await f.call('team_wait')).feedbackRequests[0].requestId, record.requestId);
});

test('超出旧 10 万和 20 万字符限制的最终成果完整持久化，重启后仍能分段重读', async t => {
  const f = fixture(), child = f.member('child', ''); child.messages = [];
  const text = '完整开头\n' + '中文成果🙂'.repeat(40000) + '\n完整结尾';
  const event = (method, item) => updateRunMessages(child, { type: 'provider_event', method, params: { item: { id: 'long-answer', type: 'agentMessage', ...item } }, time: 'now' });
  event('item/started', { phase: 'final_answer' });
  for (let offset = 0; offset < text.length; offset += 20000) updateRunMessages(child, { type: 'message_delta', itemId: 'long-answer', delta: text.slice(offset, offset + 20000), time: 'now' });
  assert.equal(child.messages[0].text, text, '流式积累不能截取');
  event('item/completed', { phase: 'final_answer', text });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-result-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'runs.sqlite'); let store = createRunStore(filename);
  store.save(child, true); store.close(); store = createRunStore(filename);
  const loaded = store.load()[0]; store.close(); f.runs.set(child.id, loaded);
  assert.equal((await readAll(f, child.id)).content, text);
});

test('无 phase 的完成消息、旧输出、只有进展及空结果都明确区分', async () => {
  const f = fixture(), child = f.member('child', '自定义模型最终答复'); child.messages.at(-1).phase = null;
  assert.equal((await readAll(f, child.id)).content, '自定义模型最终答复');
  child.messages.pop();
  assert.equal((await f.call('team_read_result', { runId: child.id })).source, 'none');
  child.messages = [];
  assert.equal((await f.call('team_read_result', { runId: child.id })).source, 'legacy-mixed-output');
  child.output = '';
  const page = await f.call('team_read_result', { runId: child.id });
  assert.equal(page.content, ''); assert.equal(page.hasMore, false); assert.equal(page.nextCursor, null);
});
