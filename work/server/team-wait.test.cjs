const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTeamCoordinator } = require('./team-coordinator.cjs');
function fixture() {
  const manager = { id: 'pm', status: 'running', settings: { management: {} } };
  const member = { id: 'child', agentId: 'fe', status: 'running', context: { coordinatorRunId: 'pm', agentName: '前端' }, approvals: new Map(), output: '进展' };
  const runs = new Map([['pm', manager], ['child', member]]), events = [];
  const coordinator = createTeamCoordinator({ runs, emitRun: (_, event) => events.push(event) });
  return { manager, member, events, coordinator, wait: () => coordinator.call(manager, 'team_wait', {}) };
}
test('长时间无变化保持挂起，终态立即唤醒且不重复结果', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let settled = false;
  const pending = f.wait().then(result => { settled = true; return result; });
  t.mock.timers.tick(60 * 60 * 1000); await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.events.some(event => event.stage === 'reviewing'), false);
  f.member.status = 'completed'; f.member.output = '文件交付与验证结果'; f.coordinator.notifyRunChange(f.member);
  let result = await pending; assert.equal(result.reason, 'changed'); assert.equal(result.members[0].output, '文件交付与验证结果');
  result = await f.wait(); assert.equal(result.pending, false); assert.equal(result.members[0].outputUnchanged, true); assert.equal(result.members[0].output, '');
});
test('审批变更只唤醒一次，普通输出不打断等待，取消经理释放等待', async () => {
  const f = fixture();
  const pending = f.wait(); f.member.approvals.set('1', {}); f.coordinator.notifyRunChange();
  assert.equal((await pending).reason, 'changed');
  let settled = false;
  const stillWaiting = f.wait(); stillWaiting.then(() => { settled = true; }, () => {});
  f.member.output += 'more'; f.coordinator.notifyRunChange(f.member); await Promise.resolve();
  assert.equal(settled, false);
  f.manager.cancelRequested = true; f.coordinator.notifyRunChange(f.manager);
  await assert.rejects(stillWaiting, /结束或停止/);
});
