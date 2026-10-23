/* 可复用确认窗口：保持删除目标不变，接口失败时保留窗口及错误信息。 */
function ConfirmDialog({ title, children, action = '确认删除', onConfirm, onClose }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { ref.current.showModal(); }, []);
  const confirm = async () => {
    setBusy(true); setError('');
    try { await onConfirm(); onClose(); } catch (cause) { setError(cause.message); setBusy(false); }
  };
  return <dialog ref={ref} className="confirm-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-top"><h3>{title}</h3><button className="icon-button" aria-label="关闭确认窗口" disabled={busy} onClick={onClose}><Icon name="close"/></button></div>
    <div className="dialog-form">{children}{error && <p className="run-error" role="alert">{error}</p>}</div>
    <div className="dialog-actions"><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn danger" disabled={busy} onClick={confirm}>{busy ? '处理中…' : action}</button></div>
  </dialog>;
}
