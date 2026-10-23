/* 摘要与公开回复分区；新分析阶段展开一次，结束时保留用户的展开/收起状态。 */
function ExecutionReasoning({ job }) {
  const entries = job.reasoningSummaries || [], latest = entries.at(-1);
  const active = ACTIVE_JOB_STATES.includes(job.status);
  const thinking = active && job.phase === 'thinking';
  const streaming = thinking && job.status === 'running' && (!latest || latest.status === 'streaming');
  const phaseKey = `${job.runId || ''}:${latest?.id || 'pending'}:${streaming}`;
  const [open, setOpen] = useState(streaming);
  const bodyRef = useRef(null), followRef = useRef(true);
  const bodyId = React.useId();
  useEffect(() => { if (streaming) { setOpen(true); followRef.current = true; } }, [phaseKey]);
  useEffect(() => {
    const element = bodyRef.current;
    if (open && streaming && element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [entries, open, streaming]);
  if (!entries.length && !thinking) return null;
  const label = job.status === 'reconnecting' ? '连接恢复中' : streaming ? '正在分析' : active && latest?.status === 'streaming' ? '等待继续' : latest?.status === 'interrupted' ? '分析已中断' : '分析已结束';
  return <section className={`execution-reasoning ${streaming ? 'is-streaming' : ''}`} aria-label="思考摘要">
    <button type="button" className="reasoning-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      <span className="reasoning-indicator"/><b>思考摘要</b><span className="reasoning-state">{label}</span>
      <small>{entries.length > 0 ? `${entries.length} 段` : '等待摘要'}</small><Icon name="down" size={14}/>
    </button>
    <div className="reasoning-body" id={bodyId} hidden={!open} ref={bodyRef} onScroll={event => {
      const element = event.currentTarget; followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    }}>
      <p className="reasoning-note">引擎提供的分析摘要 · 进展与结果见执行过程</p>
      {!entries.length && <p className="reasoning-empty">正在分析任务，等待引擎提供可展示的摘要…</p>}
      {open && entries.map((entry, index) => <article className="reasoning-segment" key={entry.id}>
        <header><b>分析 {entry.number || index + 1}</b><span>{entry.status === 'streaming' && active ? label : entry.status === 'interrupted' ? '已中断' : '已结束'}</span><time>开始 {displayTime(entry.startedAt)}</time></header>
        {entry.parts.some(Boolean) ? entry.parts.map((part, partIndex) => part && <MarkdownContent key={partIndex} text={part}/>) : <p className="reasoning-empty">{entry.status === 'streaming' && active ? '等待引擎提供可展示的摘要…' : '本次分析未提供可展示的摘要。'}</p>}
        {entry.truncated && <p className="reasoning-note">摘要较长，已按保存上限截取。</p>}
        {entry.endedAt && <footer>结束 {displayTime(entry.endedAt)}</footer>}
      </article>)}
    </div>
    <div className="reasoning-last-update">最近活动 <time>{displayTime(latest?.updatedAt || job.updatedAt || job.startedAt)}</time>{streaming && <span> · 摘要到达后自动更新</span>}</div>
  </section>;
}
