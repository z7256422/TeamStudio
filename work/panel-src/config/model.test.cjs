const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');

const context = vm.createContext({ crypto });
for (const file of ['constants.js', 'capabilities.js', 'team-presets.js', 'company-roles.js', 'company-template.js', 'model.js', '../runtime/team-management.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
}
const { makeTeam, validateConfig, collectAgentsInTree, clampTreeConcurrency, removeTeamFromTree } = context;
const providers = vm.runInContext('BUILTIN_PROVIDERS', context);
const fixture = () => {
  // 树模型用固定的三成员夹具，避免测试数量依赖产品默认团队模板。
  const teams = [0, 1, 2].map(index => {
    const entry = makeTeam(index);
    return { ...entry, team: { ...entry.team, concurrency: 3 },
      agents: Array.from({ length: 3 }, (_, agentIndex) => context.makeAgent(agentIndex)) };
  });
  return { version: 2, activeTeamId: teams[0].id, providers, teams };
};

test('默认软件团队可保存与导出，新建团队的成员配置互相独立', () => {
  const base = makeTeam(0);
  const config = validateConfig({ version: 2, providers, activeTeamId: base.id, teams: [base] });
  const team = config.teams[0];
  assert.equal(team.team.name, '软件开发团队');
  assert.equal(team.team.strategy, 'manager');
  assert.equal(team.team.concurrency, 1);
  assert.equal(team.team.sandbox, 'danger-full-access');
  assert.deepEqual(Array.from(team.agents, agent => agent.role), [
    'ProjectManager', 'FrontendEngineer', 'BackendEngineer', 'TestEngineer'
  ]);
  const example = validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '../../../outputs/example-team.json'), 'utf8')));
  const withoutId = ({ id, ...agent }) => agent;
  assert.deepEqual(JSON.parse(JSON.stringify(team.agents.map(withoutId))),
    JSON.parse(JSON.stringify(example.teams[0].agents.map(withoutId))));
  const another = makeTeam(1);
  assert.ok(another.agents.every(agent => !team.agents.some(first => first.id === agent.id)));
  another.agents[0].skills.push('example-skill');
  assert.equal(team.agents[0].skills.length, 0);
});

test('新版默认模板不覆盖浏览器已保存的团队及自定义指令', () => {
  const saved = fixture();
  saved.teams[0].team.name = '我的项目团队';
  saved.teams[0].agents[0].prompt = '保留我的自定义指令';
  saved.teams[0].team.sandbox = 'read-only';
  context.localStorage = { getItem: () => JSON.stringify(saved) };
  try {
    const loaded = context.loadConfig();
    assert.equal(loaded.saved, true);
    assert.equal(loaded.config.teams[0].team.name, '我的项目团队');
    assert.equal(loaded.config.teams[0].agents[0].prompt, '保留我的自定义指令');
    assert.equal(loaded.config.teams[0].team.sandbox, 'read-only');
    assert.equal(loaded.config.teams[0].agents.length, 3);
  } finally { delete context.localStorage; }
});

test('三种文件权限可导入导出，缺省默认无沙箱，未知值拒绝', () => {
  const config = fixture();
  ['danger-full-access', 'workspace-write', 'read-only'].forEach((mode, i) => { config.teams[i].team.sandbox = mode; });
  assert.deepEqual(Array.from(validateConfig(config).teams, entry => entry.team.sandbox), ['danger-full-access', 'workspace-write', 'read-only']);
  delete config.teams[0].team.sandbox;
  assert.equal(validateConfig(config).teams[0].team.sandbox, 'danger-full-access');
  config.teams[0].team.sandbox = 'typo';
  assert.throws(() => validateConfig(config), /文件权限/);
});

