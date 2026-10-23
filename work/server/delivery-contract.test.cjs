const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UNACCEPTED_DELIVERY, resolveDeliveryMode, reportFromFinalAnswer, recoverReportDeliveries } = require('./delivery-contract.cjs');
const { createRunStore } = require('./run-store.cjs');

test('报告意图、明确开发要求和续聊类型分开判断，开发要求优先', () => {
  for (const goal of ['审查当前项目的代码质量，重点检查正确性、异常处理和可维护性，按影响程度给出建议。',
    '只给出修复建议，不要修改代码', '解释实现原理', '请解释这段代码的实现', '说明当前部署过程', '审查修复后的代码', '审查本次改动', 'Review this code without modifying files']) {
    assert.equal(resolveDeliveryMode(goal), 'report', goal);
  }
  for (const goal of ['审查代码并修复发现的问题', '实现一个代码分析功能', '生成审查报告并保存为 review.md',
    '审查代码, 不要修改 UI, 但请修复后端错误', '根据建议实施修复', 'Review and fix the error']) {
    assert.equal(resolveDeliveryMode(goal, 'report'), 'files', goal);
  }
  assert.equal(resolveDeliveryMode('继续', 'report'), 'report');
  assert.equal(resolveDeliveryMode('继续', 'files'), 'files');
});

test('普通问答不继承文件验收，礼貌请求和混合开发需求仍按实际任务处理', () => {
  for (const goal of ['你好', '你是什么模型？', '这个功能怎么用？', '你能做什么？', '我想知道如何修复这个问题',
    '如何实现登录？', '部署需要什么条件？', '你觉得开发这个功能有什么困难？', '实现登录有几种方案？',
    '能介绍一下团队吗？', '2+2', 'How can I fix this error?', 'Can you explain how to deploy it?']) {
    assert.equal(resolveDeliveryMode(goal, 'files'), 'reply', goal);
  }
  for (const goal of ['能帮我实现登录吗？', '请帮我创建网页，可以吗？', '帮我做一个页面', '请帮我把登录页面修改成蓝色',
    '先解释如何实现再帮我实现', '解释登录原理并实现登录页面', '怎么部署？请修改配置并部署', '实现登录并说明如何使用', 'Could you fix this error?', 'Please create a login page']) {
    assert.equal(resolveDeliveryMode(goal, 'reply'), 'files', goal);
  }
  assert.equal(resolveDeliveryMode('继续', 'reply'), 'reply');
  assert.equal(resolveDeliveryMode('继续吧', 'files'), 'files');
});

test('物理产品与界面设计要求实际成果，需求与方案工作包允许报告，设计咨询仍直接答复', () => {
  for (const goal of ['设计一款智能产品', '帮我设计外壳好吗？', '绘制电路原理图', '完成 PCB 布线', '制作交互原型', '帮我做一个产品', 'Design a PCB']) assert.equal(resolveDeliveryMode(goal), 'files', goal);
  for (const goal of ['整理产品需求', '给出外壳设计方案', '硬件可行性评估', '制定验收标准']) assert.equal(resolveDeliveryMode(goal), 'report', goal);
  for (const goal of ['如何设计外壳？', 'PCB 布线要注意什么？', '怎么制作原型？']) assert.equal(resolveDeliveryMode(goal), 'reply', goal);
});

const reportRun = () => ({ id: 'review', agentId: 'pm', goal: '审查代码质量并给出建议', status: 'failed', error: UNACCEPTED_DELIVERY,
  createdAt: '2026-09-21T08:00:00Z', endedAt: '2026-09-21T08:01:00Z',
  settings: { management: { members: [], concurrency: 1 } },
  delivery: { status: 'blocked', summary: UNACCEPTED_DELIVERY },
  progress: { status: 'failed', activity: '执行失败', error: UNACCEPTED_DELIVERY },
  messages: [{ id: 'final', phase: 'final_answer', text: 'P2：异常路径未恢复按钮。依据：app.js:10；运行验证未执行。', endedAt: '2026-09-21T08:01:00Z' }],
  events: [{ type: 'completed', runId: 'review', status: 'failed', message: UNACCEPTED_DELIVERY, turn: { status: 'completed' }, time: '2026-09-21T08:01:00Z' }] });

test('报告自动完成只接受有边界的最终消息，成员失败、未结束和审批均阻止完成', () => {
  const run = reportRun(); run.settings.management.deliveryMode = 'report';
  assert.ok(reportFromFinalAnswer(run, []));
  for (const status of ['running', 'waiting', 'failed', 'cancelled']) {
    assert.equal(reportFromFinalAnswer(run, [{ agentId: 'qa', status }]), null);
  }
  assert.ok(reportFromFinalAnswer(run, [{ agentId: 'qa', status: 'failed' }, { agentId: 'qa', status: 'completed' }]));
  run.approvals = new Map([['approval', {}]]); assert.equal(reportFromFinalAnswer(run, []), null); run.approvals.clear();
  run.messages[0].phase = 'commentary'; assert.equal(reportFromFinalAnswer(run, []), null);
  run.output = '已有输出，但无法确定是否最终报告'; run.messages = []; assert.equal(reportFromFinalAnswer(run, []), null);
});

