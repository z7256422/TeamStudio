/* 团队与成员共用能力目录，保留目录暂时缺失时已经选择的名称。 */
function CapabilitySettingsEditor({ value, skillOptions, mcpOptions, catalog, onToggle, onSelectAll })
{
  const selection = getCapabilitySelection(value);
  const groups = [['skills', 'Skills', skillOptions], ['mcpServers', 'MCP 服务', mcpOptions]];
  return <div className="capability-settings">
    <p className="capability-description">默认全选，并自动包含新增能力。手动取消后，该分类会保留你的选择。</p>
    <p className="capability-description">{catalog.loaded ? '能力目录来自本机 Codex；具体执行权限由运行引擎控制。' : '正在读取本机能力目录，已选择的能力仍会保留。'}</p>
    {groups.map(([key, label, options]) =>
    {
      const selected = value[key] || [];
      const values = normalizeCapabilityNames([...options, ...selected]);
      return <div className="settings-section" key={key}>
        <div className="section-label section-inline"><h3>{label}</h3>
          <div className="capability-actions"><span className="muted">已选 {selected.length}</span>
            {selection[key] === 'all' ? <span className="badge">默认全选</span> : <button type="button" className="text-button" aria-label={`全选 ${label}`} onClick={() => onSelectAll(key)}>恢复全选</button>}
          </div>
        </div>
        <div className="capability-list">{values.map(name => <label key={name} className={`capability-row ${selected.includes(name) ? 'selected' : ''}`}>
          <input type="checkbox" checked={selected.includes(name)} onChange={() => onToggle(key, name)}/>
          <Icon name={key === 'skills' ? 'file' : 'plug'} size={17}/><span>{name}</span>
        </label>)}</div>
        {!values.length && <div className="quiet-empty">未发现可用的 {label}，可到「接口与能力」刷新。</div>}
      </div>;
    })}
  </div>;
}
