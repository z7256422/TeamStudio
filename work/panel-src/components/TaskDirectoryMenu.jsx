/* 任务目录快捷入口：复用历史与配置目录；浏览其他位置仍走现有目录选择器。 */
function TaskDirectoryMenu({ value, onChange, defaultCwd, directories, disabled }) {
  const [open, setOpen] = useState(false), [browsing, setBrowsing] = useState(false), [search, setSearch] = useState('');
  const [position, setPosition] = useState({});
  const triggerRef = useRef(null), popupRef = useRef(null), searchRef = useRef(null);
  const pathKey = path => {
    const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
    return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const folderName = path => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
  const entries = [...new Map([value, ...directories].filter(path => typeof path === 'string' && path.trim())
    .map(path => [pathKey(path), path])).values()];
  const visible = entries.filter(path => path.toLowerCase().includes(search.trim().toLowerCase()));
  const close = (restoreFocus = true) => { setOpen(false); if (restoreFocus) triggerRef.current?.focus(); };
  const choose = path => { onChange(path); close(); };
  const closeBrowser = () => { setBrowsing(false); triggerRef.current?.focus(); };
  React.useLayoutEffect(() => {
    if (!open) return;
    // 放在 portal 中，避免被聊天滚动区裁切；低屏幕时限制列表高度。
    const place = () => {
      const rect = triggerRef.current.getBoundingClientRect(), width = Math.min(320, window.innerWidth - 32);
      setPosition({ left: Math.min(Math.max(16, rect.left), window.innerWidth - width - 16), width,
        bottom: window.innerHeight - rect.top + 8, maxHeight: Math.min(340, rect.top - 20) });
    };
    place(); searchRef.current?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (!popupRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => { if (disabled) { setOpen(false); setBrowsing(false); } }, [disabled]);
  return <>
    <button ref={triggerRef} type="button" className="task-directory-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? 'task-directory-menu' : undefined} aria-label="选择本次任务工作目录" title={value || '未指定任务目录，沿用成员或团队默认目录'}
      onClick={() => { setSearch(''); setOpen(current => !current); }}>
      <Icon name="folder" size={15}/><span>{value ? folderName(value) : '选择工作目录'}</span><Icon name="down" size={12}/>
    </button>
    {open && ReactDOM.createPortal(<div ref={popupRef} id="task-directory-menu" className="task-directory-menu" role="dialog" aria-label="选择任务目录" style={position}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== triggerRef.current) close(false); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const controls = [...event.currentTarget.querySelectorAll('input, button')];
          const index = controls.indexOf(document.activeElement), direction = event.key === 'ArrowDown' ? 1 : -1;
          controls[(index + direction + controls.length) % controls.length]?.focus();
        }
      }}>
      <div className="task-directory-search"><Icon name="search" size={15}/><input ref={searchRef} type="search" aria-label="搜索工作目录" placeholder="搜索工作目录…" value={search} onChange={event => setSearch(event.target.value)}/></div>
      <div className="task-directory-options">
        {visible.map(path => <button type="button" key={pathKey(path)} className="task-directory-option" aria-pressed={pathKey(path) === pathKey(value || '')} title={path} onClick={() => choose(path)}>
          <Icon name="folder" size={15}/><span><b>{folderName(path)}</b><small>{path}</small></span>{pathKey(path) === pathKey(value || '') && <Icon name="check" size={14}/>}
        </button>)}
        {!visible.length && <p className="task-directory-empty">{search ? '没有匹配的目录，可浏览其他位置' : '暂无可选目录，请浏览本机文件夹'}</p>}
      </div>
      <div className="task-directory-actions">
        <button type="button" onClick={() => choose(defaultCwd || '')}><Icon name="refresh" size={14}/>使用团队默认目录</button>
        <button type="button" onClick={() => { close(false); setBrowsing(true); }}><Icon name="plus" size={15}/>浏览其他目录…</button>
      </div>
    </div>, document.body)}
    {browsing && ReactDOM.createPortal(<DirectoryPicker initialPath={value || defaultCwd} onClose={closeBrowser} onChoose={directory => { onChange(directory); closeBrowser(); }}/>, document.body)}
  </>;
}
