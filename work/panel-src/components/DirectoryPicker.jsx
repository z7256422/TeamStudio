function DirectoryField({ label = '工作目录', hint, value, onChange, disabled = false, placeholder = '留空使用默认工作目录', compact = false }) {
  const [open, setOpen] = useState(false);
  return <div className={'field directory-field ' + (compact ? 'directory-field-compact' : '')}>
    {!compact && <label className="field-label">{label}</label>}
    <div className="directory-input-row">
      {compact ? <span className="directory-compact-value" title={value || placeholder}><Icon name="folder" size={15}/><span>{value || placeholder}</span></span> : <input aria-label={label} value={value || ''} maxLength="400" disabled={disabled} onChange={event => onChange(event.target.value)} placeholder={placeholder}/>} 
      <button type="button" className="btn" aria-label={`选择${label}`} disabled={disabled} onClick={() => setOpen(true)}><Icon name="folder" size={16}/><span>选择</span></button>
    </div>
    {!compact && hint && <span className="field-help">{hint}</span>}
    {open && ReactDOM.createPortal(<DirectoryPicker initialPath={value} onClose={() => setOpen(false)} onChoose={directory => { onChange(directory); setOpen(false); }}/>, document.body)}
  </div>;
}
function DirectoryPicker({ initialPath, onClose, onChoose }) {
  const ref = useRef(null), request = useRef(null), requestVersion = useRef(0);
  const [listing, setListing] = useState(null), [address, setAddress] = useState(initialPath || '');
  const [selected, setSelected] = useState(''), [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const close = () => { ref.current?.close(); onClose(); };
  const navigate = async directory => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const version = ++requestVersion.current;
    setLoading(true); setError(''); setSelected(''); setSearch('');
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const prefix = window.location.protocol === 'file:' ? 'http://127.0.0.1:3210' : '';
      const response = await fetch(`${prefix}/api/filesystem/directories${directory ? '?path=' + encodeURIComponent(directory) : ''}`, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '无法读取目录');
      if (version !== requestVersion.current) return;
      setListing(result.data); setAddress(result.data.path); setSelected(result.data.path);
    } catch (cause) { if (version === requestVersion.current) setError(cause.name === 'AbortError' ? '读取目录超时，请重试' : cause.message); }
    finally { clearTimeout(timeout); if (version === requestVersion.current) setLoading(false); }
  };
  useEffect(() => {
    ref.current.showModal(); navigate(initialPath);
    return () => { ++requestVersion.current; request.current?.abort(); };
  }, []);
  const directories = (listing?.directories || []).filter(entry => entry.name.toLowerCase().includes(search.toLowerCase()));
  // 目录弹窗可从接口配置弹窗内打开；Escape 只关闭本层，避免丢失接口草稿。
  return <dialog ref={ref} className="directory-dialog" aria-label="选择工作目录" onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}>
    <div className="dialog-top"><div><span className="eyebrow">本机文件夹</span><h3>选择工作目录</h3><p>浏览文件夹后，点击“使用所选目录”。</p></div><button type="button" className="icon-button" aria-label="关闭目录选择" onClick={close}><Icon name="close"/></button></div>
    <div className="directory-browser">
      <div className="directory-address"><button type="button" className="icon-button" aria-label="返回上级目录" disabled={loading || !listing?.parent} onClick={() => navigate(listing.parent)}><Icon name="up"/></button><input aria-label="目录地址" value={address} onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); navigate(address); } }}/><button type="button" className="btn compact" disabled={loading} onClick={() => navigate(address)}>前往</button></div>
      <div className="directory-shortcuts"><button type="button" onClick={() => navigate('')}>默认目录</button>{listing?.shortcuts.map(shortcut => <button type="button" key={shortcut.name} onClick={() => navigate(shortcut.path)}>{shortcut.name}</button>)}</div>
      <SearchInput value={search} onChange={setSearch} placeholder="筛选当前目录下的文件夹"/>
      {error && <p className="run-error" role="alert">{error}</p>}
      <div className="directory-entries" aria-label="文件夹列表" aria-busy={loading}>
        {loading ? <div className="quiet-empty">正在读取本机目录…</div> : !error && <><button type="button" className={`directory-entry ${selected === listing?.path ? 'selected' : ''}`} onClick={() => setSelected(listing.path)}><Icon name="folder"/><span>当前文件夹<small>{listing?.path}</small></span>{selected === listing?.path && <Icon name="check"/>}</button>{directories.map(entry => <div key={entry.path} className={`directory-entry ${selected === entry.path ? 'selected' : ''}`}><button type="button" className="directory-entry-select" onClick={() => setSelected(entry.path)} onDoubleClick={() => navigate(entry.path)} aria-pressed={selected === entry.path}><Icon name="folder"/><span>{entry.name}</span></button><button type="button" className="icon-button" aria-label={`打开文件夹 ${entry.name}`} onClick={() => navigate(entry.path)}><Icon name="chevron"/></button></div>)}{!directories.length && <div className="quiet-empty">{search ? '没有匹配的文件夹' : '此目录没有子文件夹'}</div>}</>}
      </div>
    </div>
    <div className="directory-selection"><span>已选目录</span><p>{selected || '请选择文件夹'}</p></div>
    <div className="dialog-actions"><button type="button" className="btn" onClick={close}>取消</button><button type="button" className="btn primary" disabled={loading || !!error || !selected} onClick={() => { ref.current?.close(); onChoose(selected); }}>使用所选目录</button></div>
  </dialog>;
}