test('能力目录延迟到达与新增成员都会自动全选，重复刷新不改变配置', () => {
  const config = context.initialConfig();
  const empty = { skills: [], mcpServers: [] };
  assert.equal(context.syncConfigCapabilities(config, empty), config);
  const options = context.getCapabilityOptions({ skills: [{ name: 'build' }, { name: 'build' }, 'review'], mcp: [{ name: 'docs' }] });
  const synced = context.syncConfigCapabilities(config, options);
  for (const agent of synced.teams[0].agents) {
    assert.deepEqual(Array.from(agent.skills), ['build', 'review']);
    assert.deepEqual(Array.from(agent.mcpServers), ['docs']);
  }
  assert.equal(config.teams[0].agents[0].skills.length, 0, '不得改动撤销快照');
  assert.equal(context.syncConfigCapabilities(synced, options), synced);
  assert.equal(context.syncConfigCapabilities(synced, empty), synced, '目录失败或空响应不清空已有选择');
  synced.teams[0].agents.push(context.makeAgent(4));
  const next = context.syncConfigCapabilities(synced, options);
  assert.equal(next.teams[0].agents.at(-1).skills.length, 2);
});

test('手动取消后只锁定该分类，保存与重新导入不会勾回去', () => {
  const options = { skills: ['build', 'review'], mcpServers: ['docs'] };
  const config = context.syncConfigCapabilities(context.initialConfig(), options);
  const entry = config.teams[0];
  entry.agents[0] = context.setAgentCapabilities(entry.agents[0], 'skills', []);
  const saved = validateConfig(JSON.parse(JSON.stringify(config)));
  const next = context.syncConfigCapabilities(saved, { skills: ['build', 'review', 'new-skill'], mcpServers: ['docs', 'search'] });
  assert.equal(next.teams[0].agents[0].skills.length, 0);
  assert.equal(next.teams[0].agents[0].capabilitySelection.skills, 'custom');
  assert.deepEqual(Array.from(next.teams[0].agents[0].mcpServers), ['docs', 'search']);
  assert.equal(next.teams[0].agents[1].skills.length, 3, '其他成员仍自动全选');
  const restored = context.setAgentCapabilities(next.teams[0].agents[0], 'skills', [], 'all');
  assert.equal(context.syncAgentCapabilities(restored, options).skills.length, 2);
});

test('旧配置空列表使用默认全选，非空列表保留原来的手动选择', () => {
  const legacy = context.initialConfig();
  const agent = legacy.teams[0].agents[0];
  delete agent.capabilitySelection;
  delete agent.capabilityMode;
  delete agent.connectionMode;
  agent.skills = ['existing-skill'];
  const saved = validateConfig(legacy);
  const next = context.syncConfigCapabilities(saved, { skills: ['new-skill'], mcpServers: ['docs'] });
  assert.deepEqual(Array.from(next.teams[0].agents[0].skills), ['existing-skill']);
  assert.deepEqual(Array.from(next.teams[0].agents[0].mcpServers), ['docs']);
});

test('全选较大目录在保存时不会截断，刷新后仍保持一致', () => {
  const options = { skills: Array.from({ length: 125 }, (_, i) => `skill-${i}`), mcpServers: [] };
  const config = context.syncConfigCapabilities(context.initialConfig(), options);
  const saved = validateConfig(JSON.parse(JSON.stringify(config)));
  assert.equal(saved.teams[0].agents[0].skills.length, 125);
  assert.equal(context.syncConfigCapabilities(saved, options), saved);
});

test('导入配置拒绝无效能力选择模式', () => {
  for (const selection of [null, 'all', { skills: '' }, { mcpServers: 'invalid' }]) {
    const config = context.initialConfig();
    config.teams[0].agents[0].capabilitySelection = selection;
    assert.throws(() => validateConfig(config), /能力选择模式/);
  }
});

test('三层团队展开包含每个成员一次，允许成员选择不同 Provider', () => {
  const config = fixture();
  const [root, child, leaf] = config.teams;
  root.team.children = [child.id]; child.team.children = [leaf.id];
  leaf.agents[0].provider = 'claude-code';
  const saved = validateConfig(config);
  const members = collectAgentsInTree(saved.teams, root.id);
  assert.equal(members.length, 9);
  assert.equal(new Set(members.map(agent => agent.id)).size, 9);
  assert.equal(members.at(-3).provider, 'claude-code');
});

