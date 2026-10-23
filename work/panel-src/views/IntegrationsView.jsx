function IntegrationsView({ workspace })
{
  const { backend, team, providerOptions, skillOptions, mcpOptions, catalog, catalogLoading, catalogError, refreshCatalog, openInterfaceDialog, isRunning } = workspace;
  const [tab, setTab] = useState('providers');
  const [query, setQuery] = useState('');
  const values = (tab === 'skills' ? skillOptions : mcpOptions).filter(value => value.toLowerCase().includes(query.toLowerCase()));
  const providers = providerOptions.filter(provider => !provider.id.startsWith('custom-'));
  const providerHealth = new Map((backend.health?.providers || []).map(provider => [provider.id, provider]));
  const defaultProvider = providerOptions.find(provider => provider.id === team.provider);

  return <div className="page-document integrations-page">
    <div className="integrations-content">
      <header className="document-heading">
        <div className="integrations-title">
          <span className="integrations-mark"><Icon name="plug" size={24}/></span>
          <div><h2>接口与能力</h2><p>管理模型连接、执行接口与本机工具，为团队配置合适的工作方式。</p></div>
        </div>
        <button className="btn" onClick={refreshCatalog} disabled={catalogLoading}>
          <Icon name="refresh" size={16}/>{catalogLoading ? '读取中…' : '刷新连接'}
        </button>
      </header>
      <Tabs value={tab} onChange={value => { setTab(value); setQuery(''); }} label="接口与能力分区"
        items={[[ 'providers', '模型与执行接口', providerOptions.length], ['skills', 'Skills', skillOptions.length], ['mcp', 'MCP 服务', mcpOptions.length]]}/>
      {(catalogError || backend.error) && <div className="notice warning" role="alert">{catalogError || backend.error}</div>}
      {tab === 'providers' ? <>
        <CustomProviders workspace={workspace}/>
        <div className="integrations-detail-grid">
          <section className="integration-panel" aria-label="执行供应商">
            <div className="section-label integration-section-heading">
              <div><h3>执行供应商 <span className="count">{providers.length}</span></h3><p>连接 Agent 执行引擎，成员可独立选择接口。</p></div>
            </div>
            <div className="provider-table">
              <div className="table-labels"><span>供应商</span><span>接入类型</span><span>引擎状态</span></div>
              {providers.map(provider =>
              {
                const health = providerHealth.get(provider.id);
                const readiness = health?.readiness?.status || 'unknown';
                const available = health?.status === 'available';
                return <div className="provider-row" key={provider.id}>
                  <span className="provider-identity">
                    <span className="provider-symbol"><Icon name={provider.kind === 'http' ? 'plug' : 'terminal'} size={21}/></span>
                    <span className="item-copy"><b>{provider.label || provider.id}</b><small>{provider.id}</small></span>
                    {team.provider === provider.id && <span className="badge default-badge">团队默认</span>}
                  </span>
                  <span className="muted provider-kind">{provider.kind === 'codex' ? '本机进程' : provider.kind === 'http' ? 'HTTP API' : 'CLI'}</span>
                  <span className={`connection-state ${available && readiness === 'ready' ? 'available' : ''}`}>
                    <i className={`status-dot ${available && readiness === 'ready' ? 'connected' : ''}`}/>
                    {available ? ({ ready: '检查通过', blocked: '引擎不可用', unknown: '已接入 · 待检测' })[readiness] || '已接入 · 待检测' : '待接入'}
                  </span>
                </div>;
              })}
            </div>
            <div className="connection-footnote">
              <Icon name="plug" size={16}/><p>其他供应商需要安装后端适配器后才能执行任务；模型连通性请在对应连接中测试。</p>
            </div>
          </section>
          <aside className="integrations-sidebar" aria-label="团队接口与环境">
            <section className="integration-panel team-connection" aria-label="团队默认接口">
              <div className="section-label section-inline">
                <div><h3>团队默认接口</h3><p>{team.name} · 用于后续新任务</p></div>
                <span className="team-connection-icon"><Icon name="team" size={20}/></span>
              </div>
              <dl className="team-connection-details">
                <div><dt>执行接口</dt><dd>{defaultProvider?.label || team.provider}</dd></div>
                <div><dt>默认模型</dt><dd>{team.model && team.model !== 'default' ? team.model : '沿用接口默认模型'}</dd></div>
                <div><dt>工作目录</dt><dd className="team-connection-directory">{team.cwd || '沿用本机默认目录'}</dd></div>
              </dl>
              <button className="btn" onClick={openInterfaceDialog} disabled={isRunning}><Icon name="settings" size={15}/>配置团队默认接口</button>
            </section>
            <ProviderDiagnostics workspace={workspace} provider={team.provider} cwd={team.cwd} sandbox={team.sandbox || 'danger-full-access'}
              onSelectSandbox={value => workspace.updateTeam('sandbox', value)} onSelectDirectory={value => workspace.updateTeam('cwd', value)}
              directoryLabel="团队默认工作目录" directoryHint="选择后点击“保存更改”，用于后续新任务。"/>
          </aside>
        </div>
      </> : <section className="integration-panel integration-catalog" aria-label={tab === 'skills' ? 'Skills 目录' : 'MCP 服务目录'}>
        <div className="catalog-toolbar">
          <div><h3>{tab === 'skills' ? '本机 Skills' : 'MCP 服务'}</h3><p className="muted">{tab === 'skills' ? '在 Agent 配置中为成员分配技能。' : '服务目录来自本机 Codex 配置。'}{!catalog.loaded && ' · 目录尚未加载'}</p></div>
          <SearchInput value={query} onChange={setQuery} placeholder={tab === 'skills' ? '搜索 Skills' : '搜索 MCP 服务'}/>
        </div>
        <div className="data-list catalog-rows">
          {values.map(value => <div className="data-row" key={value}>
            <span className="catalog-symbol"><Icon name={tab === 'skills' ? 'file' : 'plug'} size={18}/></span>
            <span className="item-copy"><b>{value}</b><small>{tab === 'skills' ? '本机技能' : '本机 MCP 服务'}</small></span>
            <span className="badge">已发现</span>
          </div>)}
        </div>
        {!values.length && <EmptyState icon={tab === 'skills' ? 'file' : 'plug'} title={query ? '没有匹配的能力' : '暂无能力目录'}>可以刷新连接，重新从本机读取。</EmptyState>}
      </section>}
    </div>
  </div>;
}
