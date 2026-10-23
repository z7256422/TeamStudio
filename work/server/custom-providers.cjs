const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { protectSecret, revealSecret } = require('./provider-secrets.cjs');
const { normalizeReasoningEffort, reasoningConfigurationHint } = require('../shared/model-reasoning.js');
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const required = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw bad(`${name} 须为 1–${max} 字符的单行文本`);
  return value.trim();
};
function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(required(value, 'Base URL', 2000)); } catch { throw bad('请填写有效的 http:// 或 https:// Base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw bad('Base URL 仅支持 HTTP/HTTPS，不能包含凭据、查询参数或片段');
  if (/\/chat\/completions\/?$/i.test(url.pathname)) throw bad('此地址是 Chat Completions；Codex 自定义模型需要支持 Responses API 的服务');
  url.pathname = url.pathname.replace(/\/responses\/?$/i, '').replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

// 浏览器只持有公开目录，凭据不参与团队导出、运行快照或 Codex config。
function createCustomProviders({ file = null, seal = protectSecret, unseal = revealSecret } = {}) {
  let records = [];
  if (file && fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.version !== 1 || !Array.isArray(parsed.providers)) throw new Error('自定义模型配置文件格式无效');
    records = parsed.providers;
  }
  const keys = new Map();
  const find = id => { const record = records.find(item => item.id === id); if (!record) throw bad('自定义模型连接不存在，请在接口与能力中重新配置', 404); return record; };
  const keyFor = record => {
    if (!keys.has(record.id)) keys.set(record.id, unseal(record.secret));
    return keys.get(record.id);
  };
  const publicRecord = record => ({ id: record.id, label: record.label, baseUrl: record.baseUrl, defaultModel: record.defaultModel, reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
    protocol: record.protocol, auth: record.auth, enabled: record.enabled, fingerprint: record.fingerprint, updatedAt: record.updatedAt,
    hasApiKey: Boolean(record.secret), kind: 'http', engine: 'codex-app-server',
    status: record.enabled && (record.auth === 'none' || record.secret) ? 'available' : 'disabled',
    capabilities: ['sessions', 'tools', 'mcp', 'skills', 'streaming', 'interrupt', 'approvals', 'team-feedback'] });
  const persist = next => {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, providers: next }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    records = next;
  };
  function prepare(input, previous) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('连接配置必须是对象');
    const protocol = input.protocol || 'responses';
    if (protocol !== 'responses') throw bad('当前 Codex 引擎仅支持 Responses API');
    const auth = input.auth || 'apiKey';
    if (!['apiKey', 'none'].includes(auth)) throw bad('认证方式无效');
    const label = required(input.label, '连接名称', 120);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const defaultModel = required(input.defaultModel, '默认模型 ID', 120);
    const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort ?? previous?.reasoningEffort);
    if (defaultModel === 'default') throw bad('请填写供应商实际模型 ID，不能使用 default');
    let key = '';
    if (auth === 'apiKey') {
      if (input.clearApiKey) throw bad('使用 API Key 认证时不能清空密钥；无认证服务请选择无需密钥');
      key = input.apiKey ? required(input.apiKey, 'API Key', 8192) : previous ? keyFor(previous) : '';
      if (!key) throw bad('请填写 API Key；编辑时留空会保留已保存密钥');
    }
    const record = { id: previous?.id || `custom-${crypto.randomUUID()}`, label, baseUrl, defaultModel, reasoningEffort, protocol, auth,
      enabled: input.enabled !== false, fingerprint: digest(JSON.stringify([baseUrl, protocol, auth])), updatedAt: new Date().toISOString() };
    return { record, key };
  }
  return {
    list: () => records.map(publicRecord),
    has: id => records.some(item => item.id === id),
    save(input, id) {
      const previous = id ? find(id) : null;
      if (!previous && records.length >= 100) throw bad('最多保存 100 个自定义连接');
      const { record, key } = prepare(input, previous);
      // 新密钥直接加密，不能要求先解密旧密钥；换机器/系统用户后才能重新配置。
      record.secret = key && previous && !input.apiKey ? previous.secret : seal(key);
      persist([...records.filter(item => item.id !== record.id), record]);
      keys.set(record.id, key);
      return publicRecord(record);
    },
    remove(id) { find(id); persist(records.filter(item => item.id !== id)); keys.delete(id); },
    candidate(input, id) { return prepare(input, id ? find(id) : null); },
    execution(id, input = {}) {
      const record = find(id);
      if (!record.enabled) throw bad('此模型连接已停用，请启用后继续任务', 409);
      if (input.providerFingerprint && input.providerFingerprint !== record.fingerprint) throw bad('此会话的模型接口地址或认证方式已经变化，请恢复原连接配置后继续，或创建新任务', 409);
      const key = record.auth === 'apiKey' ? keyFor(record) : '';
      if (record.auth === 'apiKey' && !key) throw bad('此模型连接缺少 API Key');
      const model = input.model && input.model !== 'default' ? required(input.model, '模型 ID', 120) : record.defaultModel;
      const providerName = id.replaceAll('-', '');
      const reasoningEffort = normalizeReasoningEffort(record.reasoningEffort);
      // 每个连接独立覆盖思考参数；续聊也显式传给 turn/start，覆盖原线程保留的不兼容值。
      const explicitEffort = reasoningEffort !== 'default';
      return { adapter: id, model, reasoningEffort, fingerprint: record.fingerprint, sessionKey: `${id}:${record.fingerprint}:${digest(key)}:${reasoningEffort}`,
        env: { TEAM_STUDIO_MODEL_KEY: key },
        turnConfig: explicitEffort ? { effort: reasoningEffort } : {},
        threadConfig: { modelProvider: providerName, config: { ...(explicitEffort ? { model_reasoning_effort: reasoningEffort } : {}), [`model_providers.${providerName}`]: {
          name: record.label, base_url: record.baseUrl, wire_api: 'responses', requires_openai_auth: false,
          ...(key ? { env_key: 'TEAM_STUDIO_MODEL_KEY' } : {}), request_max_retries: 0, stream_max_retries: 0
        } } }
      };
    }
  };
}