for (const [name, mutate, expected] of [
  ['自包含', ([root]) => { root.team.children = [root.id]; }, /不能包含自己/],
  ['重复包含', ([root, child]) => { root.team.children = [child.id, child.id]; }, /重复包含/],
  ['多父包含', ([root, child, leaf]) => { root.team.children = [leaf.id]; child.team.children = [leaf.id]; }, /多个父团队/],
  ['循环包含', ([root, child, leaf]) => { root.team.children = [child.id]; child.team.children = [leaf.id]; leaf.team.children = [root.id]; }, /循环/],
  ['悬空引用', ([root]) => { root.team.children = ['missing']; }, /不存在的子团队/]
]) test('阻止' + name, () => {
  const config = fixture(); mutate(config.teams);
  assert.throws(() => validateConfig(config), expected);
});

test('删除中间节点清理父引用，保留其后代为根节点，并调整祖先并发', () => {
  const config = fixture();
  const [root, child, leaf] = config.teams;
  root.team.children = [child.id]; child.team.children = [leaf.id]; root.team.concurrency = 9;
  const remaining = removeTeamFromTree(config.teams, child.id);
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].team.children.length, 0);
  assert.equal(remaining[0].team.concurrency, 3);
  assert.equal(remaining[1].id, leaf.id);
  assert.equal(root.team.children[0], child.id, '不应修改原配置，便于撤销');
  validateConfig({ ...config, teams: remaining });
});

test('减少下级成员后修正各级并发上限', () => {
  const config = fixture();
  const [root, child, leaf] = config.teams;
  root.team.children = [child.id]; child.team.children = [leaf.id];
  root.team.concurrency = 9; child.team.concurrency = 6;
  leaf.agents = leaf.agents.slice(0, 1);
  const next = clampTreeConcurrency(config.teams);
  assert.equal(next[0].team.concurrency, 7);
  assert.equal(next[1].team.concurrency, 4);
  assert.equal(next[2].team.concurrency, 1);
  validateConfig({ ...config, teams: next });
});

test('含循环的编辑草稿遍历能终止，正式保存仍拒绝循环', () => {
  const config = fixture(); const [root, child] = config.teams;
  root.team.children = [child.id]; child.team.children = [root.id];
  assert.equal(collectAgentsInTree(config.teams, root.id).length, 6);
  assert.throws(() => validateConfig(config), /循环/);
});

test('复制团队不复制关系和成员 ID，旧版单团队配置仍能迁移', () => {
  const config = fixture(); const [root, child] = config.teams;
  root.team.children = [child.id];
  root.team.concurrency = 6;
  const copy = makeTeam(3, root);
  assert.equal(copy.team.children.length, 0);
  assert.equal(copy.team.concurrency, copy.agents.length);
  validateConfig({ ...config, teams: [...config.teams, copy] });
  assert.ok(copy.agents.every(agent => !root.agents.some(original => original.id === agent.id)));
  const legacy = { version: 1, team: { ...root.team, children: [], concurrency: 3 }, agents: root.agents };
  assert.equal(validateConfig(legacy).teams.length, 1);
});

test('28 人公司有 7 个团队、唯一直属负责人、完整职责与单独可启动的子树', () => {
  const config = validateConfig(context.initialConfig());
  const exported = validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '../../../outputs/product-company.json'), 'utf8')));
  assert.deepEqual(JSON.parse(JSON.stringify(config.teams.map(entry => entry.agents.map(({ id, ...agent }) => agent)))),
    JSON.parse(JSON.stringify(exported.teams.map(entry => entry.agents.map(({ id, ...agent }) => agent)))), '可导入模板与界面岗位指令保持一致');
  assert.equal(config.teams.length, 7);
  assert.deepEqual(Array.from(config.teams, entry => entry.agents.length), [3, 4, 6, 4, 4, 4, 3]);
  assert.equal(collectAgentsInTree(config.teams, config.activeTeamId).length, 28);
  assert.equal(new Set(config.teams.flatMap(entry => entry.agents.map(agent => agent.id))).size, 28);
  assert.equal(config.teams[0].team.children.length, 6);
  const { parseManagement } = require('../../server/team-coordinator.cjs');
  const { dispatchableMembers } = require('../../server/team-hierarchy.cjs');
  for (const entry of config.teams) {
    const leader = entry.agents.find(agent => agent.id === entry.team.leaderId);
    assert.equal(leader.role, 'ProjectManager'); assert.equal(entry.agents.filter(agent => agent.role === 'ProjectManager').length, 1);
    assert.equal(entry.team.concurrency, 1);
    for (const member of entry.agents) {
      for (const text of ['接单输入', '职责边界', '交付与验收', '协作与反馈', 'team_ask_manager', '不能伪造']) assert.ok(member.prompt.includes(text), member.name + text);
      assert.ok(member.prompt.length < 16000); assert.equal(member.capabilitySelection.skills, 'all');
    }
    const snapshot = context.teamManagementSnapshot(entry.team, collectAgentsInTree(config.teams, entry.id), '', config.teams);
    const parsed = parseManagement(snapshot, leader.id);
    assert.equal(parsed.rootTeamId, entry.id);
    assert.equal(parsed.members.length, entry === config.teams[0] ? 28 : entry.agents.length);
    const allowed = dispatchableMembers(parsed, leader.id);
    assert.equal(allowed.length, entry === config.teams[0] ? 8 : entry.agents.length - 1);
  }
});

