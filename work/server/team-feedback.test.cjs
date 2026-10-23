const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTeamFeedback } = require('./team-feedback.cjs');
const { memberCompletionError } = require('./delivery-contract.cjs');
const { feedbackNotifications } = require('./conversation-rounds.cjs');
const { jobFromRunEvent } = require('../shared/run-progress.js');
function fixture() {
  const manager = { id: 'm', agentId: 'pm', status: 'running', context: { taskId: 'task', agentName: '经理' }, settings: { management: { members: [{ id: 'pm' }, { id: 'a' }, { id: 'b' }] } } };
  const members = ['a', 'b'].map(id => ({ id, agentId: id, status: 'running', context: { taskId: 'task', coordinatorRunId: 'm', agentName: id } }));
  const runs = new Map([manager, ...members].map(run => [run.id, run])), events = [];
  const feedback = createTeamFeedback({ runs, timeoutMs: 100, emitRun(run, event) {
    run.feedback = [...(run.feedback || []).filter(item => item.requestId !== event.feedback.requestId), event.feedback];
    run.progress = jobFromRunEvent(run.progress, event); events.push(event);
  } });
  return { feedback, runs, manager, members, events, ask: (member = members[0], callId = 'call') => feedback.ask(member, { question: '接口约定？', context: '已检查实现' }, callId) };
}
test('两位成员同时提问、按问题回复且保留未处理问题；重复调用与相同答复重试幂等', async () => {
  const f = fixture(), [a, b] = f.members;
  const first = f.ask(a), repeated = f.ask(a), second = f.ask(b);
  assert.equal(first, repeated); assert.equal(f.manager.feedback.length, 2);
  assert.throws(() => f.ask(a, 'another'), /已有问题/);
  assert.throws(() => f.feedback.ask(a, { question: '不同问题' }, 'call'), /相同调用/);
  const [q1, q2] = f.feedback.requests(f.manager);
  assert.throws(() => f.feedback.reply(f.manager, { requestId: q1.requestId, answer: ' ' }), /答复必须/);
  const answer = { requestId: q2.requestId, answer: '使用已有格式' };
  assert.equal(f.feedback.reply(f.manager, answer).status, 'answered');
  assert.equal((await second).answer, answer.answer);
  assert.equal(f.feedback.requests(f.manager).length, 1);
  assert.equal(f.feedback.reply(f.manager, answer).status, 'answered');
  assert.throws(() => f.feedback.reply(f.manager, { ...answer, answer: '覆盖答复' }), /已回复/);
  f.feedback.reply(f.manager, { requestId: q1.requestId, answer: '保持向后兼容' });
  assert.equal((await first).answer, '保持向后兼容');
  assert.equal((await f.ask(a)).status, 'answered');
  assert.equal(f.events.filter(event => event.type === 'feedback_requested').length, 4);
});
test('反馈只允许本任务在运行的直属成员，跨任务、无成员资格和非法问题均拒绝', () => {
  const f = fixture(), member = f.members[0];
  assert.throws(() => f.feedback.ask(member, { question: '' }, 'call'), /问题必须/);
  assert.throws(() => f.feedback.ask(member, { question: 'x'.repeat(4001) }, 'call'), /问题必须/);
  member.context.taskId = 'other'; assert.throws(() => f.ask(), /不属于/);
  member.context.taskId = 'task'; member.agentId = 'outsider'; assert.throws(() => f.ask(), /不属于/);
  member.agentId = 'a'; member.status = 'completed'; assert.throws(() => f.ask(), /已结束/);
  assert.throws(() => f.feedback.reply(f.manager, { requestId: 'foreign', answer: '回复' }), /不属于/);
});
test('停止成员或经理会释放等待、取消定时器，迟到回复不能恢复工作', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), first = f.ask(), second = f.ask(f.members[1]);
  f.members[0].cancelRequested = true; f.feedback.synchronize();
  assert.equal((await first).status, 'cancelled');
  assert.equal(f.feedback.requests(f.manager).length, 1);
  f.manager.status = 'failed'; f.feedback.synchronize();
  assert.equal((await second).status, 'cancelled');
  const count = f.events.length; t.mock.timers.tick(1000); assert.equal(f.events.length, count);
  assert.throws(() => f.feedback.reply(f.manager, { requestId: f.manager.feedback[0].requestId, answer: '继续' }), /已结束/);
});
test('反馈超时产生通知、阻塞结果和验收限制，重新派发成功后才允许交付', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), answer = f.ask(); t.mock.timers.tick(101);
  const result = await answer;
  assert.equal(result.status, 'expired'); assert.equal(result.blocked, true);
  assert.equal(f.manager.feedback[0].status, 'expired');
  f.manager.createdAt = new Date().toISOString(); f.manager.goal = '测试任务';
  const notices = feedbackNotifications([[f.manager]]); assert.equal(notices.length, 1); assert.equal(notices[0].kind, 'feedback');
  const member = f.members[0]; member.status = 'completed';
  assert.match(memberCompletionError([member]), /反馈/);
  assert.equal(memberCompletionError([member, { agentId: member.agentId, status: 'completed' }]), '');
  assert.throws(() => f.feedback.reply(f.manager, { requestId: result.requestId, answer: '迟到' }), /超时/);
});
test('等待经理与用户审批分别显示，迟到普通输出不覆盖等待，答复后正常恢复', () => {
  let job = jobFromRunEvent({}, { type: 'feedback_requested', audience: 'member', feedback: { requestId: 'q' } });
  assert.equal(job.phase, 'waiting-manager'); assert.equal(job.status, 'waiting');
  job = jobFromRunEvent(job, { type: 'message_delta', delta: '补充进度' }); assert.equal(job.phase, 'waiting-manager');
  job = jobFromRunEvent(job, { type: 'approval_required', requestId: 'approval', runId: 'a' }); assert.match(job.activity, /确认/);
  job = jobFromRunEvent(job, { type: 'approval_resolved', requestId: 'approval', runId: 'a' }); assert.equal(job.phase, 'waiting-manager');
  job = jobFromRunEvent(job, { type: 'feedback_resolved', audience: 'member', feedback: { requestId: 'q', status: 'answered' } }); assert.equal(job.status, 'running');
  job = jobFromRunEvent(job, { type: 'completed', status: 'completed' });
  job = jobFromRunEvent(job, { type: 'feedback_requested', audience: 'member', feedback: { requestId: 'late' } }); assert.equal(job.status, 'done');
});
