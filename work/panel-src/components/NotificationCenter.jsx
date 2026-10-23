/* 右上角主动打开的非模态面板，不抢焦点、不挡住整个工作区。 */
function NotificationCenter({ workspace }) {
  const { notifications: notices, approvals, approvalError } = workspace;
  const root = useRef(null), trigger = useRef(null);
  useEffect(() => {
    if (!notices.open) return;
    const pointer = event => { if (!root.current?.contains(event.target)) notices.setOpen(false); };
    const key = event => { if (event.key === 'Escape') { notices.setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); };
  }, [notices.open]);
  const count = approvals.length + notices.unread;
  const visit = async item => {
    try {
      const data = await workspace.runtime.current.request(`/api/runs/${encodeURIComponent(item.runId)}/conversation`);
      workspace.restoreConversation(data.summary); notices.markRead([item.id]); notices.setOpen(false);
    } catch (cause) { workspace.setToast(`打开任务失败：${cause.message}`); }
  };
  return <div className="notification-anchor" ref={root}>
    <button ref={trigger} className={`notification-trigger ${count ? 'has-notices' : ''}`} aria-label={`消息通知${count ? `，${count} 项未处理` : ''}`} aria-expanded={notices.open} aria-controls="notification-center" onClick={() => { notices.setOpen(!notices.open); notices.setPreview(null); }}><Icon name="bell" size={18}/>{count > 0 && <span>{count > 99 ? '99+' : count}</span>}</button>
    {notices.preview && !notices.open && <div className="notification-preview" role="status"><button onClick={() => { notices.setOpen(true); notices.setPreview(null); }}><b>{notices.preview.text}</b><span>{notices.preview.detail}</span></button><button className="icon-button" aria-label="关闭消息提示" onClick={() => notices.setPreview(null)}><Icon name="close" size={14}/></button></div>}
    {notices.open && <section id="notification-center" className="notification-center" aria-label="消息中心"><header><div><h3>消息中心</h3><small>{approvals.length} 项待确认 · {notices.unread} 条未读通知</small></div><button className="icon-button" aria-label="关闭消息中心" onClick={() => notices.setOpen(false)}><Icon name="close"/></button></header>
      <div className="notification-list">{approvalError && <p className="run-error" role="alert">{approvalError}</p>}{notices.error && <p className="run-error" role="alert">{notices.error}</p>}
        {approvals.length > 0 && <h4>需要你确认</h4>}{approvals.map(approval => <ApprovalCard key={approvalKey(approval)} approval={approval} workspace={workspace}/>)}
        <div className="notification-section"><h4>任务通知</h4><div className="notification-actions">
          <button type="button" className="text-button" disabled={!notices.unread} onClick={() => notices.markRead(notices.items.map(item => item.id))}>全部标为已读</button>
          <button type="button" className="text-button" disabled={!notices.items.some(item => notices.readIds.has(item.id))} onClick={() => notices.dismiss(notices.items.filter(item => notices.readIds.has(item.id)).map(item => item.id))}>清除已读</button>
          <button type="button" className="text-button" disabled={!notices.items.length} onClick={() => notices.dismiss(notices.items.map(item => item.id))}>清空通知</button>
        </div></div>
        {notices.undoCount > 0 && <div className="notification-clear-feedback" role="status"><span>已清除 {notices.undoCount} 条通知</span><button type="button" className="text-button" onClick={notices.undoDismiss}>撤销</button></div>}
        {notices.items.map(item => <article className={`delivery-notice ${notices.readIds.has(item.id) ? 'is-read' : ''}`} key={item.id}><div className="delivery-notice-heading"><b>{item.title}</b><span>第 {item.round} 轮</span><button type="button" className="icon-button" aria-label={`清除此通知：${item.taskTitle || item.title} · 第 ${item.round} 轮`} title="清除此通知" onClick={() => notices.dismiss([item.id])}><Icon name="close" size={14}/></button></div><p title={item.taskTitle}>{shortTaskTitle(item.taskTitle)}</p><small>{displayTime(item.createdAt)}</small><p className="delivery-notice-summary">{item.summary}</p><button className="text-button" onClick={() => visit(item)}>查看任务与对话 <Icon name="arrow" size={13}/></button></article>)}
        {!notices.items.length && <p className="muted">暂无任务通知。交付、执行失败、服务中断与审批/反馈超时会显示在这里。</p>}
        <p className="notification-clear-hint">清除通知不删除任务历史；待确认的权限请求会保留。</p>
      </div></section>}
  </div>;
}