test('添加公司保留原团队和模型配置，实例 ID 独立，复制团队正确重映射负责人', () => {
  const old = fixture(), before = JSON.stringify(old);
  const next = context.addProductCompany(old, { provider: 'codex-app-server', model: 'my-model', cwd: 'D:/my-project' });
  assert.equal(next.teams.length, 10); assert.equal(JSON.stringify(old), before);
  assert.deepEqual(JSON.parse(JSON.stringify(next.teams.slice(0, 3))), JSON.parse(before).teams);
  const root = next.teams.find(entry => entry.id === next.activeTeamId);
  assert.equal(root.agents[0].model, 'my-model'); assert.equal(root.team.cwd, 'D:/my-project');
  const copy = makeTeam(10, root); assert.equal(copy.team.leaderId, copy.agents[0].id); assert.notEqual(copy.team.leaderId, root.team.leaderId);
  validateConfig({ ...next, teams: [...next.teams, copy] });
  const extra = context.addProductCompany(next);
  assert.equal(new Set(extra.teams.flatMap(entry => entry.agents.map(agent => agent.id))).size, 65);
});

test('子团队模型和目录独立配置；任务目录覆盖整树；负责人无效时明确拒绝', () => {
  const config = context.initialConfig(), root = config.teams[0], child = config.teams[1];
  root.team.model = 'root-model'; child.team.model = 'child-model'; child.team.cwd = 'D:/child';
  child.agents[1].provider = 'claude-code';
  child.agents[1].connectionMode = 'custom';
  let snapshot = context.teamManagementSnapshot(root.team, collectAgentsInTree(config.teams, root.id), '', config.teams);
  assert.equal(snapshot.members.find(member => member.id === child.agents[0].id).model, 'child-model');
  assert.equal(snapshot.members.find(member => member.id === child.agents[1].id).model, 'default');
  assert.equal(snapshot.members.find(member => member.id === child.agents[0].id).cwd, 'D:/child');
  snapshot = context.teamManagementSnapshot(root.team, collectAgentsInTree(config.teams, root.id), 'D:/task', config.teams);
  assert.ok(snapshot.members.every(member => member.cwd === 'D:/task'));
  child.team.leaderId = root.agents[0].id; assert.throws(() => validateConfig(config), /负责人/);
});


test('旧配置缺少继承标记时保留成员接口和能力，不被团队默认值覆盖', () =>
{
  const config = fixture(), entry = config.teams[0], member = entry.agents[0];
  delete member.connectionMode;
  delete member.capabilityMode;
  member.provider = 'claude-code';
  member.model = 'member-model';
  member.skills = ['member-skill'];
  member.capabilitySelection.skills = 'custom';
  entry.team.model = 'team-model';
  entry.team.skills = ['team-skill'];
  const saved = validateConfig(JSON.parse(JSON.stringify(config)));
  const effective = context.resolveAgentConfiguration(saved.teams[0].agents[0], saved.teams[0].team);
  assert.equal(effective.connectionMode, 'custom');
  assert.equal(effective.capabilityMode, 'custom');
  assert.equal(effective.provider, 'claude-code');
  assert.equal(effective.model, 'member-model');
  assert.deepEqual(Array.from(effective.skills), ['member-skill']);
});

