/* 树目录和编辑器共享选中团队；展开状态独立于选中状态。 */
function TeamTreeNode({ entry, entries, workspace, collapsed, setCollapsed, depth = 0 }) {
  const children = (entry.team.children || []).map(id => entries.get(id)).filter(Boolean);
  const open = !collapsed.has(entry.id);
  const toggle = () => setCollapsed(current => {
    const next = new Set(current);
    next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id);
    return next;
  });
  return <div className="tree-node">
    <div className={`tree-row ${entry.id === workspace.config.activeTeamId ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}>
      {children.length ? <button className="tree-toggle" aria-label={`${open ? '收起' : '展开'} ${entry.team.name}`} aria-expanded={open} onClick={toggle}><Icon name={open ? 'down' : 'chevron'} size={13}/></button> : <span className="tree-spacer"/>}
      <button className="tree-select" onClick={() => workspace.switchTeam(entry.id)} disabled={workspace.isRunning} aria-current={entry.id === workspace.config.activeTeamId ? 'true' : undefined}><Icon name="team" size={17}/><span>{entry.team.name || '未命名团队'}</span><small>{entry.agents.length}</small></button>
    </div>
    {open && children.map(child => <TeamTreeNode key={child.id} entry={child} entries={entries} workspace={workspace} collapsed={collapsed} setCollapsed={setCollapsed} depth={depth + 1}/>)}
  </div>;
}
function TeamsView({ workspace }) {
  const { config, team, agents, executionAgents, rootTeams, createTeam, deleteTeam, setView, setSelectedId, addAgent, isRunning, parentTeam } = workspace;
  const { teamSettingsTab: tab, setTeamSettingsTab: setTab } = workspace;
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set());
  const entries = new Map(config.teams.map(entry => [entry.id, entry]));
  const matches = config.teams.filter(entry => entry.team.name.toLowerCase().includes(query.toLowerCase()));
  const editAgent = agent => { setSelectedId(agent.id); setView('agents'); };
  return <div className="split-workspace team-workspace">
    <aside className="directory-pane">
      <div className="directory-heading"><h2>团队目录 <span className="count">{config.teams.length}</span></h2><button className="icon-button" title="新建团队" aria-label="新建团队" onClick={() => createTeam(false)} disabled={isRunning || config.teams.length >= MAX_TEAMS}><Icon name="plus"/></button></div>
      <SearchInput value={query} onChange={setQuery} placeholder="搜索团队"/>
      <button className="btn" onClick={workspace.createCompany} disabled={isRunning || config.teams.length + 7 > MAX_TEAMS}><Icon name="layers" size={15}/>添加 28 人研发公司</button>
      <div className="directory-caption">组织结构</div>
      <div className="directory-scroll" aria-label="团队树">
        {query ? matches.map(entry => <button key={entry.id} className={`list-item ${entry.id === config.activeTeamId ? 'selected' : ''}`} disabled={isRunning} onClick={() => workspace.switchTeam(entry.id)}><Avatar kind="team"/><span className="item-copy"><b>{entry.team.name}</b><small>{entry.agents.length} 个直属成员</small></span></button>) : rootTeams.map(entry => <TeamTreeNode key={entry.id} entry={entry} entries={entries} workspace={workspace} collapsed={collapsed} setCollapsed={setCollapsed}/>)}
        {query && !matches.length && <div className="quiet-empty">没有找到相关团队</div>}
      </div>
      <div className="directory-footer"><Icon name="layers" size={15}/><span>{rootTeams.length} 个根团队 · {config.teams.length} 个团队</span></div>
    </aside>
    <section className="editor-pane">
      <header className="editor-heading"><Avatar name={team.name} kind="team" large/><div className="heading-copy"><span className="eyebrow">{parentTeam ? parentTeam.team.name + ' / 子团队' : '根团队'}</span><h2>{team.name || '未命名团队'}</h2><p>{agents.length} 位直属成员<span>·</span>{executionAgents.length} 位参与成员<span>·</span>{STRATEGIES[team.strategy]}</p></div><button className="btn" onClick={workspace.newTask}><Icon name="plus" size={15}/>创建任务</button></header>
      <Tabs value={tab} onChange={setTab} items={[[ 'general', '基本信息'], ['members', '成员', agents.length], ['children', '子团队', team.children.length], ['connection', '执行接口'], ['tools', '工具与能力'], ['execution', '执行设置']]}/>
      <div className="editor-scroll" role="tabpanel">
        {tab === 'general' && <div className="form-page"><TeamSettingsView workspace={workspace} section="general"/><div className="settings-section"><div className="section-label"><h3>团队操作</h3><p>复制团队会生成新的成员，不复制包含关系。</p></div><div className="action-row"><button className="btn" onClick={() => createTeam(true)} disabled={isRunning || config.teams.length >= MAX_TEAMS}><Icon name="copy" size={16}/>复制团队</button><button className="btn danger" onClick={deleteTeam} disabled={isRunning || config.teams.length === 1}><Icon name="trash" size={16}/>删除团队</button></div></div></div>}
        {tab === 'members' && <div className="form-page"><div className="section-label section-inline"><div><h3>直属成员</h3><p>成员默认沿用团队接口与能力，也可保留独立配置；角色与指令始终独立。</p></div><button className="btn" disabled={isRunning || agents.length >= MAX_AGENTS} onClick={() => { addAgent(); setView('agents'); }}><Icon name="plus" size={15}/>添加成员</button></div><div className="data-list">{agents.map(agent => <button className="data-row" key={agent.id} onClick={() => editAgent(agent)}><Avatar name={agent.name}/><span className="item-copy"><b>{agent.name}</b><small>{agent.role} · {agent.description || '未填写职责'}</small></span><span className="muted row-provider">{workspace.providerOptions.find(p => p.id === resolveAgentConfiguration(agent, team).provider)?.label || resolveAgentConfiguration(agent, team).provider}</span><Icon name="chevron" size={15}/></button>)}</div><TeamSettingsView workspace={workspace} section="members"/></div>}
        {tab === 'children' && <div className="form-page"><TeamSettingsView workspace={workspace} section="children"/></div>}
        {tab === 'connection' && <div className="form-page"><TeamSettingsView workspace={workspace} section="connection"/></div>}
        {tab === 'tools' && <div className="form-page"><TeamSettingsView workspace={workspace} section="tools"/></div>}
        {tab === 'execution' && <div className="form-page"><TeamSettingsView workspace={workspace} section="execution"/></div>}
      </div>
      <footer className="editor-status"><span className="status-dot"/><span>修改后使用右上角「保存更改」保存到本机</span></footer>
    </section>
  </div>;
}
