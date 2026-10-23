/* 单层导航：团队切换只修改上下文，页面切换由明确的导航按钮触发。 */
function PanelShell({ workspace, children }) {
  const { config, backend, view, isRunning, setView, switchTeam, fileInput, importConfig, exportConfig, save, dirty } = workspace;
  const [navOpen, setNavOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const titles = { 'new-task': '新任务', teams: '团队配置', team: '团队配置', agents: 'Agent 配置', runs: '运行记录', messages: '成员消息', integrations: '接口与能力', office: '办公室' };
  const navigate = next => { next === 'new-task' ? workspace.newTask() : setView(next); setNavOpen(false); };
  const nav = (id, icon, label) => <button className={`nav-item ${view === id || (id === 'teams' && view === 'team') ? 'active' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon}/><span>{label}</span></button>;
  return <div className="studio-shell">
    {navOpen && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setNavOpen(false)}/>}
    <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
      <div className="brand"><span className="brand-symbol"><Icon name="layers" size={22}/></span><span>Team Studio<small>Agent 协作工作台</small></span></div>
      <div className="workspace-select"><span className="eyebrow">当前团队</span><select aria-label="选择团队" disabled={isRunning} value={config.activeTeamId} onChange={e => switchTeam(e.target.value)}>{config.teams.map(entry => <option key={entry.id} value={entry.id}>{entry.team.name || '未命名团队'}</option>)}</select></div>
      <button type="button" className="nav-item new-task-nav" onClick={() => navigate('new-task')}><Icon name="plus"/><span>新任务</span></button>
      <section className="sidebar-recents" aria-label="最近任务">
        <div className="sidebar-recents-heading">
          <button type="button" className="sidebar-recents-toggle" aria-label={recentsOpen ? '收起最近记录' : '展开最近记录'} aria-expanded={recentsOpen} aria-controls="sidebar-recent-tasks" onClick={() => setRecentsOpen(value => !value)}><span>最近记录</span><Icon name={recentsOpen ? 'down' : 'chevron'} size={12}/></button>
        </div>
        <div id="sidebar-recent-tasks" className="sidebar-recents-list" hidden={!recentsOpen}>
        {workspace.runHistory.slice(0, 6).map(run => <button key={run.conversationKey} className={`recent-task ${workspace.taskConversation?.runId === run.runId && view === 'new-task' ? 'selected' : ''}`} title={run.context?.taskTitle || run.goal} onClick={() => { workspace.restoreConversation(run); setNavOpen(false); }}><span className={`status-dot ${run.status === 'completed' ? 'done' : run.status}`}/><span><b>{shortTaskTitle(run.context?.taskTitle || run.goal)}</b><small>{taskStatusLabel(run.status)} · {run.turnCount} 轮对话</small></span></button>)}
        {!workspace.runHistory.length && <p>开始任务后会显示在这里</p>}
        </div>
      </section>
      <nav aria-label="主导航"><span className="nav-label">工作空间</span>{nav('office', 'office', '办公室')}{nav('runs', 'history', '运行记录')}{nav('messages', 'chat', '成员消息')}<span className="nav-label">管理</span>{nav('teams', 'team', '团队配置')}{nav('agents', 'agent', 'Agent 配置')}{nav('integrations', 'plug', '接口与能力')}</nav>
      <div className="sidebar-bottom">
        <div className="config-tools"><button onClick={() => fileInput.current.click()} disabled={isRunning}><Icon name="upload" size={15}/>导入配置</button><button onClick={exportConfig}><Icon name="download" size={15}/>导出</button></div>
        <button className="runtime-status" onClick={() => navigate('integrations')}><span className={`status-dot ${backend.state}`}/><span>{backend.state === 'connected' ? '管理服务已连接' : backend.state === 'checking' ? '正在连接管理服务' : '管理服务离线'}<small>执行引擎状态请查看诊断</small></span><Icon name="chevron" size={14}/></button>
      </div>
      <input ref={fileInput} type="file" accept=".json,application/json" onChange={importConfig} hidden/>
    </aside>
    <main className="studio-main">
      <header className="workspace-bar"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setNavOpen(true)}><Icon name="menu"/></button><div className="breadcrumbs"><span>工作空间</span><Icon name="chevron" size={12}/><h1>{titles[view]}</h1></div><div className="bar-actions"><NotificationCenter workspace={workspace}/><span className={`save-state ${dirty ? 'dirty' : ''}`}><i/>{dirty ? '有未保存更改' : '所有更改已保存'}</span><button className="btn compact" onClick={save} disabled={!dirty || isRunning}><Icon name="check" size={14}/>保存更改</button></div></header>
      <div className={`page-stage page-${view}`}>{children}</div>
    </main>
  </div>;
}