test('新成员沿用团队接口与能力，切为独立配置复制当前值并与后续团队修改隔离', () =>
{
  const entry = makeTeam(0), member = context.makeAgent(4);
  entry.team.provider = 'claude-code';
  entry.team.model = 'shared-model';
  entry.team.skills = ['review'];
  entry.team.capabilitySelection.skills = 'custom';
  assert.equal(member.connectionMode, 'team');
  assert.equal(member.capabilityMode, 'team');
  let effective = context.resolveAgentConfiguration(member, entry.team);
  assert.equal(effective.provider, 'claude-code');
  assert.equal(effective.model, 'shared-model');
  assert.deepEqual(Array.from(effective.skills), ['review']);
  const customConnection = context.setAgentConfigurationMode(member, entry.team, 'connection', 'custom');
  const custom = context.setAgentConfigurationMode(customConnection, entry.team, 'capabilities', 'custom');
  assert.equal(custom.connectionMode, 'custom');
  assert.equal(custom.capabilityMode, 'custom');
  assert.notEqual(custom.skills, entry.team.skills);
  assert.notEqual(custom.capabilitySelection, entry.team.capabilitySelection);
  entry.team.model = 'updated-model';
  entry.team.skills.push('build');
  effective = context.resolveAgentConfiguration(custom, entry.team);
  assert.equal(effective.model, 'shared-model');
  assert.deepEqual(Array.from(effective.skills), ['review']);
  assert.equal(context.resolveAgentConfiguration(member, entry.team).model, 'updated-model');
  assert.equal(context.resolveAgentConfiguration(member, entry.team).skills.length, 2);
  assert.equal(member.provider, 'codex-app-server', '解析和切换不得改动源成员');
});

test('一键应用仅切换直属成员的配置来源，保留岗位、指令、目录与子团队', () =>
{
  const config = fixture(), [root, child] = config.teams;
  root.team.children = [child.id];
  for (const member of root.agents)
  {
    member.connectionMode = 'custom';
    member.capabilityMode = 'custom';
    member.cwd = 'D:/member';
    member.prompt = '保留岗位指令';
  }
  const before = JSON.stringify(config);
  let applied = context.applyTeamSettingsToMembers(root, 'connection');
  assert.ok(applied.agents.every(member => member.connectionMode === 'team' && member.capabilityMode === 'custom'));
  applied = context.applyTeamSettingsToMembers(applied, 'capabilities');
  assert.ok(applied.agents.every(member => member.capabilityMode === 'team' && member.cwd === 'D:/member' && member.prompt === '保留岗位指令'));
  assert.deepEqual(Array.from(applied.agents, member => member.role), Array.from(root.agents, member => member.role));
  assert.equal(applied.team, root.team);
  assert.equal(JSON.stringify(config), before, '原配置须可完整撤销');
  assert.equal(applied.team.children[0], child.id);
});

test('团队自定义空能力列表可保存导入，独立成员不受影响，恢复全选重新跟随目录', () =>
{
  let config = fixture();
  config.teams[0].team = context.setCapabilities(config.teams[0].team, 'skills', []);
  config.teams[0].agents[0] = context.setAgentCapabilities(config.teams[0].agents[0], 'skills', ['private-skill']);
  config = validateConfig(JSON.parse(JSON.stringify(config)));
  const options = { skills: ['build', 'review'], mcpServers: ['docs'] };
  let synced = context.syncConfigCapabilities(config, options);
  assert.equal(synced.teams[0].team.skills.length, 0);
  assert.equal(synced.teams[0].agents[1].skills.length, 0);
  assert.deepEqual(Array.from(synced.teams[0].agents[0].skills), ['private-skill']);
  assert.deepEqual(Array.from(synced.teams[0].agents[1].mcpServers), ['docs']);
  synced.teams[0].team = context.setCapabilities(synced.teams[0].team, 'skills', [], 'all');
  synced = context.syncConfigCapabilities(synced, options);
  const next = context.syncConfigCapabilities(synced, { ...options, skills: [...options.skills, 'new-skill'] });
  assert.deepEqual(Array.from(next.teams[0].agents[1].skills), ['build', 'review', 'new-skill']);
  assert.deepEqual(Array.from(next.teams[0].agents[0].skills), ['private-skill']);
  assert.equal(context.syncConfigCapabilities(next, options), next, '目录暂时缺失时保留已有选择且同步收敛');
  const saved = validateConfig(JSON.parse(JSON.stringify(next)));
  assert.equal(saved.teams[0].agents[1].capabilityMode, 'team');
  assert.equal(saved.teams[0].team.capabilitySelection.skills, 'all');
});

