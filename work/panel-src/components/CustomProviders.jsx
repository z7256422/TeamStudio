/* 密钥仅保留在当前表单，保存/关闭即销毁；不写入 workspace、localStorage 或导出配置。 */
function CustomProviderForm({ workspace, provider, onClose })
{
  const [draft, setDraft] = useState(() => ({
    label: provider?.label || '', baseUrl: provider?.baseUrl || '', defaultModel: provider?.defaultModel || '',
    protocol: 'responses', reasoningEffort: provider?.reasoningEffort || 'default', auth: provider?.auth || 'apiKey', enabled: provider?.enabled !== false, apiKey: ''
  }));
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [result, setResult] = useState(null);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const update = (key, value) =>
  {
    setDraft(current => ({ ...current, [key]: value, ...(key === 'auth' ? { apiKey: '' } : {}) }));
    setResult(null); setError('');
  };
  const submit = async action =>
  {
    if (busy) return;
    setBusy(action); setError(''); setResult(null);
    controller.current = new AbortController();
    try
    {
      const body = { ...draft, ...(provider ? { id: provider.id } : {}) };
      const route = action === 'test' ? '/api/providers/test' : `/api/providers/custom${provider ? '/' + encodeURIComponent(provider.id) : ''}`;
      const data = await workspace.runtime.current.request(route, { method: 'POST', signal: controller.current.signal, body: JSON.stringify(body) }, 40000);
      if (action === 'test') setResult(data);
      else
      {
        setDraft(current => ({ ...current, apiKey: '' }));
        workspace.setToast('模型连接已保存，可在团队或成员的执行接口中选择');
        onClose();
      }
    }
    catch (cause)
    {
      if (!controller.current?.signal.aborted) setError(cause.message);
    }
    finally
    {
      setBusy('');
    }
  };
  return <form className="custom-provider-form" onSubmit={event => { event.preventDefault(); submit('save'); }} aria-label={provider ? '编辑模型连接' : '新增模型连接'}>
    <div className="custom-provider-form-heading">
      <div><h3>{provider ? '编辑模型连接' : '新增模型连接'}</h3><p>配置模型参数与服务地址，测试后即可保存使用。</p></div>
      <button className="btn compact" type="button" onClick={onClose}>取消编辑</button>
    </div>
    <fieldset disabled={Boolean(busy)}>
      <div className="custom-provider-form-grid">
        <fieldset className="custom-provider-group">
          <legend><Icon name="settings" size={16}/>模型配置</legend>
          <div className="custom-provider-fields">
            <label>连接名称<input required maxLength={120} value={draft.label} onChange={event => update('label', event.target.value)} placeholder="例如：研发模型服务"/></label>
            <label>默认模型 ID<input required maxLength={120} value={draft.defaultModel} onChange={event => update('defaultModel', event.target.value)} placeholder="供应商提供的准确模型名称"/></label>
            <label>思考强度<select value={draft.reasoningEffort} onChange={event => update('reasoningEffort', event.target.value)}>{MODEL_REASONING_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>选择供应商支持的值，测试与正式任务使用同一强度。沿用模式保留 Codex 或原会话设置。</small></label>
            <label className="provider-enable"><input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)}/>启用此连接</label>
          </div>
        </fieldset>
        <fieldset className="custom-provider-group">
          <legend><Icon name="plug" size={16}/>连接与认证</legend>
          <div className="custom-provider-fields">
            <label>Base URL<input required type="url" maxLength={2000} value={draft.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="https://api.example.com/v1"/><small>保留服务要求的 /v1 等前缀，也支持完整 /responses 地址。</small></label>
            <div className="custom-provider-auth-fields">
              <label>接口协议<select value={draft.protocol} onChange={event => update('protocol', event.target.value)}><option value="responses">OpenAI Responses</option></select></label>
              <label>认证方式<select value={draft.auth} onChange={event => update('auth', event.target.value)}><option value="apiKey">API Key（Bearer）</option><option value="none">无需密钥（本地服务）</option></select></label>
            </div>
            {draft.auth === 'apiKey' && <label>API Key<input type="password" autoComplete="new-password" maxLength={8192} required={!provider?.hasApiKey} value={draft.apiKey} onChange={event => update('apiKey', event.target.value)} placeholder={provider?.hasApiKey ? '留空保留已保存密钥，填写新值替换' : '输入 API Key'}/><small>由本机服务保存，Windows 使用当前用户加密，不随团队配置导出；更换电脑或系统用户后需重新填写。</small></label>}
          </div>
        </fieldset>
      </div>
    </fieldset>
    <div className="custom-provider-form-notes">
      <p>通过本机 Codex 执行，沿用文件权限、MCP、Skills、成员反馈和审批；服务需支持 Responses 流式与工具调用。</p>
      {provider && <p>修改地址或认证方式后，旧会话需恢复原配置才能继续。思考强度对下次执行及续聊生效；运行中的连接禁止修改。</p>}
    </div>
    {error && <div className="notice warning" role="alert">{error}</div>}
    {result && <div className="notice provider-test-success" role="status">{result.message} 用时 {(result.durationMs / 1000).toFixed(1)} 秒。</div>}
    <div className="custom-provider-form-footer">
      <small className="muted">连接测试会发送小型模型请求，可能产生少量 API 费用。</small>
      <div className="history-actions">
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => submit('test')}>{busy === 'test' ? '测试中…' : '测试连接与工具调用'}</button>
        {busy === 'test' && <button type="button" className="btn" onClick={() => { controller.current?.abort(); }}>取消测试</button>}
        <button type="submit" className="btn primary" disabled={Boolean(busy)}>{busy === 'save' ? '保存中…' : '保存连接'}</button>
      </div>
    </div>
  </form>;
}

