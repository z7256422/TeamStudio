const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { route, runs, customProviders, emitRun } = require('../agent-manager-server.cjs');
test('供应商 API 支持增改删、阻止在用配置变更并保护历史引用', async t => {
  const server = http.createServer(route);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { runs.clear(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { label: 'Local model', baseUrl: 'http://localhost:9999/v1', defaultModel: 'model-a', auth: 'none', reasoningEffort: 'low' };
  const request = (url, body, method = 'POST', headers = {}) => fetch(base + url, { method, headers: { 'content-type': 'application/json', origin: base, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let response = await request('/api/providers/custom', config, 'POST', { origin: 'https://outside.example' });
  assert.equal(response.status, 403);
  response = await request('/api/providers/custom', config);
  assert.equal(response.status, 200); const provider = (await response.json()).data;
  assert.equal(provider.reasoningEffort, 'low');
  t.after(() => { if (customProviders.has(provider.id)) customProviders.remove(provider.id); });
  const available = (await (await fetch(base + '/api/providers')).json()).data;
  assert.ok(available.some(item => item.id === provider.id && item.engine === 'codex-app-server'));
  assert.ok(!JSON.stringify(available).includes('secret'));
  // 即使此成员尚未被派发，经理已经持有的花名册也占用其供应商。
  const run = { id: 'active', adapter: 'codex-app-server', status: 'running', settings: { management: { members: [{ provider: provider.id }] } } };
  runs.set(run.id, run);
  response = await request(`/api/providers/custom/${provider.id}`, { ...config, defaultModel: 'model-b' });
  assert.equal(response.status, 409); assert.equal(customProviders.execution(provider.id).model, 'model-a');
  response = await request(`/api/providers/custom/${provider.id}`, { ...config, reasoningEffort: 'high' });
  assert.equal(response.status, 409); assert.equal(customProviders.execution(provider.id).reasoningEffort, 'low');
  run.status = 'completed';
  response = await request(`/api/providers/custom/${provider.id}`, { ...config, reasoningEffort: 'high' });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.reasoningEffort, 'high');
  response = await request(`/api/providers/custom/${provider.id}`, null, 'DELETE'); assert.equal(response.status, 409);
  response = await request(`/api/providers/custom/${provider.id}`, { ...config, enabled: false }); assert.equal(response.status, 200);
  assert.equal(customProviders.list().find(item => item.id === provider.id).status, 'disabled');
  runs.clear(); response = await request(`/api/providers/custom/${provider.id}`, null, 'DELETE'); assert.equal(response.status, 200);
});

test('自定义模型思考参数错误给出配置入口，普通失败及默认 Codex 不追加错误建议', () => {
  const makeRun = adapter => ({ id: 'effort-error', agentId: 'test', adapter, status: 'failed', events: [], subscribers: new Set(), approvals: new Map() });
  const rejected = makeRun('custom-test');
  emitRun(rejected, { type: 'error', message: '该模型始终思考，不支持关闭思考；请使用 low、high 或 max。' });
  assert.match(rejected.error, /配置 \/ 测试/); assert.match(rejected.progress.error, /思考强度/);
  const native = makeRun('codex-app-server');
  emitRun(native, { type: 'error', message: 'Unsupported reasoning effort' });
  assert.equal(native.error, 'Unsupported reasoning effort');
  const network = makeRun('custom-test');
  emitRun(network, { type: 'error', message: 'network disconnected' });
  assert.equal(network.error, 'network disconnected');
});
