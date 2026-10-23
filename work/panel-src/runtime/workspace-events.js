/* 页面共享一个变更通知连接；同一路径共享快照，事件到达才读取，禁止定时查询。 */
class WorkspaceEvents {
  constructor({ request, prefix = '', Source = EventSource, target = typeof window === 'undefined' ? null : window }) {
    this.request = request; this.prefix = prefix; this.Source = Source;
    this.listeners = new Set(); this.resources = new Map(); this.source = null;
    this.target = target;
    // 短暂离线可能只让快照请求失败，而 SSE 仍存活；网络恢复事件也要补快照。
    this.online = () => { for (const callback of [...this.listeners]) callback({ reconnect: true }); };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    if (!this.source) {
      this.target?.addEventListener?.('online', this.online);
      const source = this.source = new this.Source(`${this.prefix}/api/events`);
      const emit = event => { for (const callback of [...this.listeners]) callback(event); };
      source.addEventListener('ready', () => emit({ reconnect: true }));
      source.addEventListener('change', event => {
        try { const value = JSON.parse(event.data); if (Array.isArray(value.topics)) emit(value); }
        catch { emit({ reconnect: true }); }
      });
      source.onerror = () => emit({ error: new Error('状态连接已中断，等待自动重连') });
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { this.source?.close(); this.source = null; this.target?.removeEventListener?.('online', this.online); }
    };
  }
  watch(route, { onData, onError = () => {}, timeout = 8000 } = {}) {
    let entry = this.resources.get(route);
    const listener = { onData, onError };
    if (!entry) {
      entry = { listeners: new Set(), closed: false, loading: false, dirty: false, data: undefined };
      this.resources.set(route, entry);
      entry.read = async () => {
        if (entry.closed) return;
        if (entry.loading) { entry.dirty = true; return; }
        entry.loading = true; entry.dirty = false;
        entry.controller = new AbortController();
        try {
          const incremental = /\/(conversation|execution)\?/.test(route) && route.includes('view=compact');
          const requestRoute = incremental && entry.data?.revision ? `${route}&since=${encodeURIComponent(entry.data.revision)}` : route;
          let data = await this.request(requestRoute, { signal: entry.controller.signal }, timeout);
          if (incremental && data.runOrder) {
            const records = new Map(data.reset ? [] : (entry.data?.runs || []).map(run => [run.runId, run]));
            for (const run of data.runs) records.set(run.runId, run);
            data = { ...data, runs: data.runOrder.map(id => records.get(id)).filter(Boolean) };
          }
          if (!entry.closed) { entry.data = data; for (const item of entry.listeners) item.onData(data); }
        } catch (error) { if (!entry.closed) for (const item of entry.listeners) item.onError(error); }
        finally {
          entry.loading = false;
          // 读取期间收到多次事件只补取一次，确保没有丢失最后一次变化。
          if (entry.dirty && !entry.closed) void entry.read();
        }
      };
      entry.stop = this.subscribe(event => {
        if (event.error) { for (const item of entry.listeners) item.onError(event.error); }
        else if (event.reconnect || workspaceResourceChanged(route, event, entry.data)) void entry.read();
      });
    }
    entry.listeners.add(listener);
    if (entry.data !== undefined) onData(entry.data);
    else if (!entry.loading) void entry.read();
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        entry.closed = true; entry.controller?.abort(); entry.stop(); this.resources.delete(route);
      }
    };
  }
  close() {
    for (const entry of this.resources.values()) { entry.closed = true; entry.controller?.abort(); }
    this.resources.clear(); this.listeners.clear(); this.source?.close(); this.source = null;
    this.target?.removeEventListener?.('online', this.online);
  }
}
function workspaceResourceChanged(route, event, data) {
  const url = new URL(route, 'http://localhost'), pathname = url.pathname;
  const topic = pathname === '/api/providers' ? 'providers' : pathname === '/api/conversations' ? 'history' : pathname === '/api/approvals' ? 'approvals'
    : pathname === '/api/notifications' ? 'notifications' : pathname === '/api/messages' ? 'messages'
    : pathname.startsWith('/api/providers/') ? 'diagnostics' : 'runs';
  if (!event.topics.includes(topic)) return false;
  if (topic !== 'runs' || event.topics.includes('deleted')) return true;
  const changes = event.runs || [];
  if (pathname === '/api/office' && url.searchParams.get('scope') === 'task') return changes.some(run => run.taskId === url.searchParams.get('taskId'));
  const match = pathname.match(/^\/api\/runs\/([^/]+)(\/conversation|\/execution)?$/);
  if (!match) return true;
  const runId = decodeURIComponent(match[1]);
  if (!match[2]) return changes.some(run => run.runId === runId);
  const key = data?.summary?.conversationKey || data?.conversationKey;
  return !key || changes.some(run => run.runId === runId || run.conversationKey === key);
}
if (typeof module !== 'undefined' && module.exports) module.exports = { WorkspaceEvents, workspaceResourceChanged };
