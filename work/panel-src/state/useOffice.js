/* 按当前任务订阅成员变化；本地秒钟仅用于显示耗时，不查询服务端。 */
function useOffice(runtime, taskId = null) {
  const [snapshot, setSnapshot] = React.useState(null), [error, setError] = React.useState('');
  const [updatedAt, setUpdatedAt] = React.useState(null), [now, setNow] = React.useState(Date.now);
  const [revision, setRevision] = React.useState(0);
  const clockOffset = React.useRef(0);
  React.useEffect(() => {
    // 切换任务时先清掉上一任务的快照，等待新任务范围的第一次响应。
    setSnapshot(null); setUpdatedAt(null); setError('');
    const query = `?scope=task&taskId=${encodeURIComponent(taskId || '__no_current_task__')}`;
    return runtime.current.watchResource(`/api/office${query}`, {
      onData: result => {
        const receivedAt = Date.now();
        clockOffset.current = (Date.parse(result.serverTime) || receivedAt) - receivedAt;
        setSnapshot(result); setUpdatedAt(receivedAt); setNow(receivedAt + clockOffset.current); setError('');
      }, onError: cause => setError(`状态同步失败：${cause.message}`)
    });
  }, [revision, taskId]);
  React.useEffect(() => { const timer = setInterval(() => setNow(Date.now() + clockOffset.current), 1000); return () => clearInterval(timer); }, []);
  return { snapshot, error, now, updatedAt, refresh: () => setRevision(value => value + 1) };
}
