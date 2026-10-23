/* 可组合的团队配置区块，统一放在团队树右侧编辑，不再使用独立跳转页。 */
function TeamSettingsView({ workspace, section })
{
  const { team, agents, executionAgents, selected, sizeDraft, isRunning, providerOptions, updateTeam,
    resizeTeam, setSizeDraft, childTeams, includedTeamIds, toggleTeamChild } = workspace;
  const projectManagers = agents.filter(agent => agent.role === 'ProjectManager');
  // 旧配置未指定或原负责人已被移除时显示占位，避免浏览器把第一位成员显示为已选中。
  const selectedLeaderId = projectManagers.some(agent => agent.id === team.leaderId) ? team.leaderId : '';
  if (section === 'general') return <fieldset disabled={isRunning} className="settings-section">
    <div className="section-label"><h3>基本信息</h3><p>为团队命名，并指定默认的工作位置。</p></div>
    <Field label="团队名称"><input maxLength="80" value={team.name} onChange={e => updateTeam('name', e.target.value)}/></Field>
    <Field label="团队负责人" hint={projectManagers.length ? '从当前团队直属的 ProjectManager 成员中选择；负责人可继续安排本组成员与子团队。' : '请先在 Agent 配置中将一位直属成员的角色设为 ProjectManager。'}>
      <select value={selectedLeaderId} disabled={!projectManagers.length} onChange={e => updateTeam('leaderId', e.target.value)}>
        <option value="" disabled hidden>{projectManagers.length ? '请选择团队负责人' : '暂无 ProjectManager 成员'}</option>
        {projectManagers.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </Field>
    <DirectoryField label="默认工作目录" hint="成员的专属目录为空且任务未指定目录时，使用所属团队的目录。" value={team.cwd} onChange={value => updateTeam('cwd', value)} disabled={isRunning} placeholder="留空使用本机控制平面的工作目录"/>
    <div className="inline-note"><Icon name="team"/><p>当前团队及其子团队共包含 <strong>{executionAgents.length}</strong> 位成员。{team.leaderId ? '独立调用由本团队负责人协调；调用上级时由上级负责人派发，部门负责人再安排组员。只启动任务需要的成员。' : '运行任务时，会按照当前团队的执行设置调度。'}</p></div>
  </fieldset>;
  if (section === 'connection') return <fieldset disabled={isRunning} className="team-shared-settings">
    <div className="section-label"><h3>团队执行接口</h3><p>统一设置本团队直属成员使用的供应商与模型，沿用成员会随团队设置同步更新。</p></div>
    <TeamConfigurationScope workspace={workspace} group="connection"/>
    <div className="settings-section">
      <div className="form-grid">
        <Field label="团队 Provider"><select value={team.provider} onChange={e => updateTeam('provider', e.target.value)}>{providerOptions.map(provider => <option key={provider.id} value={provider.id}>{provider.label || provider.id}{provider.status === 'planned' ? '（待接入）' : ''}</option>)}</select></Field>
        <Field label="团队默认模型" hint="default 使用所选连接的默认模型。"><input maxLength="120" value={team.model} onChange={e => updateTeam('model', e.target.value)} placeholder="default 或模型 ID"/></Field>
      </div>
      {providerOptions.find(provider => provider.id === team.provider)?.status === 'planned' && <div className="inline-note">此 Provider 尚未安装执行适配器，当前可以保存配置。</div>}
      <div className="inline-note"><Icon name="team"/><p>新增成员默认沿用团队执行接口。需要使用其他模型时，可在该成员的「执行接口」中切换为独立配置。</p></div>
    </div>
  </fieldset>;
  if (section === 'tools') return <fieldset disabled={isRunning} className="team-shared-settings">
    <div className="section-label"><h3>团队工具与能力</h3><p>在这里选择一次，沿用团队设置的直属成员即可共用相同的 Skills 与 MCP 选择。</p></div>
    <TeamConfigurationScope workspace={workspace} group="capabilities"/>
    <div className="settings-section">
      <CapabilitySettingsEditor value={team} skillOptions={workspace.skillOptions} mcpOptions={workspace.mcpOptions} catalog={workspace.catalog}
        onToggle={(key, value) => updateTeam(key, team[key].includes(value) ? team[key].filter(item => item !== value) : [...team[key], value])}
        onSelectAll={workspace.selectAllTeamCapabilities}/>
    </div>
  </fieldset>;
  if (section === 'members') return <fieldset disabled={isRunning} className="settings-section">
    <div className="section-label"><h3>批量调整数量</h3><p>新增成员使用空白角色；减少时从直属成员列表末尾移除，可撤销。</p></div>
    <div className="number-action"><Field label="直属成员数量"><input type="number" min="1" max={MAX_AGENTS} value={sizeDraft} onChange={e => setSizeDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') resizeTeam(); }}/></Field><button className="btn" onClick={resizeTeam}>应用数量</button></div>
  </fieldset>;
  if (section === 'children') return <fieldset disabled={isRunning}>
    <div className="section-label"><h3>子团队关系</h3><p>选择要包含的团队。已属于其他团队的节点与祖先节点不可重复加入。</p></div>
    <div className="relation-list">{childTeams.map(child => <label className={`relation-row ${includedTeamIds.has(child.id) ? 'selected' : ''}`} key={child.id}><input type="checkbox" checked={includedTeamIds.has(child.id)} onChange={() => toggleTeamChild(child.id)}/><Avatar kind="team"/><span className="item-copy"><b>{child.team.name}</b><small>{child.agents.length} 位直属成员 · {child.team.children.length} 个子团队</small></span><span className="badge">{includedTeamIds.has(child.id) ? '已包含' : '可加入'}</span></label>)}</div>
    {!childTeams.length && <EmptyState icon="team" title="暂无可加入的团队">从左侧新建团队后，可以在这里建立包含关系。</EmptyState>}
    <div className="inline-note"><Icon name="layers"/><p>每个团队只能有一个父团队。取消勾选会将它恢复为根团队，其成员和下级关系会保留。</p></div>
  </fieldset>;
  return <fieldset disabled={isRunning}>
    <div className="settings-section"><div className="section-label"><h3>协作方式</h3><p>{team.leaderId ? '项目经理主导时分级派发，并发上限限制本负责人同时派出的直属任务；子团队按自己的上限执行。默认每级仅派发 1 项，等待通过事件唤醒。' : '决定一次任务如何分配给团队树中的成员。'}</p></div>
      <div className="strategy-options">{Object.entries(STRATEGIES).map(([id, title]) => <label key={id} className={`strategy-option ${team.strategy === id ? 'selected' : ''}`}><input type="radio" name="team-strategy" value={id} checked={team.strategy === id} onChange={() => updateTeam('strategy', id)}/><span><b>{title}</b><small>{id === 'manager' ? '项目经理按需派发、跟进返工并验收交付物' : id === 'parallel' ? '成员同时处理任务，受并发上限约束' : id === 'sequential' ? '前一位成员的输出传递给下一位' : '仅运行选中的 ' + selected.name}</small></span></label>)}</div>
      <div className="form-grid"><Field label="并发上限" hint={`团队树共 ${executionAgents.length} 位成员`}><input type="number" min="1" max={Math.min(MAX_AGENTS, executionAgents.length)} value={team.concurrency} onChange={e => updateTeam('concurrency', Number(e.target.value))}/></Field><Field label="文件权限" hint={(team.sandbox || 'danger-full-access') === 'danger-full-access' ? '无沙箱：使用当前用户的文件与网络权限' : '沙箱限制文件访问范围；Windows 需要沙箱环境正常'}><select value={team.sandbox || 'danger-full-access'} onChange={e => updateTeam('sandbox', e.target.value)}><option value="danger-full-access">无沙箱（默认）</option><option value="workspace-write">工作区内可写（沙箱）</option><option value="read-only">只读（沙箱）</option></select></Field><Field label="审批策略"><select value={team.approvalPolicy} onChange={e => updateTeam('approvalPolicy', e.target.value)}><option value="on-request">按需询问</option><option value="never">从不询问</option><option value="untrusted">仅不受信操作</option></select></Field></div>
    </div>

  </fieldset>;
}

/* 批量操作仅切换直属成员的来源，团队树中的其他节点仍使用自己的设置。 */
function TeamConfigurationScope({ workspace, group })
{
  const key = group === 'connection' ? 'connectionMode' : 'capabilityMode';
  const inherited = workspace.agents.filter(agent => agent[key] === 'team').length;
  return <div className="team-configuration-scope settings-section">
    <div className="shared-setting-summary">
      <span className="shared-setting-icon"><Icon name={group === 'connection' ? 'plug' : 'layers'} size={20}/></span>
      <div><strong>{inherited} 位沿用团队设置</strong><p>{workspace.agents.length - inherited} 位独立配置 · 仅作用于本团队直属成员</p></div>
    </div>
    <div className="shared-setting-action">
      <button type="button" className="btn" disabled={inherited === workspace.agents.length} onClick={() => workspace.applyTeamConfiguration(group)}>让全体直属成员沿用团队设置</button>
      <p>子团队保留各自设置。修改后点击「保存更改」。</p>
    </div>
  </div>;
}