function CustomProviders({ workspace })
{
  const providers = (workspace.backend.health?.providers || []).filter(provider => provider.engine === 'codex-app-server');
  const [editing, setEditing] = useState(null), [deleting, setDeleting] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const remove = async provider =>
  {
    setBusy(true); setError('');
    try
    {
      await workspace.runtime.current.request(`/api/providers/custom/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
      setDeleting(null); workspace.setToast('连接已删除；引用它的团队或成员需要选择其他供应商');
    }
    catch (cause)
    {
      setError(cause.message);
    }
    finally
    {
      setBusy(false);
    }
  };
  return <section className="custom-providers" aria-label="自定义模型">
    <div className="section-label section-inline integration-section-heading">
      <div><h3>自定义模型 <span className="count">{providers.length}</span></h3><p>使用自己的模型服务，团队和成员均可独立选择连接。</p></div>
      <button className="btn primary" disabled={workspace.backend.state !== 'connected' || Boolean(editing)} onClick={() => { setEditing({}); setError(''); }}><Icon name="plus" size={15}/>添加模型连接</button>
    </div>
    {error && <div className="notice warning" role="alert">{error}</div>}
    {editing ? <CustomProviderForm key={editing.id || 'new'} workspace={workspace} provider={editing.id ? editing : null} onClose={() => setEditing(null)}/> : <div className="custom-provider-list">
      {providers.map(provider => <article className="custom-provider-card" key={provider.id}>
        <header className="custom-provider-card-heading">
          <span className="custom-provider-symbol"><Icon name="layers" size={20}/></span>
          <div><strong>{provider.label}</strong><span className="custom-provider-engine">Responses · 本机 Codex</span></div>
          <span className={`badge ${provider.status === 'available' ? 'done' : ''}`}>{provider.status === 'available' ? '已启用' : '已停用'}</span>
        </header>
        <div className="custom-provider-model"><span>默认模型</span><code>{provider.defaultModel}</code></div>
        <dl className="custom-provider-details">
          <div><dt>思考强度</dt><dd>{MODEL_REASONING_OPTIONS.find(option => option.value === (provider.reasoningEffort || 'default'))?.label || '沿用引擎 / 会话设置'}</dd></div>
          <div><dt>认证方式</dt><dd><Icon name="shield" size={13}/>{provider.hasApiKey ? '密钥已保存' : '无需密钥'}</dd></div>
        </dl>
        {/* 引擎检查与模型连通性分开呈现，避免将启用状态误读为测试成功。 */}
        <p className="custom-provider-readiness"><Icon name="terminal" size={14}/><span>{provider.readiness?.summary || '模型连通性尚未验证，请使用连接测试。'}</span></p>
        <footer className="custom-provider-card-footer">
          <span className="custom-provider-endpoint" title={provider.baseUrl}>{provider.baseUrl}</span>
          <div className="custom-provider-actions">
            <button className="btn compact" aria-label={`配置 / 测试 ${provider.label}`} onClick={() => { setEditing(provider); setError(''); }}>配置 / 测试</button>
            <button className="icon-button" aria-label={`删除 ${provider.label}`} title="删除连接" onClick={() => { setDeleting(provider); setError(''); }}><Icon name="trash" size={15}/></button>
          </div>
        </footer>
      </article>)}
      {!providers.length && <div className="custom-provider-empty"><span className="custom-provider-symbol"><Icon name="plus" size={22}/></span><div><h3>添加你的第一个模型连接</h3><p>接入 Responses 模型服务后，可在团队或 Agent 的执行接口中选择。</p></div></div>}
    </div>}
    {deleting && <div className="notice warning provider-delete-confirmation" role="alert">
      <p>删除「{deleting.label}」及已保存密钥？团队引用需要手动调整；有历史会话引用时会阻止删除。</p>
      <div className="history-actions"><button className="btn compact" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="btn compact danger" disabled={busy} onClick={() => remove(deleting)}>{busy ? '删除中…' : '确认删除'}</button></div>
    </div>}
  </section>;
}
