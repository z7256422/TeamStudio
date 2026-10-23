/* 刷新页面后仍可读取服务端运行详情，避免只能看到“执行中”元数据。 */
function RunHistoryReader({ run, workspace }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    setDetail(null); setError('');
    return workspace.runtime.current.watchResource(`/api/runs/${encodeURIComponent(run.runId)}?view=compact`, {
      onData: data => { setDetail(data); setError(''); },
      onError: cause => setError(`读取运行详情失败：${cause.message}`)
    });
  }, [run.runId]);
  const stop = async () => {
    setStopping(true);
    try {
      await workspace.runtime.current.request(`/api/runs/${encodeURIComponent(run.runId)}/cancel`, { method: 'POST' });
      const data = await workspace.runtime.current.request(`/api/runs/${encodeURIComponent(run.runId)}?view=compact`);
      setDetail(data); workspace.refreshRunHistory();
    } catch (cause) { setError(`停止失败：${cause.message}`); }
    finally { setStopping(false); }
  };
  let job = detail ? conversationJob(detail) : { status: 'starting', startedAt: Date.parse(run.createdAt) };
  if (detail && ['completed', 'failed', 'cancelled'].includes(detail.status)) job = jobFromRunEvent(job, { type: 'completed', status: detail.status, message: detail.error, time: detail.updatedAt });
  const active = detail && !['completed', 'failed', 'cancelled'].includes(detail.status);
  const output = detail?.messages?.length ? detail.messages.map(message => message.text || '').join('\n\n') : detail?.output;
  return <div className="history-output"><h3>执行输出</h3>{error && <p className="run-error" role="alert">{error}</p>}{detail ? <><RunProgress job={job}/>{detail.transcriptUrl && <p><a href={detail.transcriptUrl}>下载完整执行记录</a>{detail.transcriptTruncated && ' · 当前为最近消息与正文预览。'}</p>}{output ? <MarkdownContent text={output}/> : <p className="muted">尚无文字输出，请查看执行状态和步骤。</p>}{active && <button className="btn danger" disabled={stopping} onClick={stop}>{stopping ? '正在停止…' : '停止此运行'}</button>}</> : <p className="muted">正在读取运行详情…</p>}</div>;
}
