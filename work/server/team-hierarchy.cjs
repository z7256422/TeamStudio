/* 分级花名册验证与裁剪；不启动引擎，不接受越级、重复归属或循环组织。 */
function parseHierarchy(input, members, managerId) {
  if (input.teams == null && input.rootTeamId == null) return {};
  if (!Array.isArray(input.teams) || !input.teams.length || input.teams.length > 50) throw new Error('management.teams must contain 1–50 teams');
  const text = (value, label, max = 160) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
    return value.trim();
  };
  const roster = new Map(members.map(member => [member.id, member]));
  const owners = new Set(), ids = new Set();
  const teams = input.teams.map(node => {
    if (!node || typeof node !== 'object') throw new Error('Invalid hierarchy team');
    const id = text(node.id, 'team id'), name = text(node.name, 'team name', 80), leaderId = text(node.leaderId, 'team leader', 100);
    if (ids.has(id)) throw new Error('Duplicate hierarchy team');
    ids.add(id);
    if (!Array.isArray(node.memberIds) || !node.memberIds.length || node.memberIds.length > 200 || !Array.isArray(node.children) || node.children.length > 50) throw new Error('Invalid hierarchy members or children');
    const memberIds = node.memberIds.map(id => {
      if (!roster.has(id) || owners.has(id)) throw new Error('Hierarchy members must belong to exactly one team');
      owners.add(id); return id;
    });
    if (!memberIds.includes(leaderId) || roster.get(leaderId).role !== 'ProjectManager') throw new Error('Team leader must be a direct ProjectManager member');
    const concurrency = node.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) throw new Error('Invalid hierarchy concurrency');
    return { id, name, leaderId, concurrency, memberIds, children: node.children.map(id => text(id, 'child team id')) };
  });
  const rootTeamId = text(input.rootTeamId, 'rootTeamId'), byId = new Map(teams.map(node => [node.id, node]));
  if (owners.size !== members.length || byId.get(rootTeamId)?.leaderId !== managerId) throw new Error('Hierarchy root must match its manager and complete roster');
  const parents = new Set();
  for (const node of teams) for (const child of node.children) {
    if (!byId.has(child) || child === rootTeamId || parents.has(child)) throw new Error('Invalid, repeated or circular child team');
    parents.add(child);
  }
  const visited = new Set();
  const visit = id => {
    if (visited.has(id)) throw new Error('Circular hierarchy');
    visited.add(id); byId.get(id).children.forEach(visit);
  };
  visit(rootTeamId);
  if (visited.size !== teams.length) throw new Error('Hierarchy contains unreachable teams');
  return { rootTeamId, teams };
}

function dispatchableMembers(management, managerId) {
  if (!management.teams) return management.members.filter(member => member.id !== managerId);
  const root = management.teams.find(team => team.id === management.rootTeamId);
  const childLeaders = management.teams.filter(team => root.children.includes(team.id)).map(team => team.leaderId);
  const allowed = new Set([...root.memberIds, ...childLeaders]);
  return management.members.filter(member => member.id !== managerId && allowed.has(member.id));
}

function delegatedManagement(management, agentId) {
  if (!management.teams) return null;
  const root = management.teams.find(team => team.id === management.rootTeamId);
  const selected = management.teams.find(team => root.children.includes(team.id) && team.leaderId === agentId);
  if (!selected) return null;
  const ids = new Set();
  const visit = team => { ids.add(team.id); team.children.forEach(id => visit(management.teams.find(child => child.id === id))); };
  visit(selected);
  const teams = management.teams.filter(team => ids.has(team.id));
  const memberIds = new Set(teams.flatMap(team => team.memberIds));
  return { rootTeamId: selected.id, teams, concurrency: selected.concurrency,
    deliveryMode: management.deliveryMode, members: management.members.filter(member => memberIds.has(member.id)) };
}
module.exports = { parseHierarchy, dispatchableMembers, delegatedManagement };
