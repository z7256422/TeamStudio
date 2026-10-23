/* 以历史会话为上下文；切换页面不取消已提交的后续轮次，重新打开后继续同步。 */
function RunConversation({ run, workspace, layout = 'history' }) {
  const [conversation, setConversation] = useState(null), [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false), [stopping, setStopping] = useState(false);
  const limit = 20;
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0), [pendingText, setPendingText] = useState('');
  const sendingRef = useRef(false), alive = useRef(true), bottomRef = useRef(null), shouldFollow = useRef(false);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setOffset(0); setConversation(null); setDraft(''); setError(''); }, [run.runId]);
  useEffect(() => {
    return workspace.runtime.current.watchResource(`/api/runs/${encodeURIComponent(run.runId)}/conversation?limit=${limit}&view=compact&offset=${offset}`, {
      onData: data => { setConversation(data); setSyncError(''); },
      onError: cause => setSyncError(`读取对话失败：${cause.message}`)
    });
  }, [run.runId, revision, limit, offset]);
  useEffect(() => { if (shouldFollow.current) bottomRef.current?.scrollIntoView({ block: 'nearest' }); }, [conversation, pendingText]);
  const turns = conversation?.runs || [];
  const rounds = (conversation?.rounds || []).filter(round => round.runIds.some(id => turns.some(turn => turn.runId === id)));
  const latest = conversation?.summary?.continuationRunId || run.runId;
  const coordination = conversation?.summary?.coordination || run.coordination;
  const active = turns.find(turn => !['completed', 'cancelled', 'failed'].includes(turn.status)) ||
    (conversation?.summary && !['completed', 'cancelled', 'failed'].includes(conversation.summary.status) ? { runId: latest } : null);
  const legacyManagement = legacyTaskManagement(run, workspace.config);
  const blocked = sending || active || !conversation?.canContinue || workspace.isRunning;
  const send = async (event, goalOverride = '') => {
    event?.preventDefault();
    if (sendingRef.current || blocked || !(goalOverride || draft).trim()) return;
    const text = (goalOverride || draft).trim(); sendingRef.current = true; setSending(true); setError(''); setPendingText(text); shouldFollow.current = true;
    try {
      // 续接由服务端根据选中记录恢复参数，当前团队和 Agent 表单不会覆盖历史上下文。
      await workspace.runtime.current.request(`/api/runs/${encodeURIComponent(latest)}/continue`, { method: 'POST', body: JSON.stringify({ goal: text, ...(!coordination && legacyManagement ? { management: legacyManagement } : {}) }) }, 150000);
      workspace.refreshRunHistory();
      if (alive.current) { setDraft(''); setOffset(0); refresh(); }
    } catch (cause) { if (alive.current) { setError(`发送失败：${cause.message}`); refresh(); } }
    finally { sendingRef.current = false; if (alive.current) { setSending(false); setPendingText(''); } }
  };
  const stop = async () => {
    if (!active || stopping) return;
    setStopping(true); setError('');
    try { await workspace.runtime.current.request(`/api/runs/${encodeURIComponent(coordination ? latest : active.runId)}/cancel`, { method: 'POST' }); refresh(); workspace.refreshRunHistory(); }
    catch (cause) { setError(`停止失败：${cause.message}`); }
    finally { setStopping(false); }
  };
  return <section className={`run-conversation ${layout === 'task' ? 'task-run-conversation' : ''}`} aria-label="历史会话对话">
    <header className="conversation-heading"><div><h3>任务对话</h3><p>每次提交为一轮，成员分工与返工收纳在对应轮次内。</p></div><span className="badge">{conversation?.summary?.turnCount || run.turnCount || 1} 轮对话 · {conversation?.total || run.executionCount || 1} 次执行</span></header>
    {/* 配置说明和交付证据随正文滚动，避免挤出底部续聊按钮。 */}
    <div className="conversation-turns" onWheel={() => { shouldFollow.current = false; }} onTouchMove={() => { shouldFollow.current = false; }}>
    <p className="conversation-config-note">{coordination ? '普通问题由项目经理直接答复，实际任务按需安排成员。续聊沿用团队快照，并按新要求判断成果类型；停止会同时停止已派发成员。' : legacyManagement ? '这是一条旧版规划任务，尚未交付。继续时会采用当前原团队的成员配置启用真实调度，保留此前计划和历史。' : '沿用原成员、目录、模型和角色指令；后续团队配置修改不会自动套用。本次由该成员继续执行。'}</p>
    {!coordination && legacyManagement && <div className="team-delivery"><b>计划已生成，开发尚未完成</b><p>项目经理将接管后续开发、测试和交付；成员仅在收到派发后执行。</p><button className="btn primary" disabled={!!blocked} onClick={event => send(event, '继续完成原任务。请基于已有计划实际派发所需成员，完成开发、测试、返工和交付验收，不要止步于计划。')}>让项目经理继续交付</button></div>}
    {conversation?.total > turns.length && <p className="older-executions">本页 {turns.length} 次 / 共 {conversation.total} 次执行。{conversation.hasEarlier && <button className="text-button" onClick={() => setOffset(value => value + limit)}>更早记录</button>}{conversation.hasNewer && <button className="text-button" onClick={() => setOffset(value => Math.max(0, value - limit))}>较新记录</button>}{offset > 0 && <button className="text-button" onClick={() => setOffset(0)}>返回最新</button>}</p>}
    {error && <p className="run-error" role="alert">{error}</p>}
    {syncError && <p className="run-error" role="alert">{syncError}</p>}
    {!conversation && !syncError && <p className="muted">正在读取会话…</p>}
      {rounds.map(round => <ConversationRound key={round.id} round={round} runs={turns.filter(turn => round.runIds.includes(turn.runId))} workspace={workspace} connectionLost={!!syncError}/>)}
      {pendingText && !turns.some(turn => !['completed', 'failed', 'cancelled'].includes(turn.status) && turn.goal === pendingText) && <div className="conversation-user pending"><b>正在发送</b><MarkdownContent text={pendingText}/></div>}
      {layout === 'task' && <div ref={bottomRef}/>}
    </div>
    <form className="continuation-composer" onSubmit={send}>
      <label htmlFor="continuation-input">继续此会话</label><textarea id="continuation-input" rows="3" maxLength="12000" value={draft} disabled={sending} onChange={event => setDraft(event.target.value)} placeholder="例如：刚才的修改有个问题，请沿用上面的上下文修复…" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) send(event); }}/>
      <div className="continuation-actions"><p>{active ? '此会话正在执行，可以先编辑下一条要求。' : conversation?.blockedReason || (workspace.isRunning ? '请等待本轮团队任务结束。' : '在这条会话最新上下文上继续 · Ctrl / ⌘ + Enter 发送')}</p>{active ? <button type="button" className="btn danger" disabled={stopping} onClick={stop}><Icon name="stop" size={14}/>{stopping ? '停止中…' : '停止此运行'}</button> : <button type="submit" className="btn primary" disabled={!!blocked || !draft.trim()}><Icon name="up" size={15}/>{sending ? '正在恢复会话…' : '发送并继续'}</button>}</div>
    </form>
    {layout !== 'task' && <div ref={bottomRef}/>}
  </section>;
}
