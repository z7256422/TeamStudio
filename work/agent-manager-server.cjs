#!/usr/bin/env node
/*
 * Agent Manager local control plane.
 *
 * The browser talks to this small HTTP/SSE service through a provider-neutral
 * contract. Codex is one provider adapter; another CLI, HTTP model, or local
 * runtime can implement the same adapter interface later.
 *
 * Security boundary: bind to loopback by default, never expose credentials in
 * API responses, and do not accept arbitrary executable commands from clients.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { listDirectories } = require('./server/directories.cjs');
const { WorkingDirectoryError, resolveWorkingDirectory, workingDirectoryDiagnostic } = require('./server/working-directory.cjs');
const { TERMINAL_RUN_STATES, parseTaskContext, updateRunProjection, officeSnapshot, deleteRunHistory } = require('./server/run-metadata.cjs');
const { conversationKey, conversationRuns, groupedConversations, canDeleteConversation, coordinatorRun, assertRunAvailable, continuationInput } = require('./server/conversations.cjs');
const { TEAM_TOOLS, MEMBER_TOOLS, parseManagement, managerInstructions, memberInstructions, createTeamCoordinator } = require('./server/team-coordinator.cjs');
const { conversationRounds, deliveryNotifications, feedbackNotifications } = require('./server/conversation-rounds.cjs');
const { rememberApprovalContext, approvalParams } = require('./server/approval-context.cjs');
const { createCodexDiagnostics } = require('./server/provider-diagnostics.cjs');
const { executionGuidance } = require('./server/execution-guidance.cjs');
const { DEFAULT_SANDBOX, executionPermissions } = require('./server/execution-permissions.cjs');
const { UNACCEPTED_DELIVERY, resolveDeliveryMode } = require('./server/delivery-contract.cjs');
const { spawnCodexAppServer } = require('./server/codex-process.cjs');
const { TEAM_PROTOCOL_VERSION, prepareTeamThread } = require('./server/team-thread.cjs');
const { updateRunMessages } = require('./shared/run-activity.js');
const { publicReasoningEvent } = require('./server/codex-reasoning.cjs');
const { reasoningConfigurationHint } = require('./shared/model-reasoning.js');
const { createWorkspaceEvents } = require('./server/workspace-events.cjs');
const { createCustomProviders, testProvider, assertLocalProviderRequest } = require('./server/custom-providers.cjs');
const { stopProvider } = require('./server/service-lifecycle.cjs');
const { assertLocalRequest } = require('./server/local-access.cjs');
const { writeStream, guardStream } = require('./server/sse.cjs');
const { interruptionMessage, recordRunAlert, runAlertNotifications } = require('./server/run-alerts.cjs');
const { createTaskQueue } = require('./server/task-queue.cjs');
const { compactRun, compactDelivery, createHistorySnapshots } = require('./server/history-view.cjs');
const { createEngineReadiness } = require('./server/engine-readiness.cjs');
const { version } = require('./server/app-info.cjs');

const PORT = Number(process.env.AGENT_MANAGER_PORT || 3210);
const HOST = process.env.AGENT_MANAGER_HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'outputs');
const HTML = path.join(OUTPUT, 'agent-manager.html');
const MAX_BODY = 2 * 1024 * 1024;
const sessions = new Map();
const runs = new Map();
const messages = [];
const workspaceEvents = createWorkspaceEvents();
const historySnapshots = createHistorySnapshots();
const customProviders = createCustomProviders({ file: require.main === module ? path.join(process.env.AGENT_MANAGER_DATA_DIR || path.join(ROOT, '.agent-manager'), 'providers.json') : null });
const providerEdits = new Set();
const allProviders = () => [providerStatus(), ...customProviders.list().map(provider => ({ ...provider, readiness: engineReadiness.current(provider.id) }))];
const availableProviders = () => allProviders().filter(item => item.status === 'available').map(item => item.id);
const teamCoordinator = createTeamCoordinator({ runs, startRun, cancelRun, emitRun });
const diagnostics = createCodexDiagnostics({ getClient: supplied => supplied || sessionFor('__diagnostics__').client, onChange: () => workspaceEvents.publish(['diagnostics']) });
const engineReadiness = createEngineReadiness({ getClient: (key, execution) => sessionFor('__readiness__' + key, execution).client, onChange: () => workspaceEvents.publish(['providers']) });
const messageSubscribers = new Set();
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const runStore = require.main === module ? require('./server/run-store.cjs').createRunStore(path.join(process.env.AGENT_MANAGER_DATA_DIR || path.join(ROOT, '.agent-manager'), 'runs.sqlite')) : null;
if (runStore) for (const run of runStore.load()) { runs.set(run.id, run); runStore.save(run); }
let requestId = 0;
const taskQueue = createTaskQueue({ runs, startRun, cancelRun, emitRun, prepareInput: prepareQueuedInput,
  persist: values => { for (const run of values) runStore?.save(run); runStore?.flush(); } });

function id(prefix) { return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`; }
function json(res, status, value) {
  const body = JSON.stringify(value);
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
function text(res, status, value, contentType = 'text/plain; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(value);
}
function apiError(res, status, message, code = 'bad_request') { json(res, status, { error: { code, message } }); }
function safeText(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label} must be ${required ? 'non-empty ' : ''}text up to ${max} characters`);
  return value;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY) { reject(new Error('request body is too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new Error('request body must be valid JSON'); }
}
function parsePath(req) { return new URL(req.url, `http://${HOST}:${PORT}`); }

class JsonRpcClient {
  constructor(timeoutMs = 45000, execution = null) {
    this.timeoutMs = timeoutMs;
    this.execution = execution;
    this.child = null; this.buffer = ''; this.pending = new Map(); this.serverRequests = new Map(); this.listeners = new Set(); this.ready = null; this.starting = null;
  }
  async start() {
    if (this.ready) return this.ready;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const command = process.env.CODEX_BIN || 'codex';
      this.child = spawnCodexAppServer(command, { cwd: ROOT, env: { ...process.env, ...this.execution?.env, NO_COLOR: '1' } });
      let settled = false;
      const fail = error => { this.starting = null; if (!settled) { settled = true; reject(error); } this.emit({ type: 'provider_error', message: error.message }); };
      this.child.once('error', fail);
      this.child.stdin.on('error', fail);
      this.child.once('exit', (code, signal) => {
        const message = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`;
      this.ready = null; this.starting = null; this.child = null;
      for (const pending of this.pending.values()) pending.reject(new Error(message));
      this.pending.clear(); this.emit({ type: 'provider_error', message });
      for (const pending of this.serverRequests.values()) clearTimeout(pending.timer);
      this.serverRequests.clear();
      });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', chunk => this.consume(chunk));
      this.child.stderr.on('data', chunk => this.emit({ type: 'provider_log', stream: 'stderr', message: chunk.toString().trim() }));
      this.request('initialize', { clientInfo: { name: 'agent-manager', title: 'Agent Manager', version }, capabilities: { experimentalApi: true, optOutNotificationMethods: [] } })
        .then(result => { this.sendNotification('initialized'); settled = true; this.ready = result; this.starting = null; resolve(result); })
        .catch(fail);
    }).catch(error => {
      // 找不到可执行文件等同步错误也释放启动状态，修正配置后允许再次连接。
      this.starting = null;
      throw error;
    });
    return this.starting;
  }
  consume(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { this.emit({ type: 'provider_log', stream: 'stdout', message: line }); continue; }
      message = this.sanitize(message);
      if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        const pending = this.pending.get(String(message.id));
        if (!pending) continue;
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message || 'Codex app-server request failed'));
        else pending.resolve(message.result);
      } else if (message.method) {
        if (Object.hasOwn(message, 'id')) this.handleServerRequest(message);
        else this.emit({ type: 'notification', method: message.method, params: message.params || {} });
      }
    }
  }
  request(method, params) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Codex app-server is not running'));
    const idValue = String(++requestId);
    return new Promise((resolve, reject) => {
      // RPC 无响应必须返回明确错误，不能让 HTTP 请求和页面永久停在启动中。
      const timer = setTimeout(() => {
        this.pending.delete(idValue);
        reject(new Error(`Codex ${method} timed out after ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);
      this.pending.set(idValue, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      const failWrite = error => { const pending = this.pending.get(idValue); if (pending) { this.pending.delete(idValue); pending.reject(error); } };
      try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: idValue, method, params })}\n`, error => { if (error) failWrite(error); }); }
      catch (error) { failWrite(error); }
    });
  }
  sendNotification(method, params) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is not running');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }
  notify(event) {
    for (const listener of [...this.listeners]) {
      try { listener(event); }
      catch (error) {
        console.error(`运行事件处理失败：${error.message}`);
        // 单个订阅失败只终止该运行的跟踪，不让异常穿透到驻留进程。
        try { listener({ type: 'provider_error', message: '运行事件处理失败，请查看服务日志后继续此会话。' }); }
        catch (failure) { console.error(`记录运行故障失败：${failure.message}`); }
      }
    }
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  sanitize(value) {
    const key = this.execution?.env?.TEAM_STUDIO_MODEL_KEY;
    if (!key) return value;
    return JSON.parse(JSON.stringify(value, (_name, item) => typeof item === 'string' ? item.replaceAll(key, '[REDACTED]') : item));
  }
  emit(event) {
    // 自定义上游的原始进程日志可能含认证头，不向 UI、历史或日志转发。
    if (this.execution && event.type === 'provider_log') return;
    this.notify(this.sanitize(event));
  }
  handleServerRequest(message) {
    const requestKey = String(message.id);
    const pending = {
      requestId: requestKey,
      rpcId: message.id,
      method: message.method,
      params: message.params || {},
      receivedAt: new Date().toISOString(),
      // 团队等待由调度器的事件/取消释放，不能误用审批期限打断长任务。
      timer: message.method === 'item/tool/call' && ['team_wait', 'team_ask_manager'].includes(message.params?.tool) ? null : setTimeout(() => {
        // A forgotten approval must not leave a Codex turn blocked forever.
        // Use a JSON-RPC error for request types that do not have a decline
        // result (for example permissions approval).
        try { this.respondServerRequest(requestKey, null, { code: -32001, message: 'Approval request timed out.' }); } catch { /* process exit is reported separately */ }
        this.emit({ type: 'approval_timeout', requestId: requestKey, method: message.method, params: message.params || {} });
      }, APPROVAL_TIMEOUT_MS)
    };
    this.serverRequests.set(requestKey, pending);
    this.emit({ type: 'server_request', requestId: requestKey, method: message.method, params: message.params || {}, receivedAt: pending.receivedAt });
  }
  respondServerRequest(requestIdValue, result, error = null) {
    const requestKey = String(requestIdValue);
    const pending = this.serverRequests.get(requestKey);
    if (!pending) throw new Error('approval request not found or already resolved');
    clearTimeout(pending.timer);
    this.serverRequests.delete(requestKey);
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is not running');
    // Preserve the JSON-RPC id type. Codex currently uses numeric ids for
    // server requests, and replying with the equivalent string is not valid
    // correlation for every JSON-RPC implementation.
    const response = { jsonrpc: '2.0', id: pending.rpcId };
    if (error) response.error = error;
    else response.result = result ?? {};
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
    return pending;
  }
}

