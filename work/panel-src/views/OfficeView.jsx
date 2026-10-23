function OfficeRoom({ entry, members, selectedId, onSelect, now, stale }) {
  const [page, setPage] = useState(0), size = 12;
  const pages = Math.max(1, Math.ceil(members.length / size)), currentPage = Math.min(page, pages - 1);
  const working = members.filter(member => officeIsActive(member.status)).length;
  return <section className="office-room" aria-label={`${entry.team.name}办公室`}>
    <header className="office-room-title"><div><span className="pixel-room-marker"/><h3>{entry.team.name}</h3><span>{members.length} 位成员</span></div><small>{working ? `${working} 位正在工作` : '等待新的协作任务'}</small></header>
    <div className="office-wall"><PixelWindow/><div className="pixel-whiteboard"><span>TEAM WORKSPACE</span><b>{entry.team.name}</b><small>{entry.team.children.length ? `${entry.team.children.length} 个下级团队` : '专注 · 协作 · 交付'}</small></div><div className="pixel-clock" aria-hidden="true"><i/></div><PixelPlant/></div>
    <div className={`office-floor ${stale ? 'stale' : ''}`}><div className="office-desks">
      {members.slice(currentPage * size, (currentPage + 1) * size).map(member => {
        const scene = officeScene(member, now);
        return <button key={member.agent.id} className={`office-seat mood-${scene.pose} ${selectedId === member.agent.id ? 'selected' : ''}`} aria-pressed={selectedId === member.agent.id} aria-label={`${member.agent.name}，${scene.label}`} onClick={() => onSelect(member.agent.id)}>
          <span className={`seat-status ${member.status}`}><i/>{member.status === 'waiting' && member.run?.phase === 'waiting-manager' ? '等待经理答复' : STATES[member.status] || '状态未知'}</span><PixelDesk agentId={member.agent.id} status={member.status} pose={scene.pose}/><b>{member.agent.name}</b><span className="seat-scene-label">{scene.label}</span><small title={member.activity}>{member.activity}</small>{member.run && <span className="seat-time">{officeElapsed(member.run, now)}</span>}{!stale && runInactivity(member.run, now) && <span className="seat-quiet">暂未收到新事件</span>}
        </button>;
      })}
    </div><div className="office-lounge" aria-hidden="true"><PixelPlant/><div className="pixel-sofa"><i/><i/><i/></div><span className="lounge-table"/><PixelCat/><span className="floor-label">认真工作，也别忘了休息</span></div></div>
    {pages > 1 && <div className="office-pagination"><button className="text-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一组工位</button><span>{currentPage + 1} / {pages}</span><button className="text-button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一组工位</button></div>}
  </section>;
}

