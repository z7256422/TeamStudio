/* 检测与执行使用相同优先级，空白配置不能遮蔽成员或团队目录。 */
function effectiveWorkingDirectory(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

/* 冻结实际派发花名册，续聊由服务端沿用快照；团队后续编辑不会悄悄改变成员。 */
function effectiveAgentModel(agent, team)
{
  agent = resolveAgentConfiguration(agent, team);
  if (agent.model && agent.model !== 'default') return agent.model;
  // 团队模型只属于团队供应商；跨供应商成员使用自己连接的默认模型。
  return !agent.provider || agent.provider === team.provider ? (team.model || 'default') : 'default';
}
function teamCoordinatorAgent(team, members) {
  return members.find(agent => agent.role === 'ProjectManager' && (!team.leaderId || agent.id === team.leaderId));
}
function teamManagementSnapshot(team, members, taskCwd = '', teams = []) {
  const owners = new Map(teams.flatMap(entry => entry.agents.map(agent => [agent.id, entry])));
  const root = teams.find(entry => entry.team === team || (team.leaderId && entry.team.leaderId === team.leaderId));
  const hierarchy = [];
  // 有明确负责人时保留组织边界；旧版未指定负责人的配置继续使用原单级调度。
  const visit = entry => {
    if (!entry || hierarchy.some(node => node.id === entry.id)) throw new Error('团队关系无效，无法建立调度快照');
    const leaderId = entry.team.leaderId || entry.agents.find(agent => agent.role === 'ProjectManager')?.id;
    if (!leaderId) throw new Error(`子团队「${entry.team.name}」需要一名直属 ProjectManager 负责人`);
    hierarchy.push({ id: entry.id, name: entry.team.name, leaderId, concurrency: entry.team.concurrency || 1,
      memberIds: entry.agents.map(agent => agent.id), children: [...(entry.team.children || [])] });
    (entry.team.children || []).forEach(id => visit(teams.find(child => child.id === id)));
  };
  if (team.leaderId && root) visit(root);
  return { concurrency: team.concurrency || 1, ...(hierarchy.length ? { rootTeamId: root.id, teams: hierarchy } : {}), members: members.map(member =>
  {
    const agent = resolveAgentConfiguration(member, owners.get(member.id)?.team || team);
    return {
      id: agent.id, name: agent.name, role: agent.role, description: agent.description || '', prompt: agent.prompt || '',
      provider: agent.provider || owners.get(agent.id)?.team.provider || team.provider, model: effectiveAgentModel(agent, owners.get(agent.id)?.team || team),
      cwd: effectiveWorkingDirectory(taskCwd, agent.cwd, owners.get(agent.id)?.team.cwd, team.cwd),
      teamId: owners.get(agent.id)?.id, teamName: owners.get(agent.id)?.team.name
    };
  }) };
}
function legacyTaskManagement(run, config) {
  if (run.coordination || run.context?.dispatchMode !== 'manager') return null;
  const entry = config.teams.find(entry => entry.id === run.context?.teamId);
  if (!entry) return null;
  const members = collectAgentsInTree(config.teams, entry.id);
  if (!members.some(member => member.id === run.agentId)) return null;
  return teamManagementSnapshot(entry.team, members, run.cwd, config.teams);
}
