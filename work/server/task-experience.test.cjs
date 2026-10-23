const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { conversationRounds, deliveryNotifications } = require('./conversation-rounds.cjs');
const { updateRunMessages } = require('../shared/run-activity.js');
const { jobFromRunEvent } = require('../shared/run-progress.js');
const { createRunStore } = require('./run-store.cjs');
const run = (id, overrides = {}) => ({ id, agentId: 'pm', goal: '原任务', createdAt: '2026-09-20T10:00:00Z', status: 'completed', context: { taskId: 'task', source: { kind: 'user' }, dispatchMode: 'manager' }, ...overrides });
const worker = (id, parent, overrides = {}) => run(id, { agentId: 'fe', context: { taskId: 'task', coordinatorRunId: parent, dispatchMode: 'delegated', source: { kind: 'agent' } }, ...overrides });

test('经理派发与已完成成员返工归入原轮，用户续聊才增加轮数', () => {
  const chain = [run('pm1'), worker('fe1', 'pm1'), worker('fe2', 'pm1'), run('pm2', { context: { taskId: 'task', dispatchMode: 'continuation', roundId: 'second', taskTitle: '修改要求' } }), worker('fe3', 'pm2')];
  const rounds = conversationRounds(chain);
  assert.equal(rounds.length, 2); assert.deepEqual(rounds[0].runIds, ['pm1', 'fe1', 'fe2']);
  assert.equal(rounds[0].attemptByRun.fe2, 2); assert.equal(rounds[1].attemptByRun.fe3, 1);
  assert.equal(rounds[1].goal, '修改要求');
});
test('旧并行与接力记录算一轮，普通单线程续聊仍按用户次数计数', () => {
  assert.equal(conversationRounds(['a','b','c'].map(id => run(id, { context: { taskId: 'legacy', dispatchMode: 'sequential' } }))).length, 1);
  assert.equal(conversationRounds([run('a', { context: null }), run('b', { context: { dispatchMode: 'continuation' } })]).length, 2);
});
test('成员完成不通知交付；经理验收并结束后每轮只通知一次，返工再次完成可产生新通知', () => {
  const manager = run('pm1', { status: 'running', settings: { management: {} }, delivery: { status: 'completed', summary: '实际交付', artifacts: ['file.txt'] } });
  const chain = [manager, worker('fe1', 'pm1')];
  assert.equal(deliveryNotifications([chain]).length, 0);
  manager.status = 'completed'; manager.endedAt = '2026-09-20T11:00:00Z';
  const first = deliveryNotifications([chain]); assert.equal(first.length, 1); assert.equal(first[0].createdAt, manager.endedAt);
  assert.deepEqual(deliveryNotifications([chain]), first);
  chain.push(run('pm2', { context: { taskId: 'task', dispatchMode: 'continuation' }, settings: manager.settings, delivery: manager.delivery }));
  assert.equal(deliveryNotifications([chain]).length, 2);
  assert.equal(deliveryNotifications([[run('old-plan')]]).length, 0);
});
test('公开消息保留边界、阶段、时间并持久化；不收集推理内容', t => {
  const manager = run('pm');
  updateRunMessages(manager, { type: 'message_delta', itemId: 'm1', delta: '正在检查', time: '2026-09-20T10:01:00Z' });
  updateRunMessages(manager, { type: 'provider_event', method: 'item/completed', time: '2026-09-20T10:02:00Z', params: { item: { type: 'agentMessage', id: 'm1', phase: 'commentary', text: '正在检查' } } });
  updateRunMessages(manager, { type: 'provider_event', method: 'item/completed', time: '2026-09-20T10:03:00Z', params: { item: { type: 'agentMessage', id: 'm2', phase: 'final_answer', text: '已完成文件' } } });
  updateRunMessages(manager, { type: 'provider_event', method: 'item/completed', params: { item: { type: 'reasoning', id: 'secret', text: 'private reasoning' } } });
  assert.equal(manager.messages.length, 2); assert.equal(manager.messages[0].text, '正在检查'); assert.equal(manager.messages[1].phase, 'final_answer');
  assert.equal(manager.messages[0].startedAt, '2026-09-20T10:01:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-activity-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createRunStore(path.join(dir, 'runs.sqlite')); store.save(manager, true); const restored = store.load()[0]; store.close();
  assert.deepEqual(restored.messages, manager.messages);
});
test('操作记录分别保留开始、结束与失败结果', () => {
  const item = { id: 'command', type: 'commandExecution', command: 'node --test' };
  let job = jobFromRunEvent({}, { type: 'provider_event', method: 'item/started', time: '2026-09-20T10:00:00Z', params: { item } });
  job = jobFromRunEvent(job, { type: 'provider_event', method: 'item/completed', time: '2026-09-20T10:01:00Z', params: { item: { ...item, exitCode: 1 } } });
  assert.equal(job.steps[0].endedAt - job.steps[0].startedAt, 60000); assert.equal(job.steps[0].status, 'failed');
});
test('串行队列尚未启动下一成员时，不提前发出整轮完成通知', () => {
  const first = run('fe', { agentId: 'fe', context: { taskId: 'task', dispatchMode: 'sequential', expectedAgentIds: ['fe','qa'] } });
  assert.equal(deliveryNotifications([[first]]).length, 0);
  assert.equal(conversationRounds([first])[0].status, 'failed', '旧队列缺成员不能标记完成');
  const last = run('qa', { agentId: 'qa', context: first.context });
  assert.equal(deliveryNotifications([[first, last]]).length, 1);
});
test('权限摘要同时显示具体命令、工作目录、读写路径与网络范围', () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname, '../panel-src/runtime/approval-details.js'), 'utf8'), context);
  const fields = context.approvalDetails({ method: 'item/commandExecution/requestApproval', context: { taskTitle: '文件验证' }, params: { command: 'node --test', cwd: 'C:/workspace', reason: '检查文件', additionalPermissions: { fileSystem: { write: ['C:/workspace/file'] }, network: { enabled: true } } } });
  assert.ok(fields.some(([label, value]) => label === '执行命令' && value === 'node --test'));
  assert.ok(fields.some(([label, value]) => label === '完整权限范围' && value.includes('C:/workspace/file') && value.includes('network')));
  assert.ok(fields.some(([label, value]) => label === '额外写入路径' && value === 'C:/workspace/file'));
  assert.ok(fields.some(([label, value]) => label === '工作目录' && value === 'C:/workspace'));
});