// 强制模型返回一个无副作用的函数调用，验证流式 Responses 与工具协议；不执行任何工具。
async function testProvider({ record, key }, { signal, timeoutMs = 25000 } = {}) {
  const started = Date.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${record.baseUrl}/responses`, { method: 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: record.defaultModel, input: 'Call connection_probe with value ok.', stream: true,
        ...(normalizeReasoningEffort(record.reasoningEffort) !== 'default' ? { reasoning: { effort: record.reasoningEffort } } : {}),
        tools: [{ type: 'function', name: 'connection_probe', description: 'Connection test only; no side effects.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }],
        tool_choice: { type: 'function', name: 'connection_probe' } })
    });
    if (!response.ok) {
      const hint = [400, 422].includes(response.status) ? await responseReasoningHint(response) : '';
      await response.body?.cancel();
      throw bad(hint || ({ 401: '认证失败，请检查 API Key', 403: '接口拒绝访问，请检查密钥权限', 404: '找不到模型或 Responses 路径，请检查 Base URL 和模型 ID', 429: '接口限流或额度不足' })[response.status] || `模型接口返回 HTTP ${response.status}`);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw bad('服务未返回 SSE 流，请确认支持 Responses 流式协议'); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', bytes = 0, completed = false, tool = false;
    try {
      while (!completed) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) throw bad('测试响应超出 1 MB 限制');
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
          let event; try { event = JSON.parse(line.slice(5)); } catch { throw bad('接口返回了无效的 Responses 流事件'); }
          if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw bad(reasoningConfigurationHint(event.error?.message || event.response?.error?.message || event.message) || '模型未完成测试，请检查模型权限、额度及 Responses 兼容性');
          const items = event.item ? [event.item] : event.response?.output || [];
          if (items.some(item => item.type === 'function_call' && item.name === 'connection_probe' && (() => { try { return JSON.parse(item.arguments).value === 'ok'; } catch { return false; } })())) tool = true;
          if (event.type === 'response.completed') completed = true;
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!completed || !tool) throw bad('连接已建立，但未完成规定的工具调用；该模型暂不满足团队执行要求');
    return { ok: true, model: record.defaultModel, reasoningEffort: normalizeReasoningEffort(record.reasoningEffort), durationMs: Date.now() - started, message: 'Responses 流式输出与工具调用测试通过。实际文件、MCP 和 skills 能力由本机 Codex 执行。' + (normalizeReasoningEffort(record.reasoningEffort) === 'default' ? ' 未指定思考强度，正式任务将沿用 Codex / 原会话设置。' : ` 思考强度：${record.reasoningEffort}。`) };
  } catch (error) {
    if (error.statusCode) throw error;
    throw bad(signal?.aborted ? '连接测试已取消' : deadline.aborted ? '连接测试超时（25 秒），请检查接口是否可达' : '连接失败，请检查地址、网络和 TLS 证书', 502);
  }
}
// 上游错误正文只用于识别参数类型，限量读取且不原样回显，避免泄露网关返回的凭据。
async function responseReasoningHint(response) {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let content = '', bytes = 0;
  try {
    while (bytes < 8192) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 8192 - bytes); bytes += chunk.length;
      content += decoder.decode(chunk, { stream: true });
    }
    return reasoningConfigurationHint(content);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function assertLocalProviderRequest(req) {
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw bad('模型连接管理仅允许本机访问', 403);
  if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) throw bad('请通过本机服务页面配置模型连接，禁止跨站请求', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw bad('禁止跨站修改模型连接', 403);
}
module.exports = { createCustomProviders, normalizeBaseUrl, testProvider, assertLocalProviderRequest };
