function OperationSummary({ entry }) {
  const status = executionOperationStatus(entry);
  const label = entry.kind === 'command' ? ({ done: '已执行', failed: '执行失败', cancelled: '已停止', running: '正在执行' })[status] || entry.label : entry.label;
  const preview = entry.kind === 'command' ? executionCommandPreview(entry.detail) : String(entry.detail || '').replace(/\s+/g, ' ').trim();
  return <><Icon name={entry.kind === 'command' ? 'terminal' : entry.label === '修改文件' ? 'file' : 'plug'} size={14}/><span className={`transcript-operation-label ${status}`}>{label}</span>{preview && <span className="transcript-operation-preview" title={preview}>{preview}</span>}{entry.kind !== 'command' && !['done', 'unknown'].includes(status) && <span className={`transcript-operation-state ${status}`}>{STATES[status] || status}</span>}<Icon name="down" size={13}/></>;
}
function OperationPanel({ entry }) {
  const status = executionOperationStatus(entry);
  return <section className="transcript-operation-panel" aria-label={`${entry.label}详情`}>
    <header><span>{entry.kind === 'command' ? 'Shell' : entry.label}</span></header>
    <div className="transcript-operation-output" tabIndex={0} aria-label="命令与输出">
      {entry.detail && <pre className="transcript-command"><code>{entry.kind === 'command' ? '$ ' : ''}{entry.detail}</code></pre>}
      {entry.output ? <pre><code>{entry.output}</code></pre> : <p className="muted">{['done', 'failed', 'cancelled'].includes(status) ? '未记录输出' : '等待工具返回输出…'}</p>}
    </div>
    <footer><span className="transcript-operation-times"><span>开始 <time>{displayTime(entry.time)}</time></span>{entry.endedAt && <span>结束 <time>{displayTime(entry.endedAt)}</time></span>}</span><span className={`transcript-exit ${status}`}>{entry.exitCode != null ? `退出码 ${entry.exitCode}` : STATES[status] || '状态未记录'}</span></footer>
  </section>;
}
function TranscriptOperation({ entry, open, onToggle }) {
  return <details className="transcript-operation" open={open} onToggle={onToggle}>
    <summary><OperationSummary entry={entry}/></summary>
    <OperationPanel entry={entry}/>
  </details>;
}
function TranscriptCommands({ entries }) {
  const groupRef = useRef(null), [expandedEntries, setExpandedEntries] = useState({});
  const single = entries.length === 1;
  const statuses = entries.map(executionOperationStatus);
  const unfinished = statuses.filter(status => ACTIVE_JOB_STATES.includes(status)).length;
  const failed = statuses.filter(status => status === 'failed').length;
  const stopped = statuses.filter(status => status === 'cancelled').length;
  const remember = (id, expanded) => setExpandedEntries(current => current[id] === expanded ? current : { ...current, [id]: expanded });
  return <details ref={groupRef} className={`transcript-command-group ${single ? 'is-single' : ''}`} onToggle={event => {
    if (single && event.target === groupRef.current) remember(entries[0].id, event.currentTarget.open);
  }}>
    <summary>{single ? <OperationSummary entry={entries[0]}/> : <><Icon name="terminal" size={14}/><span>{unfinished ? `${entries.length} 条命令 · 执行中` : statuses.includes('unknown') ? `${entries.length} 条命令` : `执行了 ${entries.length} 条命令`}</span>{failed > 0 && <span className="transcript-operation-state failed">{failed} 项失败</span>}{stopped > 0 && <span className="transcript-operation-state cancelled">{stopped} 项已停止</span>}<Icon name="down" size={13}/></>}</summary>
    {single ? <OperationPanel entry={entries[0]}/> : <div className="transcript-command-list">{entries.map(entry => <TranscriptOperation key={entry.id} entry={entry} open={Boolean(expandedEntries[entry.id])} onToggle={event => {
      if (event.target === event.currentTarget) remember(entry.id, event.currentTarget.open);
    }}/>)}</div>}
  </details>;
}
function ExecutionTranscript({ messages, steps, active }) {
  const blocks = executionTranscriptBlocks(messages, steps);
  if (!blocks.length) return <p className="muted">{active ? '暂无公开进展或操作记录，当前动作见上方状态。' : '本次执行没有可展开的进展、结果或操作记录。'}</p>;
  return <div className="execution-transcript" aria-label="进展、结果与操作记录">
    {blocks.map(block => block.kind === 'commands' ? <TranscriptCommands key={block.id} entries={block.entries}/>
      : block.kind === 'operation' ? <TranscriptOperation key={block.id} entry={block}/>
      : <article key={block.id} className="transcript-message"><MarkdownContent className="transcript-message-text" text={block.text}/><footer><span>{block.label}</span>{block.time && <time>{displayTime(block.time)}</time>}</footer></article>)}
  </div>;
}