function OfficeMemberDetail({ member, now, workspace, stale }) {
  if (!member) return <aside className="office-detail"><EmptyState icon="agent" title="选择一位成员">点击办公室里的成员，查看它正在做什么。</EmptyState></aside>;
  const { agent, run } = member;
  const ownerTeam = workspace.config.teams.find(entry => entry.agents.some(member => member.id === agent.id))?.team;
  const configuredAgent = ownerTeam ? resolveAgentConfiguration(agent, ownerTeam) : agent;
  const scene = officeScene(member, now);
  const inactivity = runInactivity(run, now);
  const timestamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未开始';
  return <aside className="office-detail" aria-label="成员工作详情"><div className="office-detail-heading"><span className="eyebrow">成员工作台</span><h2>{agent.name}</h2><p>{member.teamName} · {agent.role}</p></div><div className={`office-detail-portrait mood-${scene.pose}`}><PixelDesk agentId={agent.id} status={member.status} pose={stale ? 'unknown' : scene.pose}/><span className={`badge ${member.status}`}>{stale ? '上次状态' : scene.label}</span></div>
    <div className="office-detail-body">{workspace.approvals.filter(approval => approval.agentId === agent.id).map(approval => <ApprovalCard key={approvalKey(approval)} approval={approval} workspace={workspace}/>)}<h3>正在做什么</h3><p className="office-activity">{member.activity}</p>{stale && <p className="run-error">连接暂不可用，以上为上次同步状态。</p>}{!stale && inactivity && <p className="office-inactivity">{inactivity.message}</p>}{run?.updatedAt && <p className="office-last-event">最近执行事件：{timestamp(run.updatedAt)}</p>}
      <h3>{run && !ACTIVE_JOB_STATES.includes(member.status) ? '最近执行的任务' : '当前任务'}</h3><p className="office-task-goal">{run?.context?.assignment || run?.context?.taskTitle || run?.goal || '尚未分配任务'}</p>
      <TeamFeedback feedback={run?.feedback}/>
      <dl><dt>任务发起人</dt><dd>{run ? officeSourceLabel(run.context) : '—'}</dd><dt>接力来源</dt><dd>{run?.context?.handoffFrom ? `${run.context.handoffFrom.name || run.context.handoffFrom.agentId}${run.context?.coordinatorRunId ? '（经理派发）' : '（顺序接力）'}` : run ? '无前序成员' : '—'}</dd><dt>执行团队</dt><dd>{run?.context?.teamName || (run ? '未记录' : '—')}</dd><dt>开始时间</dt><dd>{timestamp(run?.startedAt)}</dd><dt>运行时长</dt><dd>{officeElapsed(run, now)}</dd>{run?.endedAt && <><dt>结束时间</dt><dd>{timestamp(run.endedAt)}</dd></>}<dt>执行接口</dt><dd>{run?.adapter || configuredAgent.provider}</dd><dt>模型</dt><dd>{run?.model || (ownerTeam ? effectiveAgentModel(configuredAgent, ownerTeam) : configuredAgent.model) || 'default'}</dd><dt>工作目录</dt><dd>{run?.cwd || agent.cwd || '继承任务 / 团队默认目录'}</dd></dl>
      {run?.currentStep && <details><summary>最近执行步骤</summary><pre>{run.currentStep}</pre></details>}{run?.error && <p className="run-error">{run.error}</p>}
      {run?.runId && <button className="btn primary" onClick={() => workspace.viewRun(run.runId)}><Icon name="history" size={16}/>查看运行详情</button>}
    </div></aside>;
}

