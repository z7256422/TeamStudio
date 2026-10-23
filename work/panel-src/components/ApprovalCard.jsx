/* 审批与补充信息都必须由用户实际操作，提交期间禁用重复点击。 */
function ApprovalCard({ approval, workspace }) {
  const [answers, setAnswers] = useState({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const needsInput = approval.method === 'item/tool/requestUserInput';
  const questions = needsInput ? approval.params?.questions || [] : [];
  const respond = async decision => {
    setSending(true); setError('');
    try {
      const extra = needsInput && decision === 'accept' ? { answers: Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id]?.trim() || ''] }])) } : {};
      await workspace.resolveApproval(approval, decision, extra);
    } catch (cause) { setError(cause.message); } finally { setSending(false); }
  };
  const decline = approval.params?.availableDecisions && !approval.params.availableDecisions.includes('decline') ? 'cancel' : 'decline';
  return <div className="approval-card" aria-label="权限请求"><header><Icon name="shield" size={17}/><b>{approval.context?.agentName || workspace.agentNameById.get(approval.agentId) || 'Agent'} · {approvalTitle(approval.method)}</b></header>
    <small>请求时间：{displayTime(approval.receivedAt)} · {approval.method === 'item/permissions/requestApproval' ? '授权仅用于当前执行轮次' : '只处理此请求，不自动允许后续操作'}</small>
    {approval.expiresAt && <small>请在 {displayTime(approval.expiresAt)} 前处理；超时后不会批准操作，并会在消息中心通知。</small>}
    <dl className="approval-fields">{approvalDetails(approval).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{['完整权限范围', '任务', '本次分工'].includes(label) ? <details><summary>{label === '完整权限范围' ? '展开权限定义' : label === '任务' ? shortTaskTitle(value) : '展开分工指令'}</summary><pre>{value}</pre></details> : <pre>{value}</pre>}</dd></React.Fragment>)}</dl>
    {approvalFileChanges(approval).map((change, index) => <section className="approval-file-change" key={`${change.path}:${index}`}><b>{({ add: '新增', update: '修改', delete: '删除' })[change.kind?.type || change.kind] || '变更'} · {change.path || '路径未提供'}</b>{change.kind?.move_path && <p>移动到：{change.kind.move_path}</p>}{typeof change.diff === 'string' && change.diff ? <details><summary>展开文件差异</summary><pre>{change.diff}</pre></details> : <p>引擎未提供差异内容。</p>}</section>)}
    {needsInput ? questions.map(question => <Field key={question.id} label={question.question}>
      {question.options?.length > 0 && <select aria-label={`${question.header}预设回答`} value={answers[question.id] || ''} disabled={sending} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}><option value="">选择回答或在下方输入</option>{question.options.map(option => <option key={option.label} value={option.label}>{option.label} — {option.description}</option>)}</select>}
      <input aria-label={question.question} type={question.isSecret ? 'password' : 'text'} autoComplete="off" disabled={sending} value={answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}/>
    </Field>) : null}
    {error && <p className="run-error" role="alert">{error}</p>}
    <footer><button className="btn" disabled={sending} onClick={() => respond(needsInput ? 'cancel' : decline)}>拒绝</button><button className="btn primary" disabled={sending || (needsInput && questions.some(question => !answers[question.id]?.trim()))} onClick={() => respond('accept')}>{sending ? '提交中…' : needsInput ? '提交回答' : approval.method === 'item/permissions/requestApproval' ? '允许本轮请求权限' : '允许一次'}</button></footer></div>;
}
