/* 运行选择独立于配置编辑选择；历史删除只作用于面板记录。 */
function RunsView({ workspace }) {
  const { currentAgents: executionAgents, jobs, logs, runHistory, refreshRunHistory, runAgentId, setRunAgentId,
    setLogs, agentNameById, runHistoryFocus, removeHistory } = workspace;
  const [tab, setTab] = useState(runHistoryFocus ? 'history' : 'current');
  const [historyId, setHistoryId] = useState(runHistoryFocus);
  const [deletion, setDeletion] = useState(null);
  const [sequenceRun, setSequenceRun] = useState(null);
  useEffect(() => { if (runHistoryFocus) { setHistoryId(runHistoryFocus); setTab('history'); workspace.consumeRunHistoryFocus(); } }, [runHistoryFocus]);
  const current = executionAgents.find(agent => agent.id === runAgentId) || executionAgents[0];
  const history = runHistory.find(run => run.runIds.includes(historyId)) || runHistory[0];
  const canDelete = run => run.canDelete;
  const finishedCount = runHistory.filter(canDelete).length;
  const statusLabel = value => ({ completed: '已完成', running: '执行中', starting: '启动中', cancelled: '已停止', failed: '失败' }[value] || value);
  return <div className="runs-workspace">
    <div className="runs-top"><Tabs value={tab} onChange={setTab} items={[[ 'current', '本轮执行'], ['history', '历史记录', runHistory.length], ['events', '事件日志', logs.length]]}/>
      <div className="history-actions">{tab === 'history' && <button className="btn compact danger" disabled={!finishedCount} onClick={() => setDeletion({ all: true })}><Icon name="trash" size={15}/>清空已结束会话</button>}
        <button className="btn compact" onClick={tab === 'history' ? refreshRunHistory : workspace.newTask}><Icon name={tab === 'history' ? 'refresh' : 'plus'} size={15}/>{tab === 'history' ? '刷新' : '新任务'}</button>
      </div>
    </div>
    {tab === 'current' && workspace.executionSyncError && <p className="run-error history-sync-error" role="alert">{workspace.executionSyncError}</p>}
    {tab === 'history' && workspace.historyError && <p className="run-error history-sync-error" role="alert">{workspace.historyError}</p>}
    {tab === 'events' ? <div className="event-document"><div className="section-label section-inline"><h3>本次页面会话事件</h3><button className="text-button" onClick={() => setLogs([])} disabled={!logs.length}>清空日志</button></div>{logs.length ? <div className="event-list">{logs.map(log => <div key={log.id} className="event-row"><time>{log.time}</time><span className="badge">{log.kind}</span><p>{log.message}</p></div>)}</div> : <EmptyState icon="history" title="还没有事件">配置操作和任务运行事件会显示在这里。</EmptyState>}</div> : <div className="run-split">
      <aside className="run-directory"><div className="directory-caption">{tab === 'current' ? '成员运行列表' : '历史会话 · 每个会话一条'}</div>
        {tab === 'current' ? executionAgents.map(agent => <button className={`list-item ${current?.id === agent.id ? 'selected' : ''}`} key={agent.id} onClick={() => setRunAgentId(agent.id)}><Avatar name={agent.name}/><span className="item-copy"><b>{agent.name}</b><small>{jobs[agent.id]?.context?.memberTeamName || workspace.agentTeamById.get(agent.id) || workspace.taskConversation?.context?.teamName} / {STATES[jobs[agent.id]?.status || 'idle']}</small></span><span className={`status-dot ${jobs[agent.id]?.status || ''}`}/></button>) : runHistory.map(run => <button className={`list-item history-item ${history?.runId === run.runId ? 'selected' : ''}`} key={run.conversationKey} onClick={() => setHistoryId(run.runId)}><Icon name="history" size={17}/><span className="item-copy"><b title={run.context?.taskTitle || run.goal}>{shortTaskTitle(run.context?.taskTitle || run.goal)}</b><small>{run.context?.agentName || agentNameById.get(run.agentId) || run.agentId} · {statusLabel(run.status)} · {run.turnCount} 轮</small><small>{run.updatedAt ? new Date(run.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间'}</small></span></button>)}
        {tab === 'history' && !runHistory.length && <div className="quiet-empty">暂无运行记录</div>}
      </aside>
      <section className="output-reader">{tab === 'current' && current ? <>
        <header className="reader-heading"><div><span className="eyebrow">实时输出</span><h2>{current.name}</h2></div><span className={`badge ${jobs[current.id]?.status || 'idle'}`}>{STATES[jobs[current.id]?.status || 'idle']}</span></header>
        {workspace.approvals.filter(approval => approval.runId === jobs[current.id]?.runId).map(approval => <ApprovalCard key={approvalKey(approval)} approval={approval} workspace={workspace}/>)}{jobs[current.id]?.runId ? <RunHistoryReader key={jobs[current.id].runId} run={jobs[current.id]} workspace={workspace}/> : <EmptyState icon="terminal" title="还没有运行输出">发起任务后，这里会实时显示成员的执行结果。</EmptyState>}
      </> : history ? <>
        <header className="reader-heading">
          <div><span className="eyebrow">会话详情</span><div className="history-title-line"><h2>{history.context?.agentName || agentNameById.get(history.agentId) || history.agentId}</h2><span className="badge">{statusLabel(history.status)}</span></div></div>
          <div className="history-actions">
            <button type="button" className="btn compact" onClick={() => setSequenceRun(history)}><Icon name="sequence" size={15}/>时序交互图</button>
            <button type="button" className="btn compact" disabled={workspace.isRunning} onClick={() => workspace.restoreConversation(history)}><Icon name="arrow" size={15}/>在主界面继续</button>
            <button type="button" className="btn compact" disabled={!canDelete(history)} title={canDelete(history) ? '删除整个会话的面板记录' : '请先停止运行并处理待审批事项'} onClick={() => setDeletion({ runId: history.runId, title: history.context?.taskTitle || history.goal, turns: history.turnCount })}><Icon name="trash" size={15}/>删除会话</button>
          </div>
        </header>
        <div className="history-detail"><h3>任务目标</h3><MarkdownContent text={history.context?.taskTitle || history.goal}/><details className="history-metadata"><summary>查看执行信息</summary><dl>{[
          ['任务发起人', officeSourceLabel(history.context)],
          ['接力来源', history.context?.handoffFrom?.name || history.context?.handoffFrom?.agentId || '无前序成员'],
          ['执行团队', history.context?.teamName || '未记录'], ['执行接口', history.adapter],
          ['工作目录', history.cwd || '默认目录'], ['会话 ID', history.threadId || '—'], ['运行 ID', history.runId]
        ].map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl></details><RunConversation key={history.runId} run={history} workspace={workspace}/></div>
      </> : <EmptyState icon="history" title="选择一条运行记录">完成任务后，服务端记录会显示在左侧。</EmptyState>}</section>
    </div>}
    {sequenceRun && ReactDOM.createPortal(<InteractionSequenceDialog key={sequenceRun.runId} run={sequenceRun} workspace={workspace} onClose={() => setSequenceRun(null)}/>, document.body)}
    {deletion && <ConfirmDialog title={deletion.all ? '清空已结束的会话？' : '删除这个会话？'} action={deletion.all ? '清空已结束会话' : '删除会话'} onClose={() => setDeletion(null)} onConfirm={async () => { await removeHistory(deletion.all ? null : deletion.runId); setDeletion(null); }}>
      <p>{deletion.all ? '将清空已结束会话的全部轮次；仍在运行或等待审批的会话会完整保留。' : `${deletion.title}（共 ${deletion.turns} 轮）`}</p><p>仅删除面板中的历史记录，不影响项目文件和 Codex 会话。此操作无法撤销。</p>
    </ConfirmDialog>}
  </div>;
}