test('旧版审查误判可持久恢复，正文、原时间与最终消息保持不变，重复加载幂等', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'report-store-'));
  const store = createRunStore(path.join(directory, 'runs.sqlite'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const original = reportRun(); store.save(original, true);
  const restored = store.load()[0];
  assert.equal(restored.status, 'completed'); assert.equal(restored.error, '');
  assert.equal(restored.progress.status, 'done'); assert.equal(restored.progress.error, '');
  assert.equal(restored.delivery.mode, 'report'); assert.equal(restored.delivery.recovered, true);
  assert.equal(restored.endedAt, original.endedAt); assert.deepEqual(restored.messages, original.messages);
  assert.equal(restored.events[0].status, 'completed');
  store.save(restored, true);
  assert.deepEqual(store.load()[0], restored);
});

test('旧记录修正不掩盖真实失败、开发未交付、缺失最终消息或失败成员', () => {
  const changes = [
    run => { run.error = 'Actual engine error'; },
    run => { run.events[0].turn.status = 'failed'; },
    run => { run.goal = '修复这些代码问题'; },
    run => { run.messages[0].phase = 'commentary'; },
    run => { run.messages = []; },
    run => { run.settings.management.deliveryMode = 'files'; }
  ];
  for (const change of changes) {
    const run = reportRun(); change(run);
    assert.equal(recoverReportDeliveries([run])[0].status, 'failed');
  }
  const run = reportRun();
  recoverReportDeliveries([run, { agentId: 'qa', status: 'failed', context: { coordinatorRunId: run.id } }]);
  assert.equal(run.status, 'failed');
});

test('自定义模型无 phase 时需要引擎成功和完整消息，不能把中途消息当最终答复', () => {
  const replyRun = () => {
    const run = reportRun(); run.status = 'completed'; run.error = ''; run.settings.management.deliveryMode = 'reply';
    run.messages[0].phase = null;
    run.events = [{ type: 'provider_event', method: 'item/completed', params: { item: { id: 'final', type: 'agentMessage' } } }];
    return run;
  };
  const completed = reportFromFinalAnswer(replyRun(), []);
  assert.equal(completed.mode, 'reply'); assert.deepEqual(completed.artifacts, []); assert.deepEqual(completed.verification, []);
  for (const change of [
    run => { run.status = 'failed'; run.error = 'engine failed'; },
    run => { run.status = 'cancelled'; },
    run => { run.cancelRequested = true; },
    run => { run.messages[0].phase = 'commentary'; },
    run => { delete run.messages[0].endedAt; },
    run => { run.messages[0].text = ' '; },
    run => { run.events = []; },
    run => { run.events.push({ type: 'tool_output', delta: 'still working' }); },
    run => { run.events.push({ type: 'provider_event', method: 'item/started', params: { item: { type: 'commandExecution' } } }); },
    run => { run.messages.push({ id: 'next', text: 'still working' }); },
    run => { run.approvals = new Map([['pending', {}]]); }
  ]) {
    const run = replyRun(); change(run); assert.equal(reportFromFinalAnswer(run, []), null, change.toString());
  }
  for (const child of [{ status: 'running' }, { status: 'waiting' }, { status: 'failed' }, { status: 'cancelled' },
    { status: 'completed', feedback: [{ status: 'expired' }] }, { status: 'completed', approvals: new Map([['pending', {}]]) }]) {
    assert.equal(reportFromFinalAnswer(replyRun(), [{ agentId: 'qa', ...child }]), null);
  }
  const run = replyRun(); run.messages.push({ id: 'legacy-stream', text: '' }); run.events.push({ type: 'message_delta', delta: '' });
  assert.ok(reportFromFinalAnswer(run, []), '兼容最后一个空增量，不丢失完整答复');
});

test('旧版明确问答的验收误判恢复为已回复，真实失败和开发记录仍保留', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-store-'));
  const store = createRunStore(path.join(directory, 'runs.sqlite'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const original = reportRun(); original.goal = '你是什么模型？'; original.settings.management.deliveryMode = 'files';
  original.messages[0].text = '我是团队中负责协调和解答问题的项目经理。';
  store.save(original, true);
  const restored = store.load()[0];
  assert.equal(restored.status, 'completed'); assert.equal(restored.progress.status, 'done');
  assert.equal(restored.settings.management.deliveryMode, 'reply'); assert.equal(restored.delivery.mode, 'reply');
  assert.equal(restored.delivery.reply, original.messages[0].text); assert.equal(restored.delivery.recovered, true);
  assert.equal(restored.id, original.id); assert.equal(restored.endedAt, original.endedAt); assert.deepEqual(restored.messages, original.messages);
  store.save(restored, true); assert.deepEqual(store.load()[0], restored);
  for (const change of [
    run => { run.events[0].turn.status = 'failed'; },
    run => { run.error = 'connection failed'; },
    run => { run.goal = '能帮我修复登录错误吗？'; },
    run => { run.messages[0].phase = 'commentary'; },
    run => { run.status = 'cancelled'; }
  ]) {
    const run = structuredClone(original); change(run); recoverReportDeliveries([run]); assert.notEqual(run.status, 'completed');
  }
});
