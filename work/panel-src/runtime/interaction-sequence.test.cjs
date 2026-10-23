const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInteractionSequence, filterInteractionEvents } = require('./interaction-sequence.js');

const time = second => `2026-09-21T09:00:${String(second).padStart(2, '0')}Z`;
test('反馈按真实双方与时间生成单次提问/答复，超时不伪造经理回复', () => {
  const data = managed(), [manager, worker] = data.runs;
  const item = { requestId: 'q', managerId: 'manager', managerName: '项目经理', managerRunId: manager.runId,
    memberId: 'front', memberName: '前端', memberRunId: worker.runId, askedAt: time(10), answeredAt: time(12), resolvedAt: time(12),
    status: 'answered', question: '兼容旧接口吗？', context: '两处调用依赖', answer: '保留兼容' };
  manager.feedback = [{ ...item }]; worker.feedback = [{ ...item }];
  let sequence = buildInteractionSequence(data);
  const feedback = sequence.events.filter(event => event.id.startsWith('q:'));
  assert.equal(feedback.length, 2);
  assert.deepEqual(feedback.map(event => [event.from, event.to]), [['agent:front', 'agent:manager'], ['agent:manager', 'agent:front']]);
  assert.equal(feedback[0].roundNumber, 1); assert.equal(feedback[1].content, '保留兼容');
  manager.feedback[0].answeredAt = worker.feedback[0].answeredAt = worker.endedAt;
  sequence = buildInteractionSequence(data);
  assert.ok(sequence.events.findIndex(event => event.id === 'q:answer') < sequence.events.findIndex(event => event.id === worker.runId + ':result'));
  manager.feedback[0] = worker.feedback[0] = { ...item, status: 'expired', answeredAt: undefined };
  sequence = buildInteractionSequence(data);
  assert.equal(sequence.events.filter(event => event.title === '经理答复').length, 0);
  assert.equal(sequence.events.find(event => event.id === 'q:closed').from, 'system');
});
function run(runId, agentId, start, end, extra = {}) {
  return { runId, agentId, createdAt: time(start), endedAt: end == null ? null : time(end), status: end == null ? 'running' : 'completed',
    goal: '整体要求', context: { agentName: agentId }, output: `${agentId} 已完成`, ...extra };
}
function round(id, number, runs, extra = {}) {
  return { id, number, runIds: runs.map(run => run.runId), requestRunId: runs[0]?.runId, goal: '用户要求',
    attemptByRun: Object.fromEntries(runs.map(run => [run.runId, 1])), ...extra };
}
function managed() {
  const manager = run('m1', 'manager', 0, 50, { context: { agentName: '项目经理', dispatchMode: 'manager' }, coordination: { status: 'completed', summary: '已验收', artifacts: ['app.js'], verification: ['test: pass'] } });
  const front = run('f1', 'front', 5, 30, { context: { agentName: '前端', coordinatorRunId: 'm1', assignment: '实现页面' } });
  const back = run('b1', 'back', 6, 20, { context: { agentName: '后端', coordinatorRunId: 'm1', assignment: '实现接口' } });
  const runs = [manager, front, back];
  return { total: 3, runs, rounds: [round('r1', 1, runs)] };
}

test('按真实派发关系还原并行成员与返回，完成时间决定顺序，验收只交付一次', () => {
  const data = managed(), snapshot = JSON.stringify(data), sequence = buildInteractionSequence(data);
  assert.deepEqual(sequence.events.map(event => [event.from, event.to, event.kind]), [
    ['user', 'agent:manager', 'request'], ['agent:manager', 'agent:front', 'dispatch'], ['agent:manager', 'agent:back', 'dispatch'],
    ['agent:back', 'agent:manager', 'result'], ['agent:front', 'agent:manager', 'result'], ['agent:manager', 'user', 'delivery']
  ]);
  assert.equal(sequence.events[1].content, '实现页面');
  assert.deepEqual(sequence.events.at(-1).artifacts, ['app.js']);
  assert.deepEqual(sequence.events.at(-1).verification, ['test: pass']);
  assert.match(sequence.events[3].note, /未记录对方实际读取时间/);
  assert.equal(JSON.stringify(data), snapshot, '投影不可修改原始记录');
});

test('返工保留本轮执行次数，续聊进入下一轮并返回各自经理运行', () => {
  const data = managed();
  data.runs[1].status = 'failed';
  const redo = run('f2', 'front', 32, 40, { context: { agentName: '前端', coordinatorRunId: 'm1', assignment: '修复问题' }, parentRunId: 'f1' });
  data.runs.push(redo);
  data.rounds[0].runIds.push('f2'); data.rounds[0].attemptByRun.f2 = 2;
  const next = run('m2', 'manager', 51, 59, { parentRunId: 'm1', context: { agentName: '项目经理', dispatchMode: 'continuation' } });
  data.runs.push(next); data.rounds.push(round('r2', 2, [next]));
  const sequence = buildInteractionSequence(data);
  const rework = sequence.events.find(event => event.id === 'f2:request');
  assert.equal(rework.roundNumber, 1); assert.equal(rework.attempt, 2); assert.match(rework.title, /返工/);
  assert.equal(sequence.events.find(event => event.id === 'f1:result').kind, 'failure');
  const continuation = sequence.events.find(event => event.id === 'm2:request');
  assert.equal(continuation.roundNumber, 2); assert.equal(continuation.from, 'user'); assert.equal(continuation.title, '继续会话');
});