function providerStatus() {
  return { id: 'codex-app-server', kind: 'codex', label: '本机 Codex app-server', executable: process.env.CODEX_BIN || 'codex', capabilities: ['sessions', 'tools', 'mcp', 'skills', 'streaming', 'interrupt', 'approvals'], status: 'available', readiness: engineReadiness.current('codex-app-server') };
}
function sessionFor(agentId, execution = null) {
  const previous = sessions.get(agentId);
  if (previous && previous.sessionKey !== execution?.sessionKey && (previous.sessionKey || execution)) {
    void stopProvider(previous.client.child); sessions.delete(agentId);
  }
  if (!sessions.has(agentId)) sessions.set(agentId, { agentId, adapter: execution?.adapter || 'codex-app-server', sessionKey: execution?.sessionKey, threadId: null, cwd: null, createdAt: new Date().toISOString(), client: new JsonRpcClient(45000, execution) });
  return sessions.get(agentId);
}
async function releaseProviderSessions(providerId) {
  for (const [agentId, session] of sessions) {
    if (session.adapter !== providerId) continue;
    await stopProvider(session.client.child);
    session.client.execution = null;
    sessions.delete(agentId);
  }
}
function emitRun(run, event) {
  event = publicReasoningEvent(event);
  if (!event) return;
  if (run.interruption && ['error', 'completed', 'cancelled'].includes(event.type)) {
    const message = interruptionMessage(run);
    event = { ...event, message };
    run.error = message;
    if (run.delivery && run.delivery.status !== 'completed') run.delivery = { ...run.delivery, summary: message };
  }
  if (run.adapter !== 'codex-app-server' && ['error', 'completed'].includes(event.type)) {
    const message = event.message || event.turn?.error?.message;
    const hint = reasoningConfigurationHint(message);
    if (hint && !message.includes(hint)) { event = { ...event, message: `${message}\n${hint}` }; run.error = event.message; }
  }
  if (run.settings?.management && ['error', 'cancelled', 'completed'].includes(event.type) && run.status !== 'completed') {
    run.delivery = { status: run.status === 'cancelled' ? 'cancelled' : 'blocked', summary: event.message || run.error || '任务未完成交付' };
    teamCoordinator.stopChildren(run).catch(error => emitRun(run, { type: 'coordination', stage: 'stop-failed', message: error.message }));
  }
  const payload = { ...event, sequence: run.sequence = (run.sequence || 0) + 1, runId: run.id, agentId: run.agentId, time: new Date().toISOString() };
  run.updatedAt = payload.time;
  recordRunAlert(run, payload);
  if (event.type === 'feedback_requested' && event.feedback) {
    run.feedback = [...(run.feedback || []).filter(item => item.requestId !== event.feedback.requestId), { ...event.feedback, status: 'pending' }].slice(-100);
  }
  if (event.type === 'feedback_resolved' && event.feedback) {
    run.feedback = [...(run.feedback || []).filter(item => item.requestId !== event.feedback.requestId), { ...event.feedback }].slice(-100);
  }
  if (event.type === 'message_delta') run.output = ((run.output || '') + (event.delta || '')).slice(-200000);
  rememberApprovalContext(run, payload);
  diagnostics.observe(payload);
  updateRunMessages(run, payload);
  if (event.type === 'error' || event.turn?.error) run.error = event.message || event.turn.error.message;
  updateRunProjection(run, payload);
  run.events.push(payload); if (run.events.length > 200) run.events.shift();
  runStore?.save(run, TERMINAL_RUN_STATES.has(run.status));
  // 原页面队列的完成广播随调度移到服务端，关闭页面后也保留相同行为。
  if (run.batch && event.type === 'completed' && run.status === 'completed' && !messages.some(message => message.id === `batch-result:${run.id}`)) {
    const result = run.messages?.findLast(message => message.phase === 'final_answer' && message.text)?.text || run.output || 'Agent 已完成本轮任务。';
    emitMessage({ id: `batch-result:${run.id}`, fromAgentId: run.agentId, toAgentId: null, runId: run.id,
      content: result.slice(-20000), replyTo: null, priority: 'normal', createdAt: payload.time });
  }
  teamCoordinator.notifyRunChange(run);
  taskQueue.notify(run);
  publishRunChange(run, event.type);
  for (const client of run.subscribers) if (!writeStream(client, `id: ${payload.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`)) run.subscribers.delete(client);
}
function emitMessage(message) {
  messages.push(message);
  if (messages.length > 1000) messages.shift();
  workspaceEvents.publish(['messages']);
  for (const client of messageSubscribers) if (!writeStream(client, `event: message\ndata: ${JSON.stringify(message)}\n\n`)) messageSubscribers.delete(client);
}
function publishRunChange(run, type) {
  const topics = ['runs'];
  if (!['message_delta', 'tool_output', 'provider_event', 'reasoning_summary'].includes(type)) topics.push('history');
  if (['approval_required', 'approval_resolved', 'completed', 'cancelled', 'error'].includes(type) || (type === 'provider_event' && run.approvals?.size)) topics.push('approvals');
  if (['completed', 'cancelled', 'error', 'feedback_resolved', 'approval_resolved'].includes(type)) topics.push('notifications');
  workspaceEvents.publish(topics, { runId: run.id, taskId: run.context?.taskId || null, conversationKey: conversationKey(run) });
}
function removeRunHistory(ids) {
  const result = deleteRunHistory(runs, ids, values => runStore?.remove(values));
  workspaceEvents.publish(['deleted', 'runs', 'history', 'notifications', 'approvals']);
  return result;
}
function findRunForServerRequest(client, request) {
  const params = request.params || {};
  const candidates = [...runs.values()].filter(run => run.client === client && !['completed', 'failed', 'cancelled'].includes(run.status));
  return candidates.find(run => params.threadId && params.threadId === run.threadId)
    || candidates.find(run => params.turnId && params.turnId === run.turnId)
    || candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}
