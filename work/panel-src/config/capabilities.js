/* 能力选择与团队继承共用解析；只在派发时读取生效值，不改写历史执行快照。 */
const CAPABILITY_KEYS = ['skills', 'mcpServers'];

function normalizeCapabilityNames(values)
{
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()))];
}

function getCapabilityOptions(catalog)
{
  return {
    skills: normalizeCapabilityNames(catalog.skills.map(skill => typeof skill === 'string' ? skill : skill?.name || skill?.id || skill?.slug)),
    mcpServers: normalizeCapabilityNames(catalog.mcp.map(server => typeof server === 'string' ? server : server?.name || server?.serverName || server?.server?.name))
  };
}

function getCapabilitySelection(owner)
{
  return Object.fromEntries(CAPABILITY_KEYS.map(key => [key,
    owner.capabilitySelection?.[key] || (normalizeCapabilityNames(owner[key]).length ? 'custom' : 'all')
  ]));
}

function defaultTeamCapabilities()
{
  return { skills: [], mcpServers: [], capabilitySelection: { skills: 'all', mcpServers: 'all' } };
}

function resolveAgentConfiguration(agent, team)
{
  const connection = agent.connectionMode === 'team' ? { provider: team.provider, model: team.model || 'default' } : {};
  const capabilities = agent.capabilityMode === 'team' ? {
    skills: normalizeCapabilityNames(team.skills), mcpServers: normalizeCapabilityNames(team.mcpServers),
    capabilitySelection: getCapabilitySelection(team)
  } : {};
  return { ...agent, ...connection, ...capabilities };
}

/* 切换为独立配置时复制当前生效值，防止恢复隐藏的旧供应商或旧能力选择。 */
function setAgentConfigurationMode(agent, team, group, mode)
{
  const key = group === 'connection' ? 'connectionMode' : 'capabilityMode';
  if (!['connection', 'capabilities'].includes(group) || !['team', 'custom'].includes(mode)) throw new Error('成员配置模式无效');
  if (mode === 'team' || agent[key] !== 'team') return { ...agent, [key]: mode };
  const effective = resolveAgentConfiguration(agent, team);
  const values = group === 'connection' ? { provider: effective.provider, model: effective.model } : {
    skills: [...effective.skills], mcpServers: [...effective.mcpServers], capabilitySelection: { ...effective.capabilitySelection }
  };
  return { ...agent, ...values, [key]: mode };
}

function applyTeamSettingsToMembers(entry, group)
{
  return { ...entry, agents: entry.agents.map(agent => setAgentConfigurationMode(agent, entry.team, group, 'team')) };
}

function syncAgentCapabilities(owner, options)
{
  const selection = getCapabilitySelection(owner);
  let result = owner;
  for (const key of CAPABILITY_KEYS)
  {
    if (selection[key] !== 'all') continue;
    // 目录可能延迟、部分失败或暂时缺失；只补充，不丢弃已经记录的名称。
    const values = normalizeCapabilityNames([...(owner[key] || []), ...(options[key] || [])]);
    if (values.length !== (owner[key]?.length || 0) || values.some((value, index) => value !== owner[key][index]))
    {
      result = { ...result, [key]: values, capabilitySelection: selection };
    }
  }
  return result;
}

function syncConfigCapabilities(config, options)
{
  let changed = false;
  const teams = config.teams.map(entry =>
  {
    const team = syncAgentCapabilities(entry.team, options);
    const agents = entry.agents.map(agent =>
    {
      if (agent.capabilityMode !== 'team') return syncAgentCapabilities(agent, options);
      const effective = resolveAgentConfiguration(agent, team);
      const selection = getCapabilitySelection(agent);
      if (CAPABILITY_KEYS.every(key => selection[key] === effective.capabilitySelection[key]
        && (agent[key] || []).length === effective[key].length && effective[key].every((value, index) => value === agent[key][index]))) return agent;
      // 继承成员保留可导出的能力快照；页面展示仍从所属团队即时解析。
      return { ...agent, skills: effective.skills, mcpServers: effective.mcpServers, capabilitySelection: effective.capabilitySelection };
    });
    if (team === entry.team && agents.every((agent, index) => agent === entry.agents[index])) return entry;
    changed = true;
    return { ...entry, team, agents };
  });
  return changed ? { ...config, teams } : config;
}

function setCapabilities(owner, key, values, mode = 'custom')
{
  return { ...owner, [key]: normalizeCapabilityNames(values),
    capabilitySelection: { ...getCapabilitySelection(owner), [key]: mode } };
}

function setAgentCapabilities(agent, key, values, mode = 'custom')
{
  return { ...setCapabilities(agent, key, values, mode), capabilityMode: 'custom' };
}
