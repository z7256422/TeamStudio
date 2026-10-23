/* 共享视觉组件：业务状态由页面负责。 */
function Icon({ name, size = 18, ...props }) {
  const paths = {
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4', shield: 'm12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5ZM8 12l3 3 5-6',
    plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-5-5 5 5-5 5', up: 'M12 19V5m-6 6 6-6 6 6',
    folder: 'M3 5h6l2 3h10v12H3ZM3 8h18', office: 'M4 21V3h16v18M2 21h20M8 7h2m4 0h2M8 11h2m4 0h2M9 21v-6h6v6',
    chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6',
    sequence: 'M5 3v18M19 3v18M5 7h14m-4-3 4 3-4 3M19 17H5m4-3-4 3 4 3',
    team: 'M9 3h6v6H9zM3 17h6v4H3zm12 0h6v4h-6zM12 9v5M6 17v-3h12v3',
    agent: 'M8 4h8v3H8zM12 2v2M5 7h14v14H5zM9 12h.01M15 12h.01M9 17h6M2 11v5m20-5v5',
    chat: 'M21 11a9 9 0 0 1-9 9H5l-4 3V11a10 10 0 0 1 20 0ZM7 10h10M7 14h6',
    history: 'M3 11a9 9 0 1 1 2 7M3 3v8h8M12 7v5l3 2',
    plug: 'M9 3v4m6-4v4M7 7h10v5a5 5 0 0 1-10 0ZM12 17v5',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5',
    settings: 'M4 7h16M4 17h16M8 4v6m8 4v6', close: 'm6 6 12 12M6 18 18 6',
    copy: 'M9 8h11v13H9zM15 8V3H4v13h5', trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
    check: 'm5 12 4 4L19 6', refresh: 'M20 7A9 9 0 0 0 4 6L2 9m0-6v6h6M4 17a9 9 0 0 0 16 1l2-3m0 6v-6h-6',
    terminal: 'm4 6 6 6-6 6m9 0h7', file: 'M5 2h9l5 5v15H5zM14 2v6h5M9 12h6m-6 4h6',
    layers: 'm12 2 10 6-10 6L2 8Zm-9 11 9 5 9-5M3 18l9 5 9-5',
    panel: 'M3 3h18v18H3zM15 3v18', menu: 'M4 6h16M4 12h16M4 18h16',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5', stop: 'M6 6h12v12H6z'
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.layers}/></svg>;
}
function Avatar({ name = 'A', kind = 'agent', large = false }) {
  return <span className={`avatar ${large ? 'large' : ''} ${kind}`} aria-hidden="true">{kind === 'team' ? <Icon name="team" size={large ? 26 : 17}/> : (name.trim().slice(0, 1) || 'A')}</span>;
}
function Field({ label, hint, children, className = '' }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-help">{hint}</span>}</label>;
}
function Tabs({ items, value, onChange, label = '配置分区' }) {
  return <div className="tabs" role="tablist" aria-label={label}>{items.map(([id, title, count]) => <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)} className={value === id ? 'active' : ''}>{title}{count !== undefined && <span className="count">{count}</span>}</button>)}</div>;
}
function EmptyState({ icon = 'layers', title, children }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={24}/></span><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}
function SearchInput({ value, onChange, placeholder }) {
  return <div className="search-box"><Icon name="search" size={16}/><input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/></div>;
}