test('复制团队的共享能力与成员独立能力均不共用可变引用', () =>
{
  const entry = makeTeam(0);
  entry.team.skills.push('team-skill');
  entry.agents[0] = context.setAgentCapabilities(entry.agents[0], 'skills', ['member-skill']);
  const copy = makeTeam(1, entry);
  copy.team.skills.push('copy-only');
  copy.team.capabilitySelection.skills = 'custom';
  copy.agents[0].skills.push('copy-member');
  copy.agents[0].capabilitySelection.mcpServers = 'custom';
  assert.deepEqual(Array.from(entry.team.skills), ['team-skill']);
  assert.deepEqual(Array.from(entry.agents[0].skills), ['member-skill']);
  assert.equal(entry.team.capabilitySelection.skills, 'all');
  assert.equal(entry.agents[0].capabilitySelection.mcpServers, 'all');
});

test('树形任务与经理快照按成员所属团队解析接口，保存的历史快照不随团队变更', () =>
{
  const config = fixture(), [root, child] = config.teams;
  root.team.children = [child.id];
  root.team.model = 'root-model';
  child.team.provider = 'claude-code';
  child.team.model = 'child-model';
  child.team.skills = ['child-skill'];
  child.team.capabilitySelection.skills = 'custom';
  child.agents[1].connectionMode = 'custom';
  child.agents[1].provider = 'codex-app-server';
  child.agents[1].model = 'exception-model';
  const effective = context.collectEffectiveAgentsInTree(config.teams, root.id);
  const inherited = effective.find(member => member.id === child.agents[0].id);
  assert.equal(inherited.provider, 'claude-code');
  assert.equal(inherited.model, 'child-model');
  assert.deepEqual(Array.from(inherited.skills), ['child-skill']);
  assert.equal(effective.find(member => member.id === child.agents[1].id).model, 'exception-model');
  assert.equal(context.effectiveAgentModel(root.agents[0], root.team), 'root-model');
  const snapshot = context.teamManagementSnapshot(root.team, effective, '', config.teams);
  const frozen = snapshot.members.find(member => member.id === child.agents[0].id);
  assert.equal(frozen.provider, 'claude-code');
  assert.equal(frozen.model, 'child-model');
  assert.equal(frozen.connectionMode, undefined);
  child.team.provider = 'gemini-cli';
  child.team.model = 'future-model';
  assert.equal(frozen.model, 'child-model');
  assert.equal(frozen.provider, 'claude-code');
});

test('导入拒绝非法成员继承模式和团队能力模式', () =>
{
  for (const key of ['connectionMode', 'capabilityMode'])
  {
    for (const mode of ['', null, 'invalid', false])
    {
      const config = fixture();
      config.teams[0].agents[0][key] = mode;
      assert.throws(() => validateConfig(config), /成员配置模式/);
    }
  }
  for (const selection of [null, 'all', { skills: '' }, { mcpServers: 'invalid' }])
  {
    const config = fixture();
    config.teams[0].team.capabilitySelection = selection;
    assert.throws(() => validateConfig(config), /能力选择模式/);
  }
  const entry = makeTeam(0);
  assert.throws(() => context.setAgentConfigurationMode(entry.agents[0], entry.team, 'invalid', 'team'), /配置模式/);
  assert.throws(() => context.applyTeamSettingsToMembers(entry, 'invalid'), /配置模式/);
});
