/* 只在窗口打开期间订阅变化，刷新失败时保留上次成功的数据。 */
function useInteractionSequence(runId, runtime) {
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [offset, setOffset] = useState(0), limit = 20;
  useEffect(() => { setOffset(0); setData(null); }, [runId]);
  useEffect(() => {
    setLoading(true);
    return runtime.current.watchResource(`/api/runs/${encodeURIComponent(runId)}/conversation?limit=${limit}&offset=${offset}&view=compact&detail=1`, {
      timeout: 15000,
      onData: result => { setData(result); setError(''); setUpdatedAt(Date.now()); setLoading(false); },
      onError: cause => { setError(`读取交互记录失败：${cause.message}`); setLoading(false); }
    });
  }, [runId, runtime, revision, offset]);
  return { data, error, loading, updatedAt, offset, earlier: () => setOffset(value => value + limit), newer: () => setOffset(value => Math.max(0, value - limit)), refresh: () => setRevision(value => value + 1) };
}
