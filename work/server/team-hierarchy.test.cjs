const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseManagement } = require('./team-coordinator.cjs');
const { dispatchableMembers, delegatedManagement } = require('./team-hierarchy.cjs');
const { prepareTeamThread, TEAM_PROTOCOL_VERSION } = require('./team-thread.cjs');
const fixture = () => ({ rootTeamId: 'company', concurrency: 1,
  members: ['pm', 'lead', 'dev', 'qa'].map(id => ({ id, name: id, role: ['pm', 'lead'].includes(id) ? 'ProjectManager' : 'Engineer', provider: 'codex-app-server' })),
  teams: [{ id: 'company', name: '公司', leaderId: 'pm', memberIds: ['pm', 'qa'], children: ['software'], concurrency: 1 },
    { id: 'software', name: '软件', leaderId: 'lead', memberIds: ['lead', 'dev'], children: [], concurrency: 1 }] });

test('分级花名册只允许直属成员与下级负责人，裁剪后无法访问兄弟或父级', () => {
  const management = parseManagement(fixture(), 'pm');
  assert.deepEqual(dispatchableMembers(management, 'pm').map(member => member.id), ['lead', 'qa']);
  const child = parseManagement(delegatedManagement(management, 'lead'), 'lead');
  assert.equal(child.rootTeamId, 'software'); assert.equal(child.teams.length, 1);
  assert.deepEqual(child.members.map(member => member.id), ['lead', 'dev']);
  assert.deepEqual(dispatchableMembers(child, 'lead').map(member => member.id), ['dev']);
  assert.equal(delegatedManagement(management, 'qa'), null);
});

test('服务端拒绝重复归属、多父、自包含、循环、悬空、孤立及错误负责人', () => {
  for (const mutate of [
    input => { input.teams[0].children.push('software'); },
    input => { input.teams[1].children = ['company']; },
    input => { input.teams[1].children = ['software']; },
    input => { input.teams[0].children = ['missing']; },
    input => { input.teams[0].children = []; },
    input => { input.teams[0].memberIds.push('dev'); },
    input => { input.teams[1].leaderId = 'dev'; },
    input => { input.teams[1].leaderId = 'pm'; },
    input => { input.rootTeamId = 'software'; },
    input => { input.teams[1].concurrency = 0; },
    input => { input.teams[0].memberIds.pop(); }
  ]) { const input = fixture(); mutate(input); assert.throws(() => parseManagement(input, 'pm'), undefined, mutate.toString()); }
});

test('负责人从普通成员升级或由独立转被派发时迁移工具，稳定角色续聊保留原线程', () => {
  const previous = { id: 'run', agentId: 'lead', threadId: 'thread', settings: { teamProtocolVersion: TEAM_PROTOCOL_VERSION, management: {} }, output: '原始结果' };
  const runs = new Map([[previous.id, previous]]);
  let next = prepareTeamThread(runs, { agentId: 'lead', threadId: 'thread', enabled: true, toolRole: 'leader' });
  assert.equal(next.threadId, undefined); assert.match(next.instructions, /原始结果/);
  previous.settings.teamToolRole = 'leader';
  next = prepareTeamThread(runs, { agentId: 'lead', threadId: 'thread', enabled: true, toolRole: 'leader' });
  assert.equal(next.threadId, 'thread'); assert.equal(next.migration, null);
});
