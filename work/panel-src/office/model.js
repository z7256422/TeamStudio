/* 办公室只投影真实配置和运行记录；缺少来源的旧记录标为未记录。 */
function officeTeamScope(teams, rootId) {
  if (rootId === 'all') return new Set(teams.map(team => team.id));
  const visited = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    visited.add(id);
    (teams.find(team => team.id === id)?.team.children || []).forEach(visit);
  };
  visit(rootId); return visited;
}
function officeSourceLabel(context) {
  if (!context?.source) return '未记录来源';
  return context.source.name || ({ user: '本机用户', agent: 'Agent', api: 'API 客户端' }[context.source.kind]) || '未记录来源';
}
// 配置中已移除的历史成员仍可能续聊；为其提供只读工位，不写回团队配置。
function officeTeams(teams, snapshot) {
  const result = teams.map(entry => ({ ...entry, agents: [...entry.agents] }));
  const known = new Set(result.flatMap(entry => entry.agents.map(agent => agent.id)));
  for (const run of snapshot?.agents || []) {
    if (known.has(run.agentId)) continue;
    const teamId = run.context?.memberTeamId || run.context?.teamId || 'history-members';
    let entry = result.find(team => team.id === teamId);
    if (!entry) { entry = { id: teamId, team: { name: run.context?.memberTeamName || run.context?.teamName || '历史会话成员', children: [] }, agents: [] }; result.push(entry); }
    entry.agents.push({ id: run.agentId, name: run.context?.agentName || run.agentId, role: run.context?.agentRole || '历史成员', provider: run.adapter, model: run.model, cwd: run.cwd });
    known.add(run.agentId);
  }
  return result;
}
function officeMembers(teams, snapshot, jobs = {}) {
  const remote = new Map((snapshot?.agents || []).map(member => [member.agentId, member]));
  return teams.flatMap(entry => entry.agents.map(agent => {
    const serverRun = remote.get(agent.id), local = jobs[agent.id];
    // 排队成员尚未创建后端运行；同一运行一旦被服务端观测到，就优先使用服务端状态。
    const newerLocal = ['queued', 'starting'].includes(local?.status) && !officeIsActive(serverRun?.status) && local?.context?.taskId && local.context.taskId !== serverRun?.context?.taskId && Date.parse(local.createdAt) >= (Date.parse(serverRun?.createdAt) || 0);
    const run = newerLocal ? { ...local, goal: local.context.taskTitle, agentId: agent.id } : serverRun || null;
    return { agent, teamId: entry.id, teamName: entry.team.name, run,
      status: run?.status || (snapshot ? 'idle' : 'unknown'), activity: run?.activity || (run?.status === 'queued' ? '等待前序成员或空闲席位' : snapshot ? '等待下一项任务' : '尚未同步运行状态') };
  }));
}
function officeElapsed(run, now) {
  if (!run?.startedAt) return '尚未开始';
  const start = typeof run.startedAt === 'number' ? run.startedAt : Date.parse(run.startedAt);
  const end = run.endedAt ? (typeof run.endedAt === 'number' ? run.endedAt : Date.parse(run.endedAt)) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '时间未记录';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function officeNeedsAttention(status) { return ['waiting', 'failed', 'retrying', 'reconnecting'].includes(status); }
function officeIsActive(status) { return ACTIVE_JOB_STATES.includes(status) && status !== 'queued'; }

// 场景由运行状态及公开的执行阶段决定，不随机伪造工作进度。
const OFFICE_SCENES = {
  idle: ['coffee', '待命 · 咖啡时间'], queued: ['queued', '排队 · 等候派工'], starting: ['arriving', '启动 · 正在就位'],
  waiting: ['approval', '等待 · 请你确认'], retrying: ['repair', '重试 · 调整工具'], reconnecting: ['offline', '断线 · 恢复信号'],
  stopping: ['paused', '正在收尾停止'], done: ['celebrate', '完成 · 交付啦！'], failed: ['failed', '失败 · 需要帮助'],
  cancelled: ['paused', '停止 · 暂作休息'], unknown: ['unknown', '状态尚未同步']
};
function officeScene(member, now) {
  let scene = OFFICE_SCENES[member.status];
  if (member.status === 'done' && member.run?.resultMode === 'reply') scene = ['celebrate', '完成 · 已回复'];
  if (member.status === 'waiting' && member.run?.phase === 'waiting-manager') scene = ['reading', '咨询 · 等待经理答复'];
  if (member.status === 'running') {
    if (member.run?.phase === 'answering-feedback') scene = ['writing', '协调 · 答复成员问题'];
    else if (member.run?.phase === 'coordinating') scene = ['tool', '协调 · 等待成员'];
    else if (runInactivity(member.run, now)) scene = ['quiet', '等待 · 引擎响应'];
    else scene = ({ thinking: ['thinking', '分析 · 整理思路'], writing: ['writing', '回复 · 整理交付'], reporting: ['writing', '进展 · 汇报工作'], replying: ['writing', '回复 · 输出内容'],
      coordinating: ['tool', '协调 · 等待成员'], reviewing: ['reading', '验收 · 检查交付'],
      webSearch: ['reading', '搜索 · 查阅资料'], commandExecution: ['coding', '执行 · 敲击键盘'],
      fileChange: ['building', '编辑 · 搭建成果'], mcpToolCall: ['tool', '工具 · 联络外援'], dynamicToolCall: ['tool', '工具 · 协同处理'] })[member.run?.phase] || ['quiet', '等待 · 下一步'];
  }
  const [pose, label] = scene || OFFICE_SCENES.unknown;
  return { pose, label };
}
