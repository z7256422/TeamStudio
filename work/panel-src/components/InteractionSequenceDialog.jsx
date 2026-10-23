const SEQUENCE_KINDS = { request: '用户需求', dispatch: '任务派发', result: '返回结果', delivery: '验收交付', message: '成员消息', progress: '公开进展', operation: '执行操作', failure: '失败 / 停止' };
function sequenceExcerpt(value, length = 28) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(0, length) + '…' : text;
}
function SequenceChart({ actors, events, selectedId, onSelect, zoom }) {
  const lane = 168, gutter = 132, width = Math.max(680, gutter + actors.length * lane + 64), rowHeight = 96;
  const centers = new Map(actors.map((actor, index) => [actor.id, gutter + lane * (index + .5)]));
  const actorById = new Map(actors.map(actor => [actor.id, actor]));
  return <div className="sequence-canvas" style={{ width: width * zoom }}>
    <div className="sequence-actor-header" style={{ height: 76 * zoom }}><svg width={width * zoom} height={76 * zoom} viewBox={`0 0 ${width} 76`} aria-label="参与者">
      <text x="18" y="40" className="sequence-axis-label">时间 / 轮次</text>
      {actors.map(actor => <g key={actor.id}><rect x={centers.get(actor.id) - 70} y="12" width="140" height="50" rx="8"/><text x={centers.get(actor.id)} y="34" textAnchor="middle" className="sequence-actor-name">{sequenceExcerpt(actor.name, 10)}</text><text x={centers.get(actor.id)} y="51" textAnchor="middle" className="sequence-actor-role">{sequenceExcerpt(actor.role || '成员', 19)}</text><title>{actor.name}{actor.role ? ' · ' + actor.role : ''}</title></g>)}
    </svg></div>
    <svg className="sequence-chart" width={width * zoom} height={(events.length * rowHeight + 16) * zoom} viewBox={`0 0 ${width} ${events.length * rowHeight + 16}`} aria-label="成员时序交互图">
      {actors.map(actor => <line key={actor.id} x1={centers.get(actor.id)} x2={centers.get(actor.id)} y1="0" y2={events.length * rowHeight + 16} className="sequence-lifeline"/>)}
      {events.map((event, index) => {
        const from = centers.get(event.from), to = centers.get(event.to), self = from === to, y = index * rowHeight + 46;
        const right = to > from, endY = self ? y + 20 : y;
        const arrow = self ? `${to + 7},${endY - 4} ${to},${endY} ${to + 7},${endY + 4}` : `${to + (right ? -8 : 8)},${y - 4} ${to},${y} ${to + (right ? -8 : 8)},${y + 4}`;
        const labelX = self ? from + 10 : (from + to) / 2;
        const labelLength = self ? 16 : Math.max(14, Math.floor(Math.abs(to - from) / 11));
        const time = event.time == null ? '时间未记录' : new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false });
        return <g key={event.id} role="button" tabIndex="0" aria-pressed={selectedId === event.id} aria-label={`${actorById.get(event.from)?.name} → ${actorById.get(event.to)?.name}：${event.title}，第 ${event.roundNumber} 轮，${time}`} className={`sequence-event sequence-${event.kind} ${selectedId === event.id ? 'selected' : ''}`} onClick={() => onSelect(event.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(event.id); } }}>
          <rect x="4" y={index * rowHeight + 2} width={width - 8} height={rowHeight - 4} rx="6" className="sequence-event-hit"/>
          <text x="18" y={y - 9} className="sequence-event-round">第 {event.roundNumber} 轮</text><text x="18" y={y + 10} className="sequence-event-time">{time}</text>
          <path d={self ? `M ${from} ${y} H ${from + 60} V ${endY} H ${to}` : `M ${from} ${y} H ${to}`} className={'sequence-arrow ' + (event.response ? 'is-response' : '')}/><polyline points={arrow} className="sequence-arrow-head"/>
          <text x={labelX} y={y - 12} textAnchor={self ? 'start' : 'middle'} className="sequence-event-title">{sequenceExcerpt(event.title, labelLength)}</text>
          <text x={labelX} y={self ? y + 39 : y + 22} textAnchor={self ? 'start' : 'middle'} className="sequence-event-preview">{sequenceExcerpt(event.content || event.error, labelLength)}</text>
          <title>{event.title} · {event.time == null ? '时间未记录' : displayTime(event.time)} · 点击查看完整内容</title>
        </g>;
      })}
    </svg>
  </div>;
}
function SequenceEventDetails({ event, actors }) {
  if (!event) return <aside className="sequence-details"><EmptyState icon="chat" title="查看交互详情">点击图中的箭头，查看发起内容和返回结果。</EmptyState></aside>;
  const name = id => actors.find(actor => actor.id === id)?.name || '未知成员';
  const status = STATES[event.status] || taskStatusLabel(event.status);
  const duration = event.time != null && event.endedAt != null ? Math.max(0, (event.endedAt - event.time) / 1000) : null;
  return <aside className="sequence-details" aria-label="交互详情">
    <div className="sequence-detail-heading"><span className={'sequence-kind sequence-' + event.kind}>{SEQUENCE_KINDS[event.kind]}</span>{status && <span className={'badge ' + (event.status === 'completed' ? 'done' : event.status)}>{status}</span>}<h4>{event.title}</h4><p>{name(event.from)} <span aria-hidden="true">→</span> {name(event.to)}</p></div>
    <dl><dt>所属轮次</dt><dd>第 {event.roundNumber} 轮 · 第 {event.attempt} 次执行</dd><dt>时间</dt><dd>{event.time == null ? '未记录' : displayTime(event.time)}</dd>{event.endedAt != null && <><dt>结束时间</dt><dd>{displayTime(event.endedAt)}{duration != null ? `（${duration.toFixed(1)} 秒）` : ''}</dd></>}{event.exitCode != null && <><dt>退出码</dt><dd>{event.exitCode}</dd></>}</dl>
    {event.content && <section><h5>{event.kind === 'operation' ? '执行内容' : ['result', 'failure'].includes(event.kind) ? '返回内容' : event.kind === 'delivery' ? '交付摘要' : '发起内容'}</h5><pre>{event.content}</pre></section>}
    {event.output && <section><h5>{event.kind === 'operation' ? '执行输出' : '成员回复'}</h5><pre>{event.output}</pre></section>}
    {event.error && <p className="run-error">{event.error}</p>}
    {!!event.artifacts?.length && <section><h5>交付文件</h5><ul>{event.artifacts.map((file, index) => <li key={index}>{file}</li>)}</ul></section>}
    {!!event.verification?.length && <section><h5>验证结果</h5><ul>{event.verification.map((value, index) => <li key={index}>{value}</li>)}</ul></section>}
    {!event.content && !event.output && !event.error && <p className="muted">此事件未记录正文。</p>}
    {event.note && <p className="sequence-detail-note">{event.note}</p>}
    <details className="sequence-source"><summary>记录来源</summary><p>运行 ID：{event.runId}</p>{event.runId && <p><a href={`/api/runs/${encodeURIComponent(event.runId)}/transcript`}>下载完整执行记录</a></p>}{event.replyTo && <p>回复消息 ID：{event.replyTo}</p>}</details>
  </aside>;
}
function InteractionSequenceDialog({ run, workspace, onClose }) {
  const dialog = useRef(null), scroll = useRef(null);
  const { data, error, loading, updatedAt, offset, earlier, newer, refresh } = useInteractionSequence(run.runId, workspace.runtime);
  const [roundId, setRoundId] = useState('all'), [actorId, setActorId] = useState('all'), [detailed, setDetailed] = useState(false);
  const [selectedId, setSelectedId] = useState(null), [page, setPage] = useState(0), [zoom, setZoom] = useState(1);
  const sequence = React.useMemo(() => buildInteractionSequence(data, workspace.messages), [data, workspace.messages]);
  const events = React.useMemo(() => filterInteractionEvents(sequence, { roundId, actorId, detailed }), [sequence, roundId, actorId, detailed]);
  const pageSize = 80, pages = Math.max(1, Math.ceil(events.length / pageSize)), currentPage = Math.min(page, pages - 1);
  const visible = events.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const actorIds = new Set(events.flatMap(event => [event.from, event.to]));
  const actors = sequence.actors.filter(actor => actorIds.has(actor.id));
  const selected = visible.find(event => event.id === selectedId) || null;
  const close = () => { dialog.current?.close(); onClose(); };
  useEffect(() => { const element = dialog.current; element.showModal(); return () => element.close(); }, []);
  useEffect(() => { setPage(0); setSelectedId(null); if (scroll.current) scroll.current.scrollTop = 0; }, [roundId, actorId, detailed, offset]);
  useEffect(() => { setRoundId('all'); setActorId('all'); }, [offset]);
  return <dialog ref={dialog} className="sequence-dialog" aria-label="时序交互图" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="dialog-top"><div><span className="eyebrow">会话回放</span><h3>时序交互图</h3><p title={run.context?.taskTitle || run.goal}>{shortTaskTitle(run.context?.taskTitle || run.goal)}</p></div><button type="button" className="icon-button" aria-label="关闭时序交互图" onClick={close}><Icon name="close"/></button></header>
    <div className="sequence-controls">
      <label>轮次<select aria-label="筛选交互轮次" value={roundId} onChange={e => setRoundId(e.target.value)}><option value="all">全部轮次</option>{sequence.rounds.map(round => <option key={round.id} value={round.id}>第 {round.number} 轮</option>)}</select></label>
      <label>参与者<select aria-label="筛选交互参与者" value={actorId} onChange={e => setActorId(e.target.value)}><option value="all">全部参与者</option>{sequence.actors.map(actor => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</select></label>
      <label className="sequence-detail-toggle"><input type="checkbox" checked={detailed} onChange={e => setDetailed(e.target.checked)}/>显示执行细节</label>
      <label>缩放<select aria-label="时序图缩放" value={zoom} onChange={e => setZoom(Number(e.target.value))}>{[.75, 1, 1.25, 1.5].map(value => <option key={value} value={value}>{value * 100}%</option>)}</select></label>
      <button type="button" className="btn compact" disabled={loading} onClick={refresh}><Icon name="refresh" size={14}/>{loading ? '读取中…' : '刷新'}</button>
    </div>
    <div className="sequence-legend"><span><i className="sequence-request"/>发起 / 派发</span><span><i className="sequence-result"/>返回 / 交付（虚线）</span><span><i className="sequence-message"/>成员消息</span><span><i className="sequence-operation"/>自身操作（回环）</span><span><i className="sequence-failure"/>失败 / 停止</span><small>{actors.length} 位参与者 · {events.length} 条交互</small></div>
    {error && <p className="run-error sequence-error" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={refresh}>重试</button></p>}
    {data && <p className="sequence-coverage">当前范围：最近第 {data.offset + 1}–{data.offset + data.runs.length} 次 / 共 {data.total} 次执行；筛选仅作用于当前范围。正文为预览，完整内容可从「记录来源」下载。{data.hasEarlier && <button className="text-button" disabled={loading} onClick={earlier}>更早执行</button>}{data.hasNewer && <button className="text-button" disabled={loading} onClick={newer}>较新执行</button>}</p>}
    {!!sequence.warnings.length && <details className="sequence-coverage"><summary>记录完整性说明</summary>{sequence.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
    <div className="sequence-body" aria-busy={loading}>
      <div className="sequence-scroll" ref={scroll}>{!data ? <EmptyState icon="history" title={loading ? '正在读取交互记录…' : '未能读取记录'}>{error ? '可点击上方重试。' : '正在还原本会话的派发与返回关系。'}</EmptyState> : !events.length ? <EmptyState icon="chat" title="没有符合条件的交互">调整轮次、参与者或显示执行细节。</EmptyState> : <SequenceChart actors={actors} events={visible} selectedId={selectedId} onSelect={setSelectedId} zoom={zoom}/>}</div>
      <SequenceEventDetails event={selected} actors={sequence.actors}/>
    </div>
    <footer className="sequence-footer"><span>{updatedAt ? `更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '等待加载'}{data && !['completed', 'failed', 'cancelled'].includes(data.summary?.status) ? ' · 执行中自动更新' : ''}</span><div><button type="button" className="btn compact" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelectedId(null); scroll.current.scrollTop = 0; }}>上一段</button><span>{events.length ? `${currentPage * pageSize + 1}–${Math.min(events.length, (currentPage + 1) * pageSize)} / ${events.length}` : '0 条交互'}</span><button type="button" className="btn compact" disabled={currentPage >= pages - 1} onClick={() => { setPage(currentPage + 1); setSelectedId(null); scroll.current.scrollTop = 0; }}>下一段</button></div></footer>
  </dialog>;
}
