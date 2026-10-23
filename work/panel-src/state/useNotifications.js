/* 已读和清除只保存通知 ID，不删除任务历史，也不处理待审批请求。 */
function loadNotificationIds(key, label, storedValue) {
  try {
    const ids = JSON.parse((storedValue === undefined ? localStorage.getItem(key) : storedValue) || '[]');
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid notification IDs');
    return { ids: [...new Set(ids)], error: '' };
  } catch { return { ids: [], error: `无法读取通知${label}状态，当前页面将重新记录。` }; }
}
function useNotifications({ runtime, connected, approvals }) {
  const storageKey = 'agent-manager:notifications-read', dismissedKey = 'agent-manager:notifications-dismissed';
  const [items, setItems] = useState([]), [error, setError] = useState('');
  const [open, setOpen] = useState(false), [preview, setPreview] = useState(null);
  const [read, setRead] = useState(() => loadNotificationIds(storageKey, '已读'));
  const [dismissed, setDismissed] = useState(() => loadNotificationIds(dismissedKey, '清除'));
  const [lastDismissed, setLastDismissed] = useState([]);
  const readRef = useRef(new Set(read.ids)), dismissedRef = useRef(new Set(dismissed.ids));
  const observed = useRef(null), observedApprovals = useRef(new Set());
  const persist = (key, label, ids, setter, ref) => {
    let error = '';
    try { localStorage.setItem(key, JSON.stringify(ids)); }
    catch { error = `无法保存通知${label}状态，当前页面已生效，刷新后可能恢复。`; }
    ref.current = new Set(ids); setter({ ids, error });
  };
  useEffect(() => {
    const syncStorage = event => {
      if (event.key === storageKey || event.key === null) {
        const next = loadNotificationIds(storageKey, '已读', event.newValue);
        readRef.current = new Set(next.ids); setRead(next);
      }
      if (event.key === dismissedKey || event.key === null) {
        const next = loadNotificationIds(dismissedKey, '清除', event.newValue);
        dismissedRef.current = new Set(next.ids); setDismissed(next); setLastDismissed([]);
      }
    };
    window.addEventListener('storage', syncStorage);
    return () => window.removeEventListener('storage', syncStorage);
  }, []);
  useEffect(() => {
    if (!connected) return;
    return runtime.current.watchResource('/api/notifications', {
      onData: data => {
        if (!Array.isArray(data)) { setError('通知格式无效'); return; }
        const fresh = observed.current && data.find(item => !observed.current.has(item.id) && !dismissedRef.current.has(item.id) && !readRef.current.has(item.id));
        if (fresh) setPreview({ type: 'delivery', id: fresh.id, text: `${fresh.title} · 第 ${fresh.round} 轮`, detail: fresh.taskTitle });
        observed.current = new Set(data.map(item => item.id)); setItems(data); setError('');
      }, onError: cause => setError(`通知同步失败：${cause.message}`)
    });
  }, [connected]);
  useEffect(() => {
    const fresh = approvals.find(approval => !observedApprovals.current.has(approvalKey(approval)));
    if (fresh) setPreview({ type: 'approval', text: '有操作等待确认', detail: `${fresh.context?.agentName || '团队成员'} · ${approvalTitle(fresh.method)}` });
    observedApprovals.current = new Set(approvals.map(approvalKey));
  }, [approvals]);
  useEffect(() => { if (preview) { const timer = setTimeout(() => setPreview(null), 6500); return () => clearTimeout(timer); } }, [preview]);
  useEffect(() => {
    setPreview(current => current?.type === 'delivery' && (dismissedRef.current.has(current.id) || readRef.current.has(current.id)) ? null : current);
  }, [read, dismissed]);
  const markRead = ids => persist(storageKey, '已读', [...new Set([...readRef.current, ...ids])].slice(-500), setRead, readRef);
  const dismiss = ids => {
    const targets = new Set(ids);
    const cleared = items.filter(item => targets.has(item.id) && !dismissedRef.current.has(item.id)).map(item => item.id);
    if (!cleared.length) return;
    // 不截断清除 ID，避免较早的通知在历史列表变化后重新出现。
    persist(dismissedKey, '清除', [...new Set([...dismissedRef.current, ...cleared])], setDismissed, dismissedRef);
    setLastDismissed(cleared);
  };
  const undoDismiss = () => {
    const restored = new Set(lastDismissed);
    persist(dismissedKey, '清除', [...dismissedRef.current].filter(id => !restored.has(id)), setDismissed, dismissedRef);
    setLastDismissed([]);
  };
  const readIds = new Set(read.ids), dismissedIds = new Set(dismissed.ids);
  const visibleItems = items.filter(item => !dismissedIds.has(item.id));
  return { items: visibleItems, error: [error, read.error, dismissed.error].filter(Boolean).join(' '), open, setOpen, preview, setPreview,
    markRead, dismiss, undoDismiss, undoCount: lastDismissed.length, readIds, unread: visibleItems.filter(item => !readIds.has(item.id)).length };
}
