/* 任务页和运行记录共享状态展示，耗时只作为观测值，不推算完成百分比。 */
function RunProgress({ job, showSteps = true }) {
  const [now, setNow] = useState(Date.now);
  const active = job && ACTIVE_JOB_STATES.includes(job.status) && job.status !== 'queued';
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!job) return null;
  const seconds = Math.max(0, Math.floor(((job.endedAt || now) - (job.startedAt || now)) / 1000));
  const inactivity = runInactivity(job, now);
  return <div className="run-progress">
    <div className="progress-status"><span>{job.activity || (job.status === 'queued' ? '等待前序成员或空闲执行席位' : STATES[job.status])}</span>{job.startedAt && <small>已用时 {Math.floor(seconds / 60)} 分 {seconds % 60} 秒</small>}</div>
    {inactivity && <p className="muted">{inactivity.message}</p>}
    {job.error && <p className="run-error" role="alert">{job.error}</p>}
    {showSteps && job.steps?.length > 0 && <details className="run-steps"><summary>执行步骤（最近 {job.steps.length} 项）</summary><ExecutionSteps steps={job.steps}/></details>}
  </div>;
}
function ExecutionSteps({ steps }) {
  return <div className="execution-steps">{steps.length ? steps.map(entry => <details className="run-step" key={entry.id}><summary><span className={`badge ${entry.status}`}>{STATES[entry.status]}</span><b>{entry.label}</b><time>{displayTime(entry.startedAt || entry.time)}</time>{entry.exitCode != null && <small>退出码 {entry.exitCode}</small>}</summary>{entry.endedAt && <small>结束：{displayTime(entry.endedAt)}</small>}{entry.detail && <pre>{entry.detail}</pre>}{entry.output && <pre className="step-output">{entry.output}</pre>}</details>) : <p className="muted">暂无命令、文件修改或工具操作记录。</p>}</div>;
}
