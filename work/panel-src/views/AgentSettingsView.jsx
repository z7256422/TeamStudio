function AgentSettingsView({ workspace })
{
  const { agents, team, selected, effectiveSelected, visibleAgents, filter, setFilter, setSelectedId, updateAgent,
    isRunning, addAgent, removeAgent, providerOptions } = workspace;
  const [tab, setTab] = useState('identity');
  const connectionInherited = selected.connectionMode === 'team';
  const capabilitiesInherited = selected.capabilityMode === 'team';
  return <div className="split-workspace agent-workspace">
    <aside className="directory-pane"><div className="directory-heading"><h2>成员目录 <span className="count">{agents.length}</span></h2><button className="icon-button" aria-label="添加 Agent" onClick={() => { addAgent(); setTab('identity'); }} disabled={isRunning || agents.length >= MAX_AGENTS}><Icon name="plus"/></button></div><SearchInput value={filter} onChange={setFilter} placeholder="搜索名称、角色或职责"/><div className="directory-caption">{team.name}</div><div className="directory-scroll">{visibleAgents.map(agent => <button className={`list-item ${agent.id === selected.id ? 'selected' : ''}`} key={agent.id} onClick={() => setSelectedId(agent.id)}><Avatar name={agent.name}/><span className="item-copy"><b>{agent.name || '未命名成员'}</b><small>{agent.role}</small></span><Icon name="chevron" size={13}/></button>)}{!visibleAgents.length && <div className="quiet-empty">没有匹配的成员</div>}</div><div className="directory-footer"><Icon name="agent" size={15}/><span>角色独立，接口与能力可沿用团队</span></div></aside>
    <section className="editor-pane"><header className="editor-heading"><Avatar name={selected.name} large/><div className="heading-copy"><span className="eyebrow">{team.name} / 成员</span><h2>{selected.name || '未命名成员'}</h2><p>{selected.role}<span>·</span>{providerOptions.find(p => p.id === effectiveSelected.provider)?.label || effectiveSelected.provider}</p></div><button className="icon-button danger" aria-label="移除当前 Agent" title="移除成员" onClick={removeAgent} disabled={isRunning || agents.length === 1}><Icon name="trash"/></button></header>
      <Tabs value={tab} onChange={setTab} items={[[ 'identity', '角色与指令'], ['connection', '执行接口'], ['tools', '工具与能力', effectiveSelected.skills.length + effectiveSelected.mcpServers.length]]}/>
      <div className="editor-scroll" role="tabpanel"><fieldset className="form-page" disabled={isRunning}>
        {tab === 'identity' && <><div className="settings-section"><div className="section-label"><h3>角色定义</h3><p>说明这位成员是谁，以及它对团队的具体贡献。</p></div><div className="form-grid"><Field label="显示名称"><input maxLength="80" value={selected.name} onChange={e => updateAgent('name', e.target.value)}/></Field><Field label="角色标识"><input maxLength="80" value={selected.role} onChange={e => updateAgent('role', e.target.value)}/></Field></div><Field label="职责描述"><textarea rows="3" maxLength="1000" value={selected.description} onChange={e => updateAgent('description', e.target.value)} placeholder="职责边界、交付内容，以及如何配合其他成员…"/></Field></div><div className="settings-section"><div className="section-label"><h3>系统指令</h3><p>运行时传给这个 Agent 的工作方式、约束与输出要求。</p></div><Field label="Prompt"><textarea className="prompt-editor" rows="9" maxLength="16000" value={selected.prompt} onChange={e => updateAgent('prompt', e.target.value)} placeholder="为这位成员编写指令…"/></Field><div className="input-meta"><span>支持纯文本和 Markdown</span><span>{selected.prompt.length.toLocaleString()} / 16,000</span></div></div></>}
        {tab === 'connection' && <div className="settings-section">
          <div className="section-label"><h3>执行接口</h3><p>沿用团队的统一接口，或为这位成员单独选择供应商与模型。</p></div>
          <AgentConfigurationSource workspace={workspace} group="connection" inherited={connectionInherited}/>
          <fieldset disabled={connectionInherited}>
            <Field label="Agent Provider"><select value={effectiveSelected.provider || team.provider} onChange={e => updateAgent('provider', e.target.value)}>{providerOptions.map(provider => <option key={provider.id} value={provider.id}>{provider.label || provider.id}{provider.status === 'planned' ? '（待接入）' : ''}</option>)}</select></Field>
            {providerOptions.find(provider => provider.id === effectiveSelected.provider)?.status === 'planned' && <div className="inline-note">此 Provider 尚未安装执行适配器，当前可以保存配置。</div>}
            <Field label="模型标识" hint="default 使用所属团队的同供应商默认模型；跨供应商时使用所选连接的默认模型。"><input maxLength="120" value={effectiveSelected.model} onChange={e => updateAgent('model', e.target.value)} placeholder="default 或模型 ID"/></Field>
          </fieldset>
          <DirectoryField label="专属工作目录" hint="任务未指定目录时优先使用此目录，留空使用所属团队的目录。" value={selected.cwd} onChange={value => updateAgent('cwd', value)} disabled={isRunning}/>
        </div>}
        {tab === 'tools' && <div className="settings-section">
          <div className="section-label"><h3>工具与能力</h3><p>沿用团队的统一能力选择，也可为这位成员保留独立配置。</p></div>
          <AgentConfigurationSource workspace={workspace} group="capabilities" inherited={capabilitiesInherited}/>
          <fieldset disabled={capabilitiesInherited}>
            <CapabilitySettingsEditor value={effectiveSelected} skillOptions={workspace.skillOptions} mcpOptions={workspace.mcpOptions} catalog={workspace.catalog}
              onToggle={workspace.toggleListValue} onSelectAll={workspace.selectAllCapabilities}/>
          </fieldset>
        </div>}
      </fieldset></div><footer className="editor-status"><span className="status-dot"/><span>角色与指令独立配置 · 变更与团队一起保存</span></footer>
    </section>
  </div>;
}

function AgentConfigurationSource({ workspace, group, inherited })
{
  const section = group === 'connection' ? 'connection' : 'tools';
  const label = group === 'connection' ? '执行接口来源' : '工具与能力来源';
  return <div className={`agent-configuration-source ${inherited ? 'inherited' : ''}`}>
    <Field label={label}>
      <select value={inherited ? 'team' : 'custom'} onChange={e => workspace.setAgentMode(group, e.target.value)}>
        <option value="team">沿用团队设置</option><option value="custom">独立配置</option>
      </select>
    </Field>
    <div className="configuration-source-description"><p>{inherited ? `当前沿用「${workspace.team.name}」，团队修改后自动同步。` : '仅影响当前成员。切回沿用后，将与团队设置同步。'}</p>
      <button type="button" className="text-button" onClick={() => workspace.openTeamSettings(section)}>修改团队设置<Icon name="chevron" size={13}/></button>
    </div>
  </div>;
}
