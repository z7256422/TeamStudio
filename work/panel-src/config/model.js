/* 配置模型、默认值、迁移和持久化。页面只通过这些函数读写配置。 */
function makeAgent(index)
{
  return { id: crypto.randomUUID(), name: `Agent ${index + 1}`, role: 'Custom', description: '', model: 'default', provider: 'codex-app-server', cwd: '', prompt: '', connectionMode: 'team', capabilityMode: 'team', ...defaultTeamCapabilities() };
}
function makeTeam(index, source = null) {
  const teamSource = source?.team || source;
  const team = teamSource ? JSON.parse(JSON.stringify(teamSource)) : {
    name: index === 0 ? '软件开发团队' : `软件开发团队 ${index + 1}`,
    concurrency: 1,
    strategy: 'manager',
    provider: 'codex-app-server',
    model: 'default',
    cwd: '',
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
    children: [],
    ...defaultTeamCapabilities()
  };
  const agents = source?.agents ? source.agents.map(agent => ({ ...JSON.parse(JSON.stringify(agent)), id: crypto.randomUUID() })) : makeSoftwareDevelopmentAgents();
  const leaderId = source?.team?.leaderId ? agents[source.agents.findIndex(agent => agent.id === source.team.leaderId)]?.id : undefined;
  // 复制团队时不复制子团队关系，避免把原树上的节点隐式重复包含。
  const children = source ? [] : (Array.isArray(team.children) ? [...team.children] : []);
  return { id: crypto.randomUUID(), team: { ...team, ...(team.leaderId ? { leaderId } : {}), name: source ? `${team.name} 副本` : team.name,
    concurrency: source ? Math.min(team.concurrency, agents.length) : team.concurrency, children }, agents };
}
function initialConfig() {
  return makeProductCompany();
}

// 草稿也可能含无效关系；遍历使用 visited，防止编辑期间循环或重复统计。
function collectAgentsInTree(teams, rootId) {
  const entries = new Map(teams.map(entry => [entry.id, entry]));
  const visited = new Set();
  const agents = new Map();
  const visit = id => {
    if (visited.has(id)) return;
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) return;
    entry.agents.forEach(agent => agents.set(agent.id, agent));
    (entry.team.children || []).forEach(visit);
  };
  visit(rootId);
  return [...agents.values()];
}

/* 子团队始终使用自己的默认设置；上级发起任务时也按实际归属解析。 */
function collectEffectiveAgentsInTree(teams, rootId)
{
  const owners = new Map(teams.flatMap(entry => entry.agents.map(agent => [agent.id, entry.team])));
  return collectAgentsInTree(teams, rootId).map(agent => resolveAgentConfiguration(agent, owners.get(agent.id)));
}

// 子树移除成员或关系时，祖先可用人数也会变化，需要一起收紧并发数。
function clampTreeConcurrency(teams) {
  return teams.map(entry => ({ ...entry, team: { ...entry.team,
    concurrency: Math.min(entry.team.concurrency, collectAgentsInTree(teams, entry.id).length)
  } }));
}

function removeTeamFromTree(teams, teamId) {
  // 删除一个节点，不删除它的子树；子节点自然成为根节点。
  return clampTreeConcurrency(teams.filter(entry => entry.id !== teamId).map(entry => ({
    ...entry, team: { ...entry.team, children: (entry.team.children || []).filter(id => id !== teamId) }
  })));
}

