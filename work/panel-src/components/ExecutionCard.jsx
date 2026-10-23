/* 每次执行独立成卡；执行过程和单条操作详情默认折叠，成员状态保持可见。 */

function ExecutionCard({ run, roundNumber, attempt, previousExecution, workspace, connectionLost = false }) {
  const [activityOpen, setActivityOpen] = useState(false), [detail, setDetail] = useState(null), [detailError, setDetailError] = useState('');
  useEffect(() => {
    if (!activityOpen || !run.compact) return;
    return workspace.runtime.current.watchResource(`/api/runs/${encodeURIComponent(run.runId)}?view=compact`, {
      onData: value => { setDetail(value); setDetailError(''); }, onError: cause => setDetailError(cause.message)
    });
  }, [run.runId, activityOpen, run.compact]);
  const record = detail?.runId === run.runId ? detail : run;
  const currentJob = conversationJob(run), active = ACTIVE_JOB_STATES.includes(currentJob.status);
  const job = active && connectionLost ? { ...currentJob, status: 'reconnecting', activity: '实时连接中断，正在重新连接' } : currentJob;
  const messages = conversationMessages(record);
  const steps = record.progress?.steps || job.steps || [];
  const name = run.context?.agentName || workspace.agentNameById.get(run.agentId) || run.agentId;
  const approvals = workspace.approvals.filter(approval => approval.runId === run.runId);
  return <section id={`execution-${run.runId}`} className={`execution-card ${active ? 'is-active' : ''}`} aria-label={`第 ${roundNumber} 轮 ${name} 第 ${attempt} 次执行`}>
    <header className="execution-heading"><Avatar name={name}/><div><b>{name}</b><small>第 {roundNumber} 轮 · 第 {attempt} 次执行{attempt > 1 ? ' · 再次处理' : ''} · {run.context?.coordinatorRunId ? `${run.context.source?.name || '项目经理'} 派发` : '接收用户要求'}</small></div><span className={`badge ${job.status}`}>{job.status === 'waiting' && job.phase === 'waiting-manager' ? '等待经理答复' : STATES[job.status]}</span></header>
    <div className="execution-times"><span>开始 <time>{displayTime(run.startedAt || run.createdAt)}</time></span>{run.endedAt && <span>结束 <time>{displayTime(run.endedAt)}</time></span>}</div>
    {run.threadMigration && <p className="conversation-config-note">会话兼容升级：{run.threadMigration.reason}</p>}
    {run.context?.coordinatorRunId && <details className="execution-assignment"><summary>本次分工：{assignmentText(run)?.slice(0, 110)}</summary><MarkdownContent text={assignmentText(run)}/></details>}
    {attempt > 1 && <p className="execution-attempt-note"><span>以下仅统计第 {attempt} 次执行，之前的过程保留在对应执行记录中。</span>{previousExecution ? <button className="text-button" onClick={() => {
      const previous = document.getElementById(`execution-${previousExecution.runId}`);
      const activity = previous?.querySelector('.execution-activity');
      if (activity) activity.open = true;
      previous?.scrollIntoView({ block: 'start' });
      activity?.querySelector('summary')?.focus({ preventScroll: true });
    }}>查看上次执行（第 {attempt - 1} 次）</button> : <span>请先加载更早记录。</span>}</p>}
    <RunProgress job={job} showSteps={false}/>
    <ExecutionReasoning job={job}/>
    <TeamFeedback feedback={run.feedback}/>
    {approvals.map(approval => <ApprovalCard key={approvalKey(approval)} approval={approval} workspace={workspace}/>)}
    {/* 不绑定 open，避免状态和流式更新重置用户选择的展开状态。 */}
    <details className="execution-activity" aria-label={`${name}的执行过程`} onToggle={event => { if (event.target === event.currentTarget) setActivityOpen(event.currentTarget.open); }}>
      <summary><Icon name="terminal" size={15}/><b>执行过程</b><span>本次执行：{run.operationCount ?? steps.length} 条操作 · {run.messageCount ?? messages.length} 条进展与结果</span><Icon name="down" size={14}/></summary>
      {activityOpen && <>{detailError && <p className="run-error">{detailError}</p>}<ExecutionTranscript messages={messages} steps={steps} active={active}/>{record.transcriptUrl && <p><a href={record.transcriptUrl}>下载完整执行记录</a>{record.transcriptTruncated && ' · 页面仅显示最近内容和正文预览，下载包含已保存全文。'}</p>}</>}
    </details>
  </section>;
}
const MemoExecutionCard = React.memo(ExecutionCard);
function DeliveryResult({ delivery }) {
  return <div className="delivery-result"><b>{delivery.mode === 'reply' ? '已回复' : delivery.mode === 'report' ? '报告已完成' : '已验收交付'}</b><MarkdownContent text={delivery.mode === 'reply' ? delivery.reply || delivery.summary : delivery.summary}/>{delivery.truncated && delivery.runId && <p><a href={`/api/runs/${encodeURIComponent(delivery.runId)}/transcript`}>下载完整交付与执行记录</a></p>}{delivery.artifacts?.length > 0 && <><h5>交付文件</h5><ul>{delivery.artifacts.map(file => <li key={file}>{file}</li>)}</ul></>}{delivery.verification?.length > 0 && <details><summary>{delivery.mode === 'report' ? '检查依据与验证限制' : '验证结果'}</summary><ul>{delivery.verification.map((value, i) => <li key={i}><MarkdownContent text={value}/></li>)}</ul></details>}</div>;
}
function ConversationRound({ round, runs, workspace, connectionLost = false }) {
  const executionsRef = useRef(null);
  const active = !['completed', 'failed', 'cancelled'].includes(round.status);
  // 终态只更新内容，不重建整组卡片，否则摘要和操作详情的阅读状态都会丢失。
  const [executionsOpen, setExecutionsOpen] = useState(active);
  const manager = runs.find(run => run.coordination), delivery = round.delivery || manager?.coordination, delivered = delivery?.status === 'completed' && round.status === 'completed';
  return <article className="task-round" aria-label={`第 ${round.number} 轮对话`}>
    <header className="task-round-heading"><b>第 {round.number} 轮</b><time>{displayTime(round.createdAt)}</time><span className="badge">{taskStatusLabel(round.status)}</span></header>
    <div className="round-request"><span>你的要求</span><MarkdownContent text={round.goal}/></div>
    {active && <div className="round-member-status" aria-label="本轮成员状态">{[...new Map(runs.map(run => [run.agentId, run])).values()].map(run => { const job = conversationJob(run); return <button key={run.agentId} onClick={() => { executionsRef.current.open = true; document.getElementById(`execution-${run.runId}`)?.scrollIntoView({ block: 'nearest' }); }}><span className={`status-dot ${job.status}`}/><b>{run.context?.agentName || run.agentId}</b><span>{job.activity || STATES[job.status]}</span></button>; })}</div>}
    <details ref={executionsRef} className="round-executions" open={executionsOpen} onToggle={event => {
      if (event.target === event.currentTarget) setExecutionsOpen(event.currentTarget.open);
    }}><summary><Icon name="team" size={16}/><b>成员执行</b><span>{round.runIds.length} 次执行 · {round.memberCount} 位成员{runs.length < round.runIds.length ? '（部分记录尚未加载）' : ''}</span><Icon name="down" size={14}/></summary>
      {runs.map((run, index) => <MemoExecutionCard key={run.runId} run={run} roundNumber={round.number} attempt={round.attemptByRun?.[run.runId] || 1} previousExecution={runs.slice(0, index).findLast(previous => previous.agentId === run.agentId)} workspace={workspace} connectionLost={connectionLost}/>)}
    </details>
    {delivered ? <DeliveryResult delivery={delivery}/> : !active && <p className="round-outcome">{manager?.coordination?.mode === 'reply' ? '本轮答复尚未完成，请查看失败原因，可在此会话继续。' : delivery ? '本轮尚未完成交付验收，可继续说明问题，由项目经理安排处理。' : '本轮执行已结束，展开成员执行查看回复与结果。'}</p>}
  </article>;
}