test('全员并行各自接收用户要求，接力使用 handoffFrom 而非伪造经理', () => {
  const a = run('a1', 'a', 0, 10, { context: { source: { kind: 'user' }, dispatchMode: 'parallel' } });
  const b = run('b1', 'b', 1, 12, { context: { source: { kind: 'user' }, dispatchMode: 'parallel' } });
  const c = run('c1', 'c', 13, 20, { context: { source: { kind: 'user' }, dispatchMode: 'sequential', handoffFrom: { agentId: 'a', name: '成员 A' } } });
  const sequence = buildInteractionSequence({ runs: [a, b, c], rounds: [round('r', 1, [a, b, c])] });
  assert.equal(sequence.events.find(event => event.id === 'b1:request').from, 'user');
  assert.equal(sequence.events.find(event => event.id === 'c1:request').from, 'agent:a');
  assert.equal(sequence.events.find(event => event.id === 'c1:request').title, '接力任务');
  assert.equal(sequence.events.find(event => event.id === 'c1:result').to, 'agent:a');
});

test('进行中不伪造返回或交付，失败和取消即使带旧交付信息也不会显示交付成功', () => {
  for (const status of ['running', 'failed', 'cancelled']) {
    const current = run('a1', 'a', 0, status === 'running' ? null : 10, { status, coordination: { status: 'completed', summary: '旧摘要' } });
    const events = buildInteractionSequence({ runs: [current], rounds: [round('r', 1, [current])] }).events;
    assert.equal(events.some(event => event.kind === 'delivery'), false);
    assert.equal(events.filter(event => event.response).length, status === 'running' ? 0 : 1);
    if (status !== 'running') assert.equal(events.at(-1).kind, 'failure');
  }
});

test('旧记录缺少时间与派发者时明确未知，不把 updatedAt 当作消息或结束时间', () => {
  const current = run('a1', 'a', 0, null, { status: 'completed', endedAt: null, updatedAt: time(50),
    context: { coordinatorRunId: 'missing' }, progress: { steps: [{ id: 'op', label: '执行命令', detail: 'npm test', output: '通过' }] } });
  const sequence = buildInteractionSequence({ total: 3, runs: [current], rounds: [round('r', 1, [current])] });
  assert.equal(sequence.events.find(event => event.kind === 'dispatch').from, 'unknown:missing');
  assert.equal(sequence.events.find(event => event.kind === 'operation').time, null);
  assert.equal(sequence.events.find(event => event.kind === 'result').time, null);
  assert.ok(sequence.warnings.some(text => text.includes('准确时间')));
  assert.ok(sequence.warnings.some(text => text.includes('1 / 3')));
  assert.match(sequence.events.find(event => event.kind === 'result').note, /合并输出/);
});

test('成员消息严格按运行归属隔离并去重，广播不假定任何特定接收者', () => {
  const data = managed();
  const direct = { id: 'chat1', runId: 'f1', fromAgentId: 'front', toAgentId: 'back', content: '接口字段待确认', createdAt: time(8) };
  const messages = [direct, direct, { ...direct, id: 'other', runId: 'unrelated' }, { ...direct, id: 'unlinked', runId: null },
    { ...direct, id: 'broadcast', toAgentId: null }, { ...direct, id: 'reply', fromAgentId: 'back', toAgentId: 'front', replyTo: 'chat1', createdAt: time(9) }];
  const sequence = buildInteractionSequence(data, messages), entries = sequence.events.filter(event => event.kind === 'message');
  assert.equal(entries.length, 3);
  assert.equal(entries.find(event => event.id === 'channel:broadcast').to, 'broadcast');
  assert.equal(entries.find(event => event.id === 'channel:reply').replyTo, 'chat1');
  assert.equal(sequence.actors.find(actor => actor.id === 'agent:back').name, '后端');
});

test('操作保留完整输入输出与失败状态，公开进展独立展示，不展示推理事件', () => {
  const current = run('a1', 'a', 0, 20, { messages: [
    { id: 'p', phase: 'commentary', text: '正在实现', startedAt: time(2) },
    { id: 'f', phase: 'final_answer', text: '已完成文件', startedAt: time(18) }
  ], progress: { steps: [{ id: 'tool', label: '执行命令', detail: 'npm test', output: 'failed\n完整输出', status: 'failed', startedAt: Date.parse(time(4)), endedAt: Date.parse(time(6)), exitCode: 1 }] },
  events: [{ type: 'provider_event', params: { item: { type: 'reasoning', text: '不要展示' } } }] });
  const data = { runs: [current], rounds: [round('r', 1, [current])] }, sequence = buildInteractionSequence(data);
  const operation = sequence.events.find(event => event.kind === 'operation');
  assert.equal(operation.from, operation.to); assert.equal(operation.exitCode, 1); assert.equal(operation.output, 'failed\n完整输出');
  assert.equal(sequence.events.find(event => event.kind === 'result').content, '已完成文件');
  assert.equal(sequence.events.filter(event => event.kind === 'progress').length, 1);
  assert.equal(JSON.stringify(sequence).includes('不要展示'), false);
  assert.equal(filterInteractionEvents(sequence).length, 2);
  assert.equal(filterInteractionEvents(sequence, { detailed: true }).length, 4);
});

test('筛选参与者包含发出和收到的交互，轮次筛选不混入其他轮次', () => {
  const data = managed(), next = run('m2', 'manager', 51, 59);
  data.runs.push(next); data.rounds.push(round('r2', 2, [next]));
  const sequence = buildInteractionSequence(data);
  const member = filterInteractionEvents(sequence, { actorId: 'agent:front' });
  assert.deepEqual(member.map(event => event.kind), ['dispatch', 'result']);
  assert.ok(filterInteractionEvents(sequence, { roundId: 'r2' }).every(event => event.runId === 'm2'));
  assert.equal(filterInteractionEvents(sequence, { roundId: 'missing' }).length, 0);
  assert.deepEqual(buildInteractionSequence(null).events, []);
});
