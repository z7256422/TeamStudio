/* 供应商诊断使用统一接口。初始化是显式用户操作，检测本身不修改环境。 */
function ProviderDiagnostics({ workspace, provider = 'codex-app-server', cwd = '', sandbox = 'danger-full-access', onSelectSandbox, onSelectDirectory, directoryLabel = '工作目录', directoryHint = '', compact = false }) {
  const [state, setState] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [revision, setRevision] = useState(0), [confirmRepair, setConfirmRepair] = useState(false), [repairing, setRepairing] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current;
    setState(null); setError(''); setConfirmRepair(false); setChoosingDirectory(false);
    let stop;
    if (workspace.backend.state === 'connected') {
      setLoading(true);
      stop = workspace.runtime.current.watchResource(`/api/providers/${encodeURIComponent(provider)}/diagnostics?checkEngine=1&cwd=${encodeURIComponent(cwd)}&sandbox=${encodeURIComponent(sandbox)}${revision > 0 ? '&refresh=1' : ''}`, {
        timeout: 65000,
        onData: result => { setState(result); setError(''); setLoading(false); },
        onError: cause => { setState(null); setError(`环境检测失败：${cause.message}`); setLoading(false); }
      });
    }
    return () => { stop?.(); if (generation.current === token) generation.current++; };
  }, [provider, cwd, sandbox, workspace.backend.state, revision]);
  const repair = async () => {
    const token = generation.current;
    setRepairing(true); setConfirmRepair(false); setError('');
    try {
      const setup = await workspace.runtime.current.request(`/api/providers/${encodeURIComponent(provider)}/repair`, { method: 'POST', body: JSON.stringify({ action: 'setup', cwd }) }, 65000);
      if (token !== generation.current) return;
      if (setup.status === 'failed') setError(`初始化失败：${setup.error}`);
      else setRevision(value => value + 1);
    } catch (cause) { if (token === generation.current) setError(cause.message); }
    finally { setRepairing(false); }
  };
  const directoryBlocked = state?.category === 'working-directory';
  // 无沙箱只免去沙箱初始化，仍需展示失效目录和连接故障。
  if (compact && !error && (!state || ['ready', 'notApplicable'].includes(state.status))) return null;
  return <section className={`provider-diagnostics ${compact ? 'compact' : ''}`} aria-label="执行环境诊断">
    <div className="section-label section-inline"><div><h3>执行环境诊断</h3><p role={error || directoryBlocked ? 'alert' : 'status'} className={error || directoryBlocked ? 'run-error' : ''}>{loading ? '正在检查工作目录与执行模式…' : error || state?.summary || '等待连接执行引擎'}</p></div><button type="button" className="btn compact" disabled={loading || repairing} onClick={() => setRevision(value => value + 1)}>重新检测</button></div>
    {(state?.cwd || cwd) && <p className="diagnostic-directory"><span>{directoryLabel}</span><code>{state?.cwd || cwd}</code></p>}
    {directoryBlocked && onSelectDirectory && <div className="history-actions"><button type="button" className="btn compact" disabled={workspace.isRunning || repairing || loading} onClick={() => setChoosingDirectory(true)}><Icon name="folder" size={15}/>重新选择工作目录</button>{directoryHint && <span className="muted">{directoryHint}</span>}</div>}
    {state?.detail && <details><summary>查看故障详情</summary><pre>{state.detail}</pre></details>}
    {state?.setup?.status === 'failed' && <p className="run-error">初始化未成功：{state.setup.error}</p>}
    {state?.status === 'blocked' && !directoryBlocked && state?.category !== 'engine' && sandbox !== 'danger-full-access' && onSelectSandbox && <div className="history-actions"><button type="button" className="btn compact" disabled={workspace.isRunning || repairing} onClick={() => onSelectSandbox('danger-full-access')}>改用无沙箱</button><span className="muted">使用当前用户的文件与网络权限</span></div>}
    {state?.status === 'blocked' && !directoryBlocked && state.repair?.available && state.setup?.status !== 'running' && <>
      <p>初始化或修复 Codex 的 Windows 沙箱账户，可能出现系统 UAC 确认。完成后重新检测，任务仍沿用所选文件权限与审批策略。</p>
      {confirmRepair ? <div className="history-actions"><span>确认现在初始化沙箱环境？</span><button type="button" className="btn compact" onClick={() => setConfirmRepair(false)}>取消</button><button type="button" className="btn compact primary" onClick={repair}>确认初始化</button></div> : <button type="button" className="btn compact" disabled={repairing} onClick={() => setConfirmRepair(true)}>{repairing ? '正在初始化…' : '修复 Windows 沙箱'}</button>}
    </>}
    {choosingDirectory && ReactDOM.createPortal(<DirectoryPicker initialPath="" onClose={() => setChoosingDirectory(false)} onChoose={directory => { onSelectDirectory(directory); setChoosingDirectory(false); setRevision(value => value + 1); }}/>, document.body)}
  </section>;
}
