/** Provider-neutral browser adapter。页面只依赖统一运行契约。 */
class ControlPlaneRuntime {
  constructor() {
    this.prefix = window.location.protocol === 'file:' ? 'http://127.0.0.1:3210' : '';
    this.events = new WorkspaceEvents({ prefix: this.prefix, request: (...args) => this.request(...args) });
  }
  watchResource(route, options) { return this.events.watch(route, options); }
  subscribeChanges(callback) { return this.events.subscribe(callback); }
  close() { this.events.close(); }
  startRun({ agents, goal, strategy, concurrency, model, developerInstructions, approvalPolicy, sandbox = 'danger-full-access', sandboxPolicy, adapter, cwd, context }, onEvent) {
    let watcher = null, finished = false, cancelRequested = false, cancelPromise;
    const deliver = event => {
      if (finished) return;
      if (['completed', 'cancelled', 'error'].includes(event.type)) finished = true;
      onEvent(event);
    };
    const payload = {
      adapter: adapter || agents[0]?.provider || 'codex-app-server',
      agentId: agents[0]?.id || 'default', goal,
      cwd: cwd || agents[0]?.cwd || undefined,
      model: model || (agents[0]?.model && agents[0].model !== 'default' ? agents[0].model : undefined),
      developerInstructions: developerInstructions || agents[0]?.prompt || undefined,
      approvalPolicy: approvalPolicy || 'on-request', sandbox, sandboxPolicy: sandboxPolicy || undefined,
      strategy, concurrency, context
    };
    deliver({ type: 'submitted' });
    const ready = this.request('/api/runs', { method: 'POST', body: JSON.stringify(payload) }, 150000);
    ready
      .then(run => {
        if (!cancelRequested && !finished) watcher = this.watchRun(run, deliver);
      })
      .catch(error => deliver({ type: 'error', message: error.message }));
    return { cancel: () => {
      if (cancelPromise) return cancelPromise;
      if (finished) return Promise.resolve();
      cancelRequested = true; watcher?.close(); deliver({ type: 'stopping' });
      // 即使点击停止时 POST 尚未返回，也要等到 runId 后中断真实运行。
      cancelPromise = ready.then(async run => {
        const result = await this.request(`/api/runs/${encodeURIComponent(run.runId)}/cancel`, { method: 'POST' });
        deliver({ type: result.status === 'cancelled' ? 'cancelled' : 'completed', runId: run.runId, status: result.status });
      }).catch(error => deliver({ type: 'error', message: `停止任务失败：${error.message}。请在运行记录确认服务端状态。` }));
      return cancelPromise;
    } };
  }
  async request(route, options = {}, timeout = 60000) {
    const deadline = AbortSignal.timeout(timeout);
    const response = await fetch(`${this.prefix}${route}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers }, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || `运行接口失败（${response.status}）`);
    return result.data;
  }
  watchRun(run, onEvent) {
    let closed = false, disconnected = false, lastEventId = 0;
    const source = new EventSource(`${this.prefix}${run.eventsUrl}`);
    const close = () => { closed = true; source.close(); };
    const deliver = event => {
      if (closed) return;
      if (['completed', 'cancelled', 'error'].includes(event.type)) close();
      onEvent(event);
    };
    const receive = event => {
      if (!event.data || closed) return;
      let payload; try { payload = JSON.parse(event.data); } catch { return; }
      const sequence = Number(event.lastEventId);
      if (sequence && sequence <= lastEventId) return;
      if (sequence) lastEventId = sequence;
      deliver(payload);
    };
    ['thread_started', 'turn_accepted', 'started', 'message_delta', 'tool_output', 'provider_event', 'reasoning_summary', 'coordination', 'feedback_requested', 'feedback_resolved', 'approval_required', 'approval_resolved', 'completed', 'cancelled', 'error'].forEach(name => source.addEventListener(name, receive));
    source.addEventListener('snapshot', event => {
      if (closed) return;
      let current; try { current = JSON.parse(event.data); } catch { return; }
      if (['completed', 'failed', 'cancelled'].includes(current.status)) deliver({ type: 'completed', runId: run.runId, status: current.status, message: current.error || '', time: current.updatedAt });
    });
    source.onopen = () => { if (disconnected) { disconnected = false; deliver({ type: 'connection_restored', runId: run.runId }); } };
    source.onerror = event => {
      // 名为 error 的业务事件与 SSE 断连共用名称，不能把业务错误覆盖成网络错误。
      if (event.data || closed || disconnected) return;
      disconnected = true; deliver({ type: 'connection_lost', runId: run.runId });
    };
    return { close };
  }
  async respondApproval(requestId, body) {
    return this.request(`/api/approvals/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: JSON.stringify(body) });
  }
}
function approvalTitle(method) {
  return { 'item/commandExecution/requestApproval': '命令执行请求', 'item/fileChange/requestApproval': '文件变更请求', 'item/tool/requestUserInput': '工具需要输入', 'mcpServer/elicitation/request': 'MCP 需要确认', 'item/permissions/requestApproval': '权限扩展请求' }[method] || '运行时审批请求';
}
function approvalSummary(approval) {
  const params = approval.params || {};
  if (approval.method === 'item/commandExecution/requestApproval') return String(params.command || params.commandLine || params.reason || 'Codex 请求执行命令');
  if (approval.method === 'item/fileChange/requestApproval') return String(params.reason || params.grantRoot || params.cwd || 'Codex 请求修改文件');
  if (approval.method === 'item/tool/requestUserInput') return params.questions?.map(question => question.question).filter(Boolean).join('；') || 'Codex 请求补充输入';
  if (approval.method === 'mcpServer/elicitation/request') return String(params.message || params.serverName || 'MCP 服务请求确认');
  if (approval.method === 'item/permissions/requestApproval') return String(params.reason || 'Codex 请求额外权限');
  return '请查看本地 Codex 请求详情';
}