// 将旧版单团队配置迁移为多团队结构；导出与保存统一使用 version 2。
function validateConfig(data) {
  const fail = message => { throw new Error(message); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const str = (value, label, max, required = true) => {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}须为${required ? '非空' : ''}文本，最多 ${max} 字符`);
    return value;
  };
  const capabilities = owner =>
  {
    if (owner.capabilitySelection !== undefined && !object(owner.capabilitySelection)) fail('能力选择模式须为对象');
    CAPABILITY_KEYS.forEach(key =>
    {
      const mode = owner.capabilitySelection?.[key];
      if (mode !== undefined && !['all', 'custom'].includes(mode)) fail('能力选择模式须为 all 或 custom');
    });
    return { skills: normalizeCapabilityNames(owner.skills), mcpServers: normalizeCapabilityNames(owner.mcpServers), capabilitySelection: getCapabilitySelection(owner) };
  };
  if (!object(data)) fail('配置必须是 JSON 对象');
  let source = data;
  if (data.version === 1 && object(data.team) && Array.isArray(data.agents)) {
    const migrated = makeTeam(0);
    migrated.team = data.team;
    migrated.agents = data.agents;
    source = { version: 2, activeTeamId: migrated.id, providers: BUILTIN_PROVIDERS, teams: [migrated] };
  }
  if (source.version !== 2 || !Array.isArray(source.teams) || !source.teams.length || source.teams.length > MAX_TEAMS) fail(`需要 version: 2 和 1–${MAX_TEAMS} 个团队`);
  const providers = (Array.isArray(source.providers) ? source.providers : BUILTIN_PROVIDERS).map((provider, i) => ({
    id: str(provider.id, `第 ${i + 1} 个 Provider ID`, 120),
    kind: str(provider.kind || 'custom', 'Provider 类型', 40),
    label: str(provider.label || provider.id, 'Provider 名称', 120),
    status: str(provider.status || 'configured', 'Provider 状态', 40)
  }));
  const providerIds = new Set(providers.map(provider => provider.id));
  const teamIds = new Set();
  const allAgentIds = new Set();
  const teams = source.teams.map((entry, teamIndex) => {
    if (!object(entry) || !object(entry.team) || !Array.isArray(entry.agents) || !entry.agents.length || entry.agents.length > MAX_AGENTS) fail(`第 ${teamIndex + 1} 个团队格式无效`);
    const id = str(entry.id || crypto.randomUUID(), '团队 ID', 120);
    if (teamIds.has(id)) fail('团队 ID 不能重复');
    teamIds.add(id);
    const teamData = entry.team;
    if (teamData.sandbox && !['danger-full-access', 'workspace-write', 'read-only'].includes(teamData.sandbox)) fail('文件权限必须为 danger-full-access、workspace-write 或 read-only');
    const name = str(teamData.name, '团队名称', 80);
    const concurrency = teamData.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_AGENTS) fail(`团队「${name}」的并发数无效`);
    if (!Object.hasOwn(STRATEGIES, teamData.strategy)) fail(`团队「${name}」的协作方式无效`);
    const ids = new Set();
    const agents = entry.agents.map((agent, i) => {
      if (!object(agent)) fail(`团队「${name}」第 ${i + 1} 个成员格式无效`);
      const agentId = str(agent.id || crypto.randomUUID(), '成员 ID', 100);
      if (ids.has(agentId)) fail(`团队「${name}」的成员 ID 不能重复`);
      if (allAgentIds.has(agentId)) fail(`成员 ID「${agentId}」不能跨团队重复`);
      ids.add(agentId);
      allAgentIds.add(agentId);
      const provider = str(agent.provider || teamData.provider || 'codex-app-server', 'Provider 标识', 120);
      if (!providerIds.has(provider)) fail(`Provider「${provider}」未在 providers 中登记`);
      // 缺少继承标记的旧配置保留原独立设置，只有用户明确应用才改为团队继承。
      for (const key of ['connectionMode', 'capabilityMode'])
      {
        if (agent[key] !== undefined && !['team', 'custom'].includes(agent[key])) fail('成员配置模式须为 team 或 custom');
      }
      const connectionMode = agent.connectionMode || 'custom', capabilityMode = agent.capabilityMode || 'custom';
      return { id: agentId, name: str(agent.name, '成员名称', 80), role: str(agent.role, '角色标识', 80), description: str(agent.description, '职责描述', 1000, false), model: str(agent.model || 'default', '模型标识', 120), provider, cwd: str(agent.cwd || '', '工作目录', 400, false), prompt: str(agent.prompt, '系统指令', 16000, false), connectionMode, capabilityMode, ...capabilities(agent) };
    });
    const defaultProvider = str(teamData.provider || 'codex-app-server', '默认 Provider', 120);
    const leaderId = teamData.leaderId ? str(teamData.leaderId, '负责人 ID', 100) : null;
    if (leaderId && !agents.some(agent => agent.id === leaderId && agent.role === 'ProjectManager')) fail(`团队「${name}」的负责人必须是直属的 ProjectManager 成员`);
    if (!providerIds.has(defaultProvider)) fail(`团队「${name}」的默认 Provider「${defaultProvider}」未登记`);
    const children = Array.isArray(teamData.children) ? teamData.children.filter(item => typeof item === 'string') : [];
    if (new Set(children).size !== children.length) fail(`团队「${name}」不能重复包含同一个子团队`);
    return { id, team: { sandbox: teamData.sandbox || 'danger-full-access', name, concurrency, strategy: teamData.strategy, provider: defaultProvider, model: str(teamData.model || 'default', '默认模型', 120), cwd: str(teamData.cwd || '', '默认工作目录', 400, false), approvalPolicy: str(teamData.approvalPolicy || 'on-request', '审批策略', 80), children, ...capabilities(teamData), ...(leaderId ? { leaderId } : {}) }, agents };
  });
  const parentByChild = new Map();
  teams.forEach(entry => (entry.team.children || []).forEach(childId => {
    if (!teamIds.has(childId)) fail(`团队「${entry.team.name}」包含了不存在的子团队`);
    if (childId === entry.id) fail(`团队「${entry.team.name}」不能包含自己`);
    if (parentByChild.has(childId) && parentByChild.get(childId) !== entry.id) fail('同一个子团队不能被多个父团队重复包含');
    parentByChild.set(childId, entry.id);
  }));
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) fail('团队包含关系不能形成循环');
    if (visited.has(id)) return;
    visiting.add(id);
    const entry = teams.find(item => item.id === id);
    (entry?.team.children || []).forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  teams.forEach(entry => visit(entry.id));
  const countAgents = rootId => {
    const entry = teams.find(item => item.id === rootId);
    return (entry?.agents.length || 0) + (entry?.team.children || []).reduce((total, childId) => total + countAgents(childId), 0);
  };
  teams.forEach(entry => { if (entry.team.concurrency > countAgents(entry.id)) fail(`团队「${entry.team.name}」的并发数不能超过它包含的 Agent 数量`); });
  const activeTeamId = teamIds.has(source.activeTeamId) ? source.activeTeamId : teams[0].id;
  return { version: 2, activeTeamId, providers, teams };
}
function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return { config: raw ? validateConfig(JSON.parse(raw)) : initialConfig(), warning: '', saved: Boolean(raw) };
  } catch (error) {
    return { config: initialConfig(), warning: `无法恢复本地配置：${error.message}。已加载示例团队；原数据尚未覆盖。`, saved: false };
  }
}