function publicApproval(approval) {
  const run = runs.get(approval.runId);
  return {
    context: run?.context || null, cwd: run?.cwd || approval.params?.cwd || '',
    requestId: approval.requestId,
    method: approval.method,
    params: approvalParams(run, approval),
    receivedAt: approval.receivedAt,
    expiresAt: approval.receivedAt ? new Date(Date.parse(approval.receivedAt) + APPROVAL_TIMEOUT_MS).toISOString() : null,
    runId: approval.runId,
    agentId: approval.agentId,
    adapter: approval.adapter
  };
}
function defaultApprovalResult(method, decision) {
  if (method === 'mcpServer/elicitation/request') return { action: decision === 'accept' ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'item/permissions/requestApproval') return null;
  return { decision: decision === 'acceptForSession' ? 'acceptForSession' : decision === 'cancel' ? 'cancel' : decision === 'accept' ? 'accept' : 'decline' };
}
function findApproval(requestIdValue, runId) {
  const key = String(requestIdValue);
  const matches = [];
  for (const session of sessions.values()) {
    const pending = session.client.serverRequests.get(key);
    if (pending) {
      const run = [...runs.values()].find(candidate => candidate.client === session.client && candidate.approvals?.has(key));
      if (!runId || run?.id === runId) matches.push({ session, pending, run });
    }
  }
  if (matches.length > 1) throw new Error('approval request is ambiguous; runId must be provided');
  return matches[0] || null;
}
function pendingApprovals() {
  const result = [];
  for (const session of sessions.values()) {
    for (const pending of session.client.serverRequests.values()) {
      if (pending.method === 'item/tool/call') continue;
      const run = [...runs.values()].find(candidate => candidate.client === session.client && candidate.approvals?.has(pending.requestId));
      result.push(publicApproval({ ...pending, runId: run?.id || null, agentId: run?.agentId || session.agentId, adapter: run?.adapter || session.adapter }));
    }
  }
  return result;
}
function publicRun(run, details = false) {
  const coordination = run.settings?.management ? { ...run.delivery, mode: run.settings.management.deliveryMode || run.delivery?.mode || 'files', members: run.settings.management.members.map(({ id, name, role, provider }) => ({ id, name, role, provider })) } : null;
  return { coordination, feedback: run.feedback || [], threadMigration: run.threadMigration || null, sandbox: run.settings?.sandbox || null, runId: run.id, agentId: run.agentId, adapter: run.adapter, status: run.status, model: run.model, parentRunId: run.parentRunId || null, cwd: run.cwd, threadId: run.threadId, turnId: run.turnId, createdAt: run.createdAt, startedAt: run.startedAt || null, endedAt: run.endedAt || null, context: run.context || null, updatedAt: run.updatedAt, error: run.error || '', goal: run.goal, eventsUrl: `/api/runs/${run.id}/events`, approvals: [...run.approvals.values()].map(publicApproval), ...(details ? { output: run.output || '', messages: run.messages || [], progress: run.progress || null, events: run.events.map(publicReasoningEvent).filter(Boolean) } : {}) };
}
function publicConversation(chain) {
  const root = coordinatorRun(chain), latest = chain.at(-1), coordinator = chain.filter(run => run.agentId === root.agentId).at(-1);
  const active = chain.find(run => !TERMINAL_RUN_STATES.has(run.status));
  return { ...publicRun(root), coordination: compactDelivery(publicRun(coordinator).coordination, coordinator.id), sandbox: coordinator.settings?.sandbox || null, conversationKey: conversationKey(root), turnCount: conversationRounds(chain).length, executionCount: chain.length,
    runIds: chain.map(run => run.id), latestRunId: latest.id, continuationRunId: coordinator.id, latestGoal: latest.context?.taskTitle || latest.goal,
    status: active?.status || conversationRounds(chain).at(-1).status, updatedAt: chain.reduce((time, run) => (run.updatedAt || run.createdAt) > time ? (run.updatedAt || run.createdAt) : time, ''),
    approvals: chain.flatMap(run => [...run.approvals.values()].map(publicApproval)), canDelete: canDeleteConversation(chain) };
}
function attachMessageClient(res) {
  guardStream(res);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
  if (!writeStream(res, ': connected\n\n')) return;
  for (const message of messages) if (!writeStream(res, `event: message\ndata: ${JSON.stringify(message)}\n\n`)) return;
  messageSubscribers.add(res); res.on('close', () => messageSubscribers.delete(res));
}
async function resolveApproval(requestIdValue, input) {
  const found = findApproval(requestIdValue, input?.runId);
  if (!found) { const error = new Error('approval request not found or already resolved'); error.statusCode = 404; throw error; }
  const { session, pending, run } = found;
  const decision = ['accept', 'acceptForSession', 'decline', 'cancel'].includes(input?.decision) ? input.decision : null;
  let result = input?.result;
  let error = null;
  if (input?.error && typeof input.error === 'object') error = { code: Number(input.error.code) || -32000, message: safeText(input.error.message || 'Approval declined', 'error.message', 1000) };
  if (pending.method === 'item/permissions/requestApproval' && !result) {
    if (!decision || decision === 'decline' || decision === 'cancel') error = { code: -32002, message: 'Approval declined by Agent Manager.' };
    else result = { permissions: pending.params?.permissions || { fileSystem: null, network: null }, scope: input.scope === 'session' || decision === 'acceptForSession' ? 'session' : 'turn' };
  } else if (!result) {
    result = defaultApprovalResult(pending.method, decision || 'decline');
    if (pending.method === 'mcpServer/elicitation/request' && input?.content !== undefined) result.content = input.content;
    if (pending.method === 'item/tool/requestUserInput' && input?.answers && typeof input.answers === 'object') result.answers = input.answers;
  }
  if (result !== undefined && (result === null || typeof result !== 'object' || Array.isArray(result))) throw new Error('result must be a JSON object');
  session.client.respondServerRequest(pending.requestId, result, error);
  if (run) { run.approvals.delete(pending.requestId); emitRun(run, { type: 'approval_resolved', requestId: pending.requestId, method: pending.method, resolution: error ? 'declined' : (decision || 'responded') }); }
  return { requestId: pending.requestId, runId: run?.id || null, status: error ? 'declined' : 'resolved' };
}
function attachClient(run, res, lastEventId = 0) {
  guardStream(res);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
  if (!writeStream(res, ': connected\n\n')) return;
  for (const event of run.events) if (event.sequence > lastEventId && !writeStream(res, `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) return;
  // 连接时推送权威状态；终止事件已离开回放窗口也能收敛，无需 HTTP 轮询兜底。
  if (!writeStream(res, `event: snapshot\ndata: ${JSON.stringify({ runId: run.id, status: run.status, error: run.error || '', updatedAt: run.updatedAt })}\n\n`)) return;
  const heartbeat = setInterval(() => writeStream(res, ': heartbeat\n\n'), 15000);
  heartbeat.unref();
  run.subscribers.add(res); res.on('close', () => { clearInterval(heartbeat); run.subscribers.delete(res); });
}
function prepareQueuedInput(input) {
  if (!input || typeof input !== 'object' || input.management || input.threadId) throw Object.assign(new Error('队列成员必须是新任务运行'), { statusCode: 400 });
  const cwd = resolveWorkingDirectory(input.cwd, ROOT), adapter = input.adapter || 'codex-app-server';
  const execution = adapter === 'codex-app-server' ? null : customProviders.execution(adapter, input);
  return { agentId: safeText(input.agentId, 'agentId', 100), goal: safeText(input.goal, 'goal', 12000), cwd, adapter,
    model: execution?.model || input.model, providerFingerprint: execution?.fingerprint,
    approvalPolicy: input.approvalPolicy == null ? 'on-request' : safeText(input.approvalPolicy, 'approvalPolicy', 50),
    ...(input.baseInstructions != null ? { baseInstructions: safeText(input.baseInstructions, 'baseInstructions', 64000, false) } : {}),
    developerInstructions: input.developerInstructions ? safeText(input.developerInstructions, 'developerInstructions', 64000) : '',
    ...executionPermissions(input, cwd, false), context: parseTaskContext(input.context) };
}
async function startRun(input, reservation = null) {
  const agentId = safeText(input.agentId, 'agentId', 100);
  const goal = safeText(input.goal, 'goal', 12000);
  const cwd = resolveWorkingDirectory(input.cwd, ROOT);
  const adapter = input.adapter || 'codex-app-server';
  if (providerEdits.has(adapter) || input.management?.members?.some(member => providerEdits.has(member.provider))) throw Object.assign(new Error('模型连接正在更新，请保存完成后再启动任务'), { statusCode: 409 });
  const execution = adapter === 'codex-app-server' ? null : customProviders.execution(adapter, input);
  let resumeThreadId = input.threadId ? safeText(input.threadId, 'threadId', 200) : null;
  assertRunAvailable(runs, agentId, resumeThreadId, reservation?.id);
  const previousThread = resumeThreadId && [...runs.values()].filter(run => run.threadId === resumeThreadId).at(-1);
  if (previousThread && previousThread.adapter !== adapter) throw Object.assign(new Error('不能使用另一供应商恢复原模型会话，请创建新任务'), { statusCode: 409 });
  if (previousThread?.settings?.providerFingerprint && execution?.fingerprint !== previousThread.settings.providerFingerprint) throw Object.assign(new Error('会话原模型接口已变化，请恢复原连接后继续'), { statusCode: 409 });
  const session = sessionFor(agentId, execution); const client = session.client;
  const context = parseTaskContext(input.context);
  const management = input.management ? parseManagement(input.management, agentId, availableProviders()) : null;
  const toolRole = management ? (context?.coordinatorRunId ? 'leader' : 'manager') : 'member';
  const teamThread = prepareTeamThread(runs, { agentId, threadId: resumeThreadId, enabled: Boolean(management || context?.coordinatorRunId), toolRole });
  resumeThreadId = teamThread.threadId;
  const settings = Object.fromEntries(['model', 'developerInstructions', 'baseInstructions', 'sandbox', 'sandboxPolicy', 'approvalPolicy'].filter(key => input[key] != null && !(key === 'model' && input[key] === 'default')).map(key => [key, input[key]]));
  if (execution) Object.assign(settings, { model: execution.model, reasoningEffort: execution.reasoningEffort, providerFingerprint: execution.fingerprint });
  if (management || context?.coordinatorRunId) Object.assign(settings, { teamProtocolVersion: TEAM_PROTOCOL_VERSION, teamToolRole: toolRole });
  Object.assign(settings, executionPermissions(input, cwd, Boolean(resumeThreadId) && !management));
  if (management) {
    // 首次接单时冻结每个成员的模型和接口身份；返工、续聊不能继承另一供应商的模型名。
    for (const member of management.members) {
      if (!customProviders.has(member.provider)) continue;
      if (!member.available) continue;
      const resolved = customProviders.execution(member.provider, member);
      member.model = resolved.model; member.providerFingerprint = resolved.fingerprint;
    }
    if (!context?.taskId) throw new Error('Managed task must have a taskId');
    // 子团队按本次分工判定成果类型，不能让产品总目标中的“开发”强迫需求/评审工作包写代码。
    management.deliveryMode = resolveDeliveryMode(context?.coordinatorRunId ? context.assignment || goal : goal, management.deliveryMode);
    if (management.deliveryMode === 'files' && !management.members.some(member => member.id !== agentId && member.available)) {
      throw new Error('项目经理需要至少一名已接入供应商的成员才能安排开发');
    }
    settings.management = management;
  }
  const run = Object.assign(reservation || {}, { delivery: management ? { status: 'running', summary: management.deliveryMode === 'reply' ? '项目经理正在准备答复' : '项目经理规划、派发与验收中' } : null, id: reservation?.id || id('run'), agentId, adapter, goal, cwd, context, model: settings.model || 'default', settings, parentRunId: input.parentRunId || null, events: reservation?.events || [], subscribers: reservation?.subscribers || new Set(), approvals: new Map(), client, status: 'starting', threadId: resumeThreadId, turnId: null, createdAt: reservation?.createdAt || new Date().toISOString() });
  if (teamThread.migration) run.threadMigration = teamThread.migration;
  runs.set(run.id, run);
  try { runStore?.save(run, true); }
  catch (error) { runs.delete(run.id); throw error; }
  publishRunChange(run, 'created');
  const earlyNotifications = [];
  const onProviderEvent = event => {
    if (event.type === 'notification') {
      const params = event.params || {};
      if (run.threadId && params.threadId && params.threadId !== run.threadId) return;
      // 恢复历史会话时忽略旧 turn 的迟到事件，防止串入本轮输出或提前结束。
      const incomingTurnId = params.turnId || params.turn?.id;
      if (incomingTurnId && run.turnId && incomingTurnId !== run.turnId) return;
      if (!run.turnId) { earlyNotifications.push(event); return; }
      if (event.method === 'item/agentMessage/delta') emitRun(run, { type: 'message_delta', delta: params.delta || '', itemId: params.itemId });
      else if (event.method === 'turn/started') { run.status = 'running'; run.startedAt ||= new Date().toISOString(); run.turnId = params.turn?.id || run.turnId; emitRun(run, { type: 'started', turnId: run.turnId }); }
      else if (event.method === 'turn/completed') {
        if (run.status !== 'cancelled') run.status = params.turn?.status === 'completed' ? 'completed' : params.turn?.status === 'interrupted' ? 'cancelled' : 'failed';
        if (management && run.status === 'completed') teamCoordinator.finalizeReport(run);
        if (management && run.status === 'completed' && (run.delivery?.status !== 'completed' || teamCoordinator.children(run).some(child => !TERMINAL_RUN_STATES.has(child.status)))) {
          run.status = 'failed'; run.error = management.deliveryMode === 'reply' ? '本轮未收到完整答复，或已派发成员仍有未解决的问题；请在本会话继续。' : management.deliveryMode === 'report' ? '本轮尚未提交完整的最终报告，或已派发成员尚未完成；请在本任务继续处理。' : UNACCEPTED_DELIVERY;
        }
        if (management && run.status !== 'completed') {
          run.delivery = { status: run.status === 'cancelled' ? 'cancelled' : 'blocked', summary: run.error || params.turn?.error?.message || '团队执行中断，尚未交付' };
        }
        emitRun(run, { type: 'completed', status: run.status, message: run.error || '', turn: params.turn }); unsubscribe();
      }
      else if (event.method === 'error' && !params.willRetry) { run.status = 'failed'; emitRun(run, { type: 'error', message: params.error?.message || 'Codex turn failed' }); unsubscribe(); }
      else if (event.method === 'item/commandExecution/outputDelta') emitRun(run, { type: 'tool_output', delta: params.delta || '', itemId: params.itemId });
      else emitRun(run, { type: 'provider_event', method: event.method, params });
    } else if (event.type === 'server_request') {
      const matched = findRunForServerRequest(client, event);
      if (matched !== run) return;
      if (event.method === 'item/tool/call') {
        const params = event.params || {};
        // 动态工具是调度调用，不是交给用户处理的审批卡片。
        const execute = async () => {
          try {
            if (params.threadId !== run.threadId || (run.turnId && params.turnId !== run.turnId)) throw new Error('Invalid coordinator tool scope');
            const value = params.tool === 'team_ask_manager' && run.context?.coordinatorRunId
              ? await teamCoordinator.memberCall(run, params.tool, params.arguments, params.callId)
              : management
              ? await teamCoordinator.call(run, params.tool, params.arguments, params.callId)
              : run.context?.coordinatorRunId
                ? await teamCoordinator.memberCall(run, params.tool, params.arguments, params.callId)
                : (() => { throw new Error('该运行没有团队反馈上下文'); })();
            client.respondServerRequest(event.requestId, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
          } catch (error) {
            if (client.serverRequests.has(String(event.requestId))) client.respondServerRequest(event.requestId, { success: false, contentItems: [{ type: 'inputText', text: error.message }] });
          }
        };
        execute().catch(error => emitRun(run, { type: 'coordination', stage: 'tool-error', message: error.message }));
        return;
      }
      const approval = { requestId: event.requestId, method: event.method, params: event.params, receivedAt: event.receivedAt, runId: run.id, agentId: run.agentId, adapter: run.adapter };
      run.approvals.set(approval.requestId, approval);
      emitRun(run, { type: 'approval_required', ...publicApproval(approval) });
    } else if (event.type === 'approval_timeout') {
      const approval = run.approvals.get(event.requestId);
      if (approval) { run.approvals.delete(event.requestId); emitRun(run, { type: 'approval_resolved', requestId: event.requestId, method: event.method, resolution: 'timeout', approval: publicApproval(approval) }); }
    }
    else if (event.type === 'provider_error') {
      if (run.interruption) return;
      run.status = 'failed'; emitRun(run, { type: 'error', message: event.message }); unsubscribe();
    }
  };
  const unsubscribe = client.on(onProviderEvent);
  run.detach = unsubscribe;
  // 启动期间也接受停止；尚未创建 turn 时不向引擎发送空 turnId。
  const stopBeforeTurn = () => {
    if (!run.cancelRequested) return false;
    run.status = 'cancelled'; emitRun(run, { type: 'cancelled', status: run.status }); unsubscribe(); return true;
  };
  try {
    await client.start();
    if (stopBeforeTurn()) return run;
    const diagnostic = await diagnostics.check({ cwd, client, sandbox: settings.sandbox });
    if (diagnostic.status === 'blocked') throw new Error(`${diagnostic.summary}。请前往「接口与能力 → 执行环境诊断」处理。${diagnostic.detail || ''}`);
    if (stopBeforeTurn()) return run;
    const threadSettings = Object.fromEntries(Object.entries(settings).filter(([key]) => !['sandboxPolicy', 'management', 'teamProtocolVersion', 'teamToolRole', 'providerFingerprint', 'reasoningEffort'].includes(key)));
    if (execution) Object.assign(threadSettings, execution.threadConfig);
    if (management) threadSettings.developerInstructions = (settings.developerInstructions || '') + managerInstructions(management, agentId);
    if (context?.coordinatorRunId) threadSettings.developerInstructions = (threadSettings.developerInstructions || '') + (management ? memberInstructions.replace('不要把普通进展当成提问，也不要自行启动其他成员。', '不要把普通进展当成提问；你仍可通过已注册管理工具派发本组成员，并处理他们的反馈。') : memberInstructions);
    if (teamThread.instructions) threadSettings.developerInstructions = (threadSettings.developerInstructions || '') + teamThread.instructions;
    // 旧历史缺少指令快照时保留引擎原配置，避免用环境提示覆盖未知的原始职责。
    if (!resumeThreadId || threadSettings.developerInstructions != null) threadSettings.developerInstructions = (threadSettings.developerInstructions || '') + executionGuidance();
    const thread = resumeThreadId
      ? await client.request('thread/resume', { threadId: resumeThreadId, cwd, ...threadSettings, excludeTurns: true })
      : await client.request('thread/start', { cwd, approvalPolicy: 'on-request', ...threadSettings,
        ...(management ? { dynamicTools: context?.coordinatorRunId ? [...TEAM_TOOLS, ...MEMBER_TOOLS] : TEAM_TOOLS } : context?.coordinatorRunId ? { dynamicTools: MEMBER_TOOLS } : {}), ephemeral: false, threadSource: 'agent-manager' });
    const threadData = thread?.thread || thread;
    if (!threadData?.id) throw new Error('Codex 未返回有效的会话标识，无法继续执行');
    run.threadId = threadData?.id; session.threadId = run.threadId; session.cwd = cwd;
    emitRun(run, { type: 'thread_started', threadId: run.threadId, thread: threadData });
    if (stopBeforeTurn()) return run;
    const turnSettings = Object.fromEntries(Object.entries(settings).filter(([key]) => ['model', 'approvalPolicy', 'sandboxPolicy'].includes(key)));
    if (execution) Object.assign(turnSettings, execution.turnConfig);
    const turn = await client.request('turn/start', { threadId: run.threadId, input: [{ type: 'text', text: goal }], cwd, ...turnSettings });
    run.turnId = turn?.turn?.id || turn?.id;
    if (!run.turnId) throw new Error('Codex 未返回有效的轮次标识，无法跟踪执行状态');
    run.startedAt ||= new Date().toISOString();
    if (!TERMINAL_RUN_STATES.has(run.status)) run.status = 'running';
    emitRun(run, { type: 'turn_accepted', turnId: run.turnId });
    for (const event of earlyNotifications.splice(0)) { if (TERMINAL_RUN_STATES.has(run.status)) break; onProviderEvent(event); }
    if (run.cancelRequested && !TERMINAL_RUN_STATES.has(run.status)) {
      try {
        await client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
        if (!TERMINAL_RUN_STATES.has(run.status)) { run.status = 'cancelled'; emitRun(run, { type: 'cancelled', status: run.status }); }
        unsubscribe();
      } catch (error) {
        // 中断请求失败不代表引擎已停止；继续跟踪原运行，允许再次停止。
        run.cancelRequested = false;
        if (!TERMINAL_RUN_STATES.has(run.status)) emitRun(run, { type: 'cancel_failed', message: error.message });
      }
    }
    return run;
  } catch (error) {
    run.status = 'failed'; emitRun(run, { type: 'error', message: error.message }); unsubscribe(); throw error;
  }
}
async function cancelRun(run) {
  if (TERMINAL_RUN_STATES.has(run.status)) {
    if (run.settings?.management) await teamCoordinator.stopChildren(run);
    return { runId: run.id, status: run.status };
  }
  run.cancelRequested = true;
  emitRun(run, { type: 'stopping' });
  try {
    if (run.settings?.management) await teamCoordinator.stopChildren(run);
    if (!run.turnId) return { runId: run.id, status: 'stopping' };
    const client = run.client || sessions.get(run.agentId)?.client;
    await client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
    for (const request of [...client.serverRequests.values()]) {
      if (request.params?.threadId !== run.threadId && !run.approvals.has(request.requestId)) continue;
      client.respondServerRequest(request.requestId, null, { code: -32800, message: 'Task cancelled' });
    }
    run.approvals.clear(); run.status = 'cancelled';
    if (run.settings?.management) run.delivery = { status: 'cancelled', summary: '团队任务已停止，未完成交付' };
    emitRun(run, { type: 'cancelled', status: run.status }); run.detach?.();
    return { runId: run.id, status: run.status };
  } catch (error) {
    run.cancelRequested = false; emitRun(run, { type: 'cancel_failed', message: error.message }); throw error;
  }
}
async function continueRun(runId, input) {
  const previous = runs.get(runId);
  if (!previous) throw Object.assign(new Error('原运行记录不存在或已删除'), { statusCode: 404 });
  const chain = conversationRuns(runs, previous), root = coordinatorRun(chain);
  if (chain.some(run => !TERMINAL_RUN_STATES.has(run.status))) throw Object.assign(new Error('此团队任务仍有成员运行，请等待或停止后再继续'), { statusCode: 409 });
  const coordinator = chain.filter(run => run.agentId === root.agentId).at(-1);
  const next = continuationInput(runs, coordinator, input?.goal);
  // 旧版只做计划的线程没有动态工具：同一任务下新建受管线程，保留原记录并携带已有计划。
  if (input?.management && !coordinator.settings?.management && root.context?.dispatchMode === 'manager') {
    next.management = parseManagement(input.management, coordinator.agentId, availableProviders());
    delete next.threadId;
    next.goal = (next.goal + '\n\n先前项目经理的计划（只是历史上下文，请依据实际工作区核验并继续交付）：\n' + (coordinator.output || '').slice(-9000)).slice(0, 12000);
  }
  return startRun(next);
}
async function listSkills(body) {
  const client = sessionFor('__catalog__').client; await client.start();
  const cwd = body?.cwd ? path.resolve(safeText(body.cwd, 'cwd', 400)) : ROOT;
  return client.request('skills/list', { cwds: [cwd], forceReload: Boolean(body?.forceReload) });
}
async function listMcp(body) {
  const client = sessionFor('__catalog__').client; await client.start();
  const detail = body?.detail === 'toolsAndAuthOnly' ? 'toolsAndAuthOnly' : 'full';
  return client.request('mcpServerStatus/list', { detail, limit: Math.min(Number(body?.limit || 100), 200) });
}
function configSummary() {
  const configPath = process.env.CODEX_CONFIG || path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex'), 'config.toml');
  let textContent = ''; try { textContent = fs.readFileSync(configPath, 'utf8'); } catch { /* shown as unavailable */ }
  const mcpNames = [...textContent.matchAll(/^\[mcp_servers\.([^\.\]]+)\]/gm)].map(match => match[1]);
  return { path: configPath, exists: Boolean(textContent), mcpServers: mcpNames, note: 'Raw credentials and environment values are never returned.' };
}
async function route(req, res) {
  try {
    assertLocalRequest(req, res);
    const url = parsePath(req); const pathname = url.pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,last-event-id', 'access-control-max-age': '600' }); return res.end(); }
    if (req.method === 'GET' && pathname === '/api/filesystem/directories') return json(res, 200, { data: await listDirectories(url.searchParams.get('path'), ROOT) });
    if (req.method === 'GET' && pathname === '/api/events') return workspaceEvents.attach(res);
    if (req.method === 'GET' && pathname === '/api/office') {
      const taskScope = url.searchParams.get('scope') === 'task';
      const taskId = url.searchParams.get('taskId');
      return json(res, 200, { data: officeSnapshot(runs, taskScope ? (taskId || '__no_current_task__') : null) });
    }
    if (req.method === 'DELETE' && pathname === '/api/runs') {
      if (url.searchParams.get('scope') !== 'finished') return apiError(res, 400, '请指定 scope=finished');
      return json(res, 200, { data: removeRunHistory([...runs.values()].filter(run => TERMINAL_RUN_STATES.has(run.status) && !run.approvals.size).map(run => run.id)) });
    }
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, service: 'agent-manager', version, providers: allProviders(), config: configSummary(), pendingApprovals: pendingApprovals().length });
    if (req.method === 'GET' && pathname === '/api/providers') return json(res, 200, { data: allProviders() });
    const providerEdit = pathname.match(/^\/api\/providers\/custom(?:\/([^/]+))?$/);
    if (providerEdit && ['POST', 'DELETE'].includes(req.method)) {
      assertLocalProviderRequest(req);
      const providerId = providerEdit[1] ? decodeURIComponent(providerEdit[1]) : undefined;
      const body = req.method === 'POST' ? await readJson(req) : null;
      if (providerId && providerEdits.has(providerId)) return apiError(res, 409, '此模型连接正在更新，请稍后重试');
      if (providerId) providerEdits.add(providerId);
      try {
        const usesProvider = run => run.adapter === providerId || run.settings?.management?.members.some(member => member.provider === providerId);
        if (providerId && [...runs.values()].some(run => usesProvider(run) && !TERMINAL_RUN_STATES.has(run.status))) return apiError(res, 409, '此连接正在被团队任务使用，请等待结束或停止任务后修改');
        if (req.method === 'DELETE') {
          if (!providerId) return apiError(res, 400, '请指定要删除的连接');
          if ([...runs.values()].some(usesProvider)) return apiError(res, 409, '历史会话仍引用此连接，请停用连接，或先删除对应历史后再删除连接');
          customProviders.remove(providerId);
          await releaseProviderSessions(providerId);
          workspaceEvents.publish(['providers']);
          return json(res, 200, { data: { id: providerId, deleted: true } });
        }
        const result = customProviders.save(body, providerId);
        engineReadiness.invalidate(result.id);
        if (providerId) await releaseProviderSessions(providerId);
        workspaceEvents.publish(['providers']);
        return json(res, 200, { data: result });
      } finally { providerEdits.delete(providerId); }
    }
    if (req.method === 'POST' && pathname === '/api/providers/test') {
      assertLocalProviderRequest(req);
      const body = await readJson(req);
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', abort);
      try { return json(res, 200, { data: await testProvider(customProviders.candidate(body, body.id), { signal: controller.signal }) }); }
      finally { res.off('close', abort); }
    }
    const diagnosticMatch = pathname.match(/^\/api\/providers\/([^/]+)\/(diagnostics|repair)$/);
    if (diagnosticMatch) {
      if (diagnosticMatch[1] !== 'codex-app-server' && !customProviders.has(decodeURIComponent(diagnosticMatch[1]))) return apiError(res, 404, '此供应商尚未接入诊断适配器', 'not_found');
      const body = req.method === 'POST' ? await readJson(req) : {};
      let cwd;
      try { cwd = resolveWorkingDirectory(body.cwd ?? url.searchParams.get('cwd'), ROOT); }
      catch (error) {
        // 目录故障独立于执行引擎和沙箱，检测失败时不能启动引擎或执行沙箱修复。
        if (error instanceof WorkingDirectoryError && diagnosticMatch[2] === 'diagnostics' && req.method === 'GET') {
          return json(res, 200, { data: { provider: diagnosticMatch[1], ...workingDirectoryDiagnostic(error) } });
        }
        throw error;
      }
      if (diagnosticMatch[2] === 'diagnostics' && req.method === 'GET') {
        const sandbox = url.searchParams.get('sandbox') || DEFAULT_SANDBOX;
        executionPermissions({ sandbox }, cwd);
        if (url.searchParams.get('checkEngine') === '1') {
          const key = decodeURIComponent(diagnosticMatch[1]);
          const engine = await engineReadiness.check(key, { force: url.searchParams.get('refresh') === '1', execution: key === 'codex-app-server' ? null : customProviders.execution(key, {}) });
          if (engine.status !== 'ready') return json(res, 200, { data: { ...engine, provider: key, cwd } });
          const sandboxState = await diagnostics.check({ cwd, sandbox, force: url.searchParams.get('refresh') === '1' });
          return json(res, 200, { data: { ...sandboxState, provider: key, cwd, engine, ...(sandboxState.status === 'notApplicable' ? { status: 'ready', summary: engine.summary } : {}) } });
        }
        return json(res, 200, { data: { ...await diagnostics.check({ cwd, sandbox, force: url.searchParams.get('refresh') === '1' }), cwd } });
      }
      if (diagnosticMatch[2] === 'repair' && req.method === 'POST') {
        if (body.action !== 'setup') return apiError(res, 400, 'Unsupported repair action');
        if ([...runs.values()].some(run => !TERMINAL_RUN_STATES.has(run.status))) return apiError(res, 409, '请等待正在执行的任务结束后再初始化沙箱', 'conflict');
        return json(res, 202, { data: await diagnostics.repair({ cwd }) });
      }
      return apiError(res, 405, 'Unsupported diagnostics method');
    }
    if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, { data: configSummary() });
    if (req.method === 'POST' && pathname === '/api/codex/skills') return json(res, 200, { data: await listSkills(await readJson(req)) });
    if (req.method === 'POST' && pathname === '/api/codex/mcp') return json(res, 200, { data: await listMcp(await readJson(req)) });
    if (req.method === 'GET' && pathname === '/api/sessions') return json(res, 200, { data: [...sessions.values()].filter(session => !session.agentId.startsWith('__')).map(session => ({ agentId: session.agentId, adapter: session.adapter, threadId: session.threadId, cwd: session.cwd, createdAt: session.createdAt, providerReady: Boolean(session.client.ready) })) });
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const session = sessions.get(decodeURIComponent(sessionMatch[1]));
      if (!session || session.agentId.startsWith('__')) return apiError(res, 404, 'session not found', 'not_found');
      return json(res, 200, { data: { agentId: session.agentId, adapter: session.adapter, threadId: session.threadId, cwd: session.cwd, createdAt: session.createdAt, providerReady: Boolean(session.client.ready) } });
    }
    const sessionTurnMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (req.method === 'POST' && sessionTurnMatch) {
      const agentId = decodeURIComponent(sessionTurnMatch[1]); const session = sessions.get(agentId);
      if (!session || !session.threadId) return apiError(res, 404, 'session has no resumable thread', 'not_found');
      const body = await readJson(req); const run = await startRun({ ...body, adapter: session.adapter, agentId, threadId: body.threadId || session.threadId });
      return json(res, 202, { data: { runId: run.id, agentId: run.agentId, adapter: run.adapter, status: run.status, eventsUrl: `/api/runs/${run.id}/events`, threadId: run.threadId } });
    }
    const sessionArchiveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
    if (req.method === 'POST' && sessionArchiveMatch) {
      const session = sessions.get(decodeURIComponent(sessionArchiveMatch[1]));
      if (!session || !session.threadId) return apiError(res, 404, 'session has no thread', 'not_found');
      const active = [...runs.values()].some(run => run.agentId === session.agentId && !['completed', 'failed', 'cancelled'].includes(run.status));
      if (active) return apiError(res, 409, 'cannot archive an active session', 'conflict');
      await session.client.start(); await session.client.request('thread/archive', { threadId: session.threadId });
      return json(res, 200, { data: { agentId: session.agentId, threadId: session.threadId, status: 'archived' } });
    }
    if (req.method === 'GET' && pathname === '/api/runs') return json(res, 200, { data: [...runs.values()].slice(-100).reverse().map(run => publicRun(run)) });
    if (req.method === 'GET' && pathname === '/api/conversations') return json(res, 200, { data: groupedConversations(runs).slice(0, 100).map(publicConversation) });
    if (req.method === 'GET' && pathname === '/api/notifications') {
      const chains = groupedConversations(runs);
      return json(res, 200, { data: [...deliveryNotifications(chains), ...feedbackNotifications(chains), ...runAlertNotifications(chains)].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 100) });
    }
    if (req.method === 'DELETE' && pathname === '/api/conversations') {
      if (url.searchParams.get('scope') !== 'finished') return apiError(res, 400, '请指定 scope=finished');
      const finished = groupedConversations(runs).filter(canDeleteConversation);
      const result = removeRunHistory(finished.flatMap(chain => chain.map(run => run.id)));
      return json(res, 200, { data: { ...result, deletedConversations: finished.length } });
    }
    if (req.method === 'GET' && pathname === '/api/approvals') return json(res, 200, { data: pendingApprovals() });
    const approvalResponseMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/respond$/);
    if (req.method === 'POST' && approvalResponseMatch) return json(res, 200, { data: await resolveApproval(decodeURIComponent(approvalResponseMatch[1]), await readJson(req)) });
    if (req.method === 'POST' && pathname === '/api/messages') {
      const body = await readJson(req);
      const message = {
        id: id('msg'),
        fromAgentId: safeText(body.fromAgentId, 'fromAgentId', 100),
        toAgentId: body.toAgentId == null ? null : safeText(body.toAgentId, 'toAgentId', 100),
        runId: body.runId == null ? null : safeText(body.runId, 'runId', 120),
        content: safeText(body.content, 'content', 20000),
        replyTo: body.replyTo == null ? null : safeText(body.replyTo, 'replyTo', 120),
        priority: body.priority == null ? 'normal' : safeText(body.priority, 'priority', 30),
        createdAt: new Date().toISOString()
      };
      emitMessage(message); return json(res, 201, { data: message });
    }
    if (req.method === 'GET' && pathname === '/api/messages') return json(res, 200, { data: messages });
    if (req.method === 'GET' && pathname === '/api/messages/stream') return attachMessageClient(res);
    if (req.method === 'POST' && pathname === '/api/runs') {
      const run = await startRun(await readJson(req)); return json(res, 202, { data: publicRun(run) });
    }
    if (req.method === 'POST' && pathname === '/api/tasks') return json(res, 202, { data: publicRun(taskQueue.submit(await readJson(req))) });
    const executionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/execution$/);
    if (req.method === 'GET' && executionMatch) {
      const selected = runs.get(decodeURIComponent(executionMatch[1]));
      if (!selected) return apiError(res, 404, '运行记录不存在或已经删除', 'not_found');
      const chain = conversationRuns(runs, selected), round = conversationRounds(chain).at(-1);
      const latest = [...new Map(round.runs.map(run => [run.agentId, run])).values()];
      const roster = round.manager?.settings.management.members || latest.map(run => ({ id: run.agentId, name: run.context?.agentName || run.agentId, role: run.context?.agentRole || '', provider: run.adapter }));
      const base = { conversationKey: conversationKey(selected), round: round.number, members: roster.map(({ id, name, role, provider }) => ({ id, name, role, provider })) };
      if (url.searchParams.get('view') === 'compact') return json(res, 200, { data: historySnapshots.project(`execution:${base.conversationKey}:${round.id}`, url.searchParams.get('since'), latest, base, run => compactRun(run, publicRun(run))) });
      return json(res, 200, { data: { ...base, runs: latest.map(run => ({ ...publicRun(run), output: run.output || '', progress: run.progress || null, ...(run.progress ? {} : { events: run.events }) })) } });
    }
    const conversationMatch = pathname.match(/^\/api\/runs\/([^/]+)\/conversation$/);
    if (req.method === 'DELETE' && conversationMatch) {
      const selected = runs.get(decodeURIComponent(conversationMatch[1]));
      if (!selected) return apiError(res, 404, '会话不存在或已经删除', 'not_found');
      const chain = conversationRuns(runs, selected);
      const result = removeRunHistory(chain.map(run => run.id));
      return json(res, 200, { data: { ...result, deletedConversations: 1 } });
    }
    if (req.method === 'GET' && conversationMatch) {
      const selected = runs.get(decodeURIComponent(conversationMatch[1]));
      if (!selected) return apiError(res, 404, '运行记录不存在或已经删除', 'not_found');
      const chain = conversationRuns(runs, selected), root = coordinatorRun(chain), coordinator = chain.filter(run => run.agentId === root.agentId).at(-1);
      let blockedReason = '';
      try { if (chain.some(run => !TERMINAL_RUN_STATES.has(run.status))) throw new Error('团队成员仍在执行'); continuationInput(runs, coordinator, 'check'); } catch (error) { blockedReason = error.message; }
      const requestedLimit = Number(url.searchParams.get('limit') || 50);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(2000, Math.floor(requestedLimit))) : 50;
      const rounds = conversationRounds(chain).map(({ runs: _runs, manager: _manager, ...round }) => round);
      if (url.searchParams.get('view') === 'compact') {
        const rawOffset = Number(url.searchParams.get('offset') || 0), offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
        const end = Math.max(0, chain.length - offset), begin = Math.max(0, end - Math.min(limit, 200));
        const selectedRuns = chain.slice(begin, end), detail = url.searchParams.get('detail') === '1';
        const base = { summary: publicConversation(chain), threadId: coordinator.threadId, total: chain.length,
          offset, hasEarlier: begin > 0, hasNewer: offset > 0,
          rounds: rounds.filter(round => round.runIds.some(id => selectedRuns.some(run => run.id === id))).map(round => ({ ...round, delivery: compactDelivery(round.delivery, round.requestRunId) })), canContinue: !blockedReason, blockedReason };
        return json(res, 200, { data: historySnapshots.project(`${conversationKey(selected)}:${limit}:${offset}:${detail}`, url.searchParams.get('since'), selectedRuns, base, run => compactRun(run, publicRun(run), detail)) });
      }
      return json(res, 200, { data: { summary: publicConversation(chain), threadId: coordinator.threadId, total: chain.length, rounds, runs: chain.slice(-limit).map(run => publicRun(run, true)), canContinue: !blockedReason, blockedReason } });
    }
    const continueMatch = pathname.match(/^\/api\/runs\/([^/]+)\/continue$/);
    if (req.method === 'POST' && continueMatch) {
      const run = await continueRun(decodeURIComponent(continueMatch[1]), await readJson(req));
      return json(res, 202, { data: publicRun(run) });
    }
    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === 'DELETE' && runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      if (!runs.has(runId)) return apiError(res, 404, '运行记录不存在或已经删除', 'not_found');
      return json(res, 200, { data: removeRunHistory([runId]) });
    }
    if (req.method === 'GET' && runMatch) { const run = runs.get(runMatch[1]); if (!run) return apiError(res, 404, 'run not found', 'not_found'); return json(res, 200, { data: url.searchParams.get('view') === 'compact' ? compactRun(run, publicRun(run), true) : publicRun(run, true) }); }
    const transcriptMatch = pathname.match(/^\/api\/runs\/([^/]+)\/transcript$/);
    if (req.method === 'GET' && transcriptMatch) {
      const run = runs.get(decodeURIComponent(transcriptMatch[1])); if (!run) return apiError(res, 404, 'run not found', 'not_found');
      res.setHeader('Content-Disposition', 'attachment; filename="execution.txt"');
      return text(res, 200, JSON.stringify({ goal: run.goal, context: run.context, messages: run.messages || [], output: run.messages?.length ? undefined : run.output,
        delivery: run.delivery, feedback: run.feedback || [], progress: run.progress, error: run.error }, null, 2));
    }
    const eventMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (req.method === 'GET' && eventMatch) { const run = runs.get(eventMatch[1]); if (!run) return apiError(res, 404, 'run not found', 'not_found'); return attachClient(run, res, Number(req.headers['last-event-id']) || 0); }
    const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const run = runs.get(cancelMatch[1]); if (!run) return apiError(res, 404, 'run not found', 'not_found');
      const result = run.batch ? await taskQueue.cancel(run.batch.id) : await cancelRun(run);
      return json(res, result.status === 'stopping' ? 202 : 200, { data: result });
    }
    if (req.method === 'GET' && pathname === '/') return text(res, 200, fs.readFileSync(HTML), 'text/html; charset=utf-8');
    if (req.method === 'GET' && pathname === '/agent-manager.html') return text(res, 200, fs.readFileSync(HTML), 'text/html; charset=utf-8');
    return apiError(res, 404, 'route not found', 'not_found');
  } catch (err) { if (res.headersSent) { res.destroy(); return; } return apiError(res, err.statusCode || (/body|must be|adapter/.test(err.message) ? 400 : 502), err.message, err instanceof WorkingDirectoryError ? err.code : err.statusCode === 404 ? 'not_found' : err.statusCode === 403 ? 'forbidden' : 'provider_error'); }
}
const server = http.createServer((req, res) => route(req, res));
if (require.main === module) {
  require('./server/service-lifecycle.cjs').installServiceLifecycle({ server, sessions, runStore, beforeStop: reason => {
    taskQueue.stop();
    for (const run of runs.values()) if (!TERMINAL_RUN_STATES.has(run.status)) {
      run.interruption = reason; run.status = reason === 'service-error' ? 'failed' : 'cancelled';
      run.error = '服务已中断，任务尚未完成；可在原会话查看记录并继续。';
      emitRun(run, { type: 'completed', status: run.status, message: run.error });
    }
  } });
  server.listen(PORT, HOST, () => {
    console.log(`Agent Manager server listening at http://${HOST}:${PORT}`);
    if (process.connected) process.send({ type: 'team-studio:ready' });
  });
}
module.exports = { JsonRpcClient, emitRun, attachClient, publicRun, startRun, continueRun, cancelRun, teamCoordinator, taskQueue, sessions, runs, findApproval, resolveApproval, route, customProviders };