function OfficeView({ workspace }) {
  // 办公室状态只属于当前任务：新任务没有 taskId 时保持所有成员待命。
  const currentTaskId = workspace.taskConversation?.context?.taskId
    || Object.values(workspace.jobs).find(job => job.context?.taskId)?.context?.taskId
    || null;
  const live = useOffice(workspace.runtime, currentTaskId);
  const restored = workspace.taskConversation;
  const roster = officeTeams(workspace.config.teams, live.snapshot);
  const restoredTeam = roster.find(entry => entry.agents.some(agent => agent.id === restored?.agentId))?.id || restored?.context?.memberTeamId || restored?.context?.teamId;
  const [scope, setScope] = useState(restoredTeam || workspace.config.activeTeamId), [search, setSearch] = useState(''), [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(restored?.agentId || null), [roomPage, setRoomPage] = useState(0);
  const [animated, setAnimated] = useState(() => { try { return localStorage.getItem('agent-manager:office-animation') !== 'off'; } catch { return true; } });
  const toggleAnimation = () => { setAnimated(value => !value); try { localStorage.setItem('agent-manager:office-animation', animated ? 'off' : 'on'); } catch { /* 当前页面仍可切换，受限存储不影响操作。 */ } };
  const scopeId = scope === 'all' || roster.some(entry => entry.id === scope) ? scope : workspace.config.activeTeamId;
  const ids = officeTeamScope(roster, scopeId);
  const allMembers = officeMembers(roster, live.snapshot, workspace.jobs);
  const scoped = allMembers.filter(member => ids.has(member.teamId));
  const visible = scoped.filter(member => `${member.agent.name} ${member.agent.role} ${member.teamName}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || (filter === 'active' ? officeIsActive(member.status) || member.status === 'queued' : filter === 'attention' ? officeNeedsAttention(member.status) : member.status === 'idle')));
  const rooms = roster.filter(entry => visible.some(member => member.teamId === entry.id));
  const pages = Math.max(1, Math.ceil(rooms.length / 6)), currentPage = Math.min(roomPage, pages - 1);
  const selected = visible.find(member => member.agent.id === selectedId) || visible[0];
  const selectMember = id => {
    setSelectedId(id);
    if (window.innerWidth <= 960) requestAnimationFrame(() => document.querySelector('.office-detail')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
  };
  const active = scoped.filter(member => officeIsActive(member.status)).length, attention = scoped.filter(member => officeNeedsAttention(member.status)).length;
  return <div className={`office-workspace ${animated ? '' : 'animations-paused'} ${live.error ? 'connection-stale' : ''}`}><div className="office-overview"><div><span className="eyebrow">TEAM STUDIO / LIVE OFFICE</span><h2>办公室<span className="office-live-dot"/></h2><p>灵感冒泡，键盘作响。看看伙伴们忙到哪一步了。</p></div><div className="office-stats"><span><b>{scoped.length}</b>成员</span><span><b>{active}</b>工作中</span><span><b>{attention}</b>需要关注</span></div></div>
    <div className="office-toolbar"><select aria-label="办公室团队范围" value={scopeId} onChange={event => { setScope(event.target.value); setRoomPage(0); setSelectedId(null); }}><option value="all">全部团队</option>{roster.map(entry => <option key={entry.id} value={entry.id}>{entry.team.name}（含子团队）</option>)}</select><SearchInput value={search} onChange={value => { setSearch(value); setRoomPage(0); }} placeholder="寻找成员、角色或团队"/><select aria-label="办公室状态筛选" value={filter} onChange={event => { setFilter(event.target.value); setRoomPage(0); }}><option value="all">全部状态</option><option value="active">执行 / 排队中</option><option value="attention">需要关注</option><option value="idle">空闲待命</option></select><button className="btn compact office-animation-toggle" aria-label="切换办公室动画" aria-pressed={animated} onClick={toggleAnimation}>{animated ? '动画已开' : '动画已关'}</button><button className="icon-button" aria-label="刷新办公室状态" onClick={live.refresh}><Icon name="refresh"/></button></div>
    {restored && <div className="office-restored-link"><span>已恢复：{restored.context?.agentName || restored.agentId} 的历史对话</span><button className="text-button" onClick={() => workspace.setView('new-task')}>返回当前对话</button></div>}
    <div className="office-sync" role="status"><span className={`status-dot ${live.error ? 'offline' : live.updatedAt ? 'connected' : 'checking'}`}/>{live.error || (live.updatedAt ? '实时同步 · 每 2.5 秒更新' : '正在连接办公室…')}<span className="office-legend"><i className="working"/>工作 <i className="attention"/>关注 <i className="done"/>完成 <i className="failed"/>失败</span></div>
    <div className="office-content"><div className="office-rooms">{rooms.slice(currentPage * 6, (currentPage + 1) * 6).map(entry => <OfficeRoom key={entry.id} entry={entry} members={visible.filter(member => member.teamId === entry.id)} selectedId={selected?.agent.id} onSelect={selectMember} now={live.now} stale={!!live.error}/>)}{!rooms.length && <EmptyState icon="search" title="没有匹配的成员">试试其他团队、名字或状态。</EmptyState>}{pages > 1 && <div className="office-pagination"><button className="btn compact" disabled={currentPage === 0} onClick={() => setRoomPage(currentPage - 1)}>上一页团队</button><span>{currentPage + 1} / {pages}</span><button className="btn compact" disabled={currentPage === pages - 1} onClick={() => setRoomPage(currentPage + 1)}>下一页团队</button></div>}</div><OfficeMemberDetail member={selected} workspace={workspace} now={live.now} stale={!!live.error}/></div>
  </div>;
}
