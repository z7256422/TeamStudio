const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createCustomProviders, normalizeBaseUrl, testProvider, assertLocalProviderRequest } = require('./custom-providers.cjs');
const { protectSecret, revealSecret } = require('./provider-secrets.cjs');
const draft = overrides => ({ label: 'Example', baseUrl: 'https://example.com/v1/responses', defaultModel: 'model-a', apiKey: 'private-key', ...overrides });
const codec = { seal: value => value ? Buffer.from(value).toString('hex') : '', unseal: value => Buffer.from(value, 'hex').toString() };
test('URL 规范保留前缀，拒绝嵌入凭据和不兼容接口', () => {
  assert.equal(normalizeBaseUrl('https://example.com/custom/v1/responses/'), 'https://example.com/custom/v1');
  for (const value of ['ftp://example.com', 'https://key@example.com/v1', 'https://example.com/v1?key=abc', 'https://example.com/chat/completions']) assert.throws(() => normalizeBaseUrl(value));
});
test('凭据加密保存，编辑留空保留、轮换、无需认证清空，公开目录不含密钥', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-store-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const options = { file: path.join(folder, 'providers.json'), ...codec };
  const store = createCustomProviders(options), first = store.save(draft());
  assert.doesNotMatch(JSON.stringify(first), /private-key|secret/);
  assert.doesNotMatch(fs.readFileSync(options.file, 'utf8'), /private-key/);
  let execution = store.execution(first.id);
  assert.equal(execution.env.TEAM_STUDIO_MODEL_KEY, 'private-key');
  assert.equal(execution.model, 'model-a');
  assert.doesNotMatch(JSON.stringify(execution.threadConfig), /private-key/);
  store.save(draft({ apiKey: '', label: 'renamed' }), first.id);
  assert.equal(createCustomProviders(options).execution(first.id).env.TEAM_STUDIO_MODEL_KEY, 'private-key');
  store.save(draft({ apiKey: 'rotated' }), first.id);
  assert.notEqual(store.execution(first.id).sessionKey, execution.sessionKey);
  assert.equal(store.execution(first.id).fingerprint, execution.fingerprint);
  store.save(draft({ auth: 'none', apiKey: '' }), first.id);
  assert.equal(store.list()[0].hasApiKey, false);
  assert.equal(store.execution(first.id).env.TEAM_STUDIO_MODEL_KEY, '');
});
test('历史模型快照固定，地址更改/停用拒绝续聊，不回退到 Codex 默认模型', () => {
  const store = createCustomProviders(codec), first = store.save(draft());
  const execution = store.execution(first.id);
  store.save(draft({ defaultModel: 'model-b' }), first.id);
  assert.equal(store.execution(first.id, { model: execution.model, providerFingerprint: execution.fingerprint }).model, 'model-a');
  store.save(draft({ baseUrl: 'https://another.example/v1' }), first.id);
  assert.throws(() => store.execution(first.id, { providerFingerprint: execution.fingerprint }), /已经变化/);
  store.save(draft({ enabled: false }), first.id);
  assert.throws(() => store.execution(first.id), /已停用/);
  assert.throws(() => store.execution('missing'), /不存在/);
});

test('思考强度独立持久化并同时映射到 thread config 与 turn/start；旧配置沿用且不锁死续聊', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-effort-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const options = { file: path.join(folder, 'providers.json'), ...codec };
  const store = createCustomProviders(options), legacy = store.save(draft());
  assert.equal(legacy.reasoningEffort, 'default');
  assert.equal(store.execution(legacy.id).threadConfig.config.model_reasoning_effort, undefined);
  assert.deepEqual(store.execution(legacy.id).turnConfig, {});
  const first = store.save(draft({ reasoningEffort: 'low' }), legacy.id);
  let execution = createCustomProviders(options).execution(first.id);
  assert.equal(execution.threadConfig.config.model_reasoning_effort, 'low');
  assert.deepEqual(execution.turnConfig, { effort: 'low' });
  assert.equal(first.reasoningEffort, 'low');
  store.save(draft({ label: 'renamed without new effort' }), first.id);
  assert.equal(store.execution(first.id).reasoningEffort, 'low');
  store.save(draft({ reasoningEffort: 'max' }), first.id);
  const resumed = store.execution(first.id, { reasoningEffort: 'low', providerFingerprint: execution.fingerprint });
  assert.equal(resumed.reasoningEffort, 'max', 'connection tuning applies to the next resumed turn');
  assert.equal(resumed.fingerprint, execution.fingerprint); assert.notEqual(resumed.sessionKey, execution.sessionKey);
  assert.deepEqual(resumed.turnConfig, { effort: 'max' });
  store.save(draft({ reasoningEffort: 'none' }), first.id); assert.deepEqual(store.execution(first.id).turnConfig, { effort: 'none' });
  store.save(draft({ reasoningEffort: 'default' }), first.id); assert.deepEqual(store.execution(first.id).turnConfig, {});
  assert.throws(() => store.save(draft({ reasoningEffort: 'invented' })), /思考强度无效/);
});
test('迁移后旧密钥不可解密时仍可直接替换新密钥，目录仅公开白名单', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-migration-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'providers.json'), original = createCustomProviders({ file, ...codec });
  const provider = original.save(draft());
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')); stored.providers[0].apiKey = 'unexpected-private-field';
  fs.writeFileSync(file, JSON.stringify(stored));
  const migrated = createCustomProviders({ file, seal: codec.seal, unseal: () => { throw new Error('Different Windows user'); } });
  assert.ok(!JSON.stringify(migrated.list()).includes('unexpected-private-field'));
  assert.throws(() => migrated.save(draft({ apiKey: '' }), provider.id), /Different Windows user/);
  migrated.save(draft({ apiKey: 'new-machine-key' }), provider.id);
  assert.equal(migrated.execution(provider.id).env.TEAM_STUDIO_MODEL_KEY, 'new-machine-key');
});
test('Windows DPAPI 可以还原特殊字符密钥，不存明文', { skip: process.platform !== 'win32' }, () => {
  const key = 'test-key-$()`&!-%-中文';
  const secret = protectSecret(key);
  assert.ok(secret.startsWith('dpapi:')); assert.ok(!secret.includes(key)); assert.equal(revealSecret(secret), key);
});
test('模型写接口拒绝跨站与 DNS rebinding Host', () => {
  for (const headers of [{ host: 'evil.example:3210' }, { host: '127.0.0.1:3210', origin: 'null' }, { host: 'localhost:3210', origin: 'https://evil.example' }]) assert.throws(() => assertLocalProviderRequest({ headers }), /本机|跨站/);
  assert.doesNotThrow(() => assertLocalProviderRequest({ headers: { host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3210' } }));
});
test('连接测试验证流式工具调用，处理错误、取消、重定向且不泄露密钥', async t => {
  let mode = 'valid', requests = 0;
  const server = http.createServer(async (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer private-key');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).stream, true);
    assert.deepEqual(JSON.parse(body).reasoning, { effort: 'low' });
    if (mode === 'auth') { res.writeHead(401); return res.end('private-key'); }
    if (mode === 'redirect') { res.writeHead(302, { location: '/stolen' }); return res.end(); }
    if (mode === 'reasoning-http') { res.writeHead(400); return res.end(JSON.stringify({ error: { message: '该模型不支持关闭思考，请使用 low、high 或 max。private-key' } })); }
    if (mode === 'wait') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': waiting\n\n'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'reasoning-stream') return res.end('data: ' + JSON.stringify({ type: 'response.failed', response: { error: { message: 'Unsupported reasoning effort xhigh private-key' } } }) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', name: mode === 'valid' ? 'connection_probe' : 'other', arguments: '{"value":"ok"}' } }) + '\r\n\r\n');
    res.end('data: {"type":"response.completed"}\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const candidate = createCustomProviders(codec).candidate(draft({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoningEffort: 'low' }));
  assert.equal((await testProvider(candidate)).ok, true);
  mode = 'text'; await assert.rejects(testProvider(candidate), /未完成规定的工具调用/);
  mode = 'auth'; await assert.rejects(testProvider(candidate), error => !error.message.includes('private-key') && error.message.includes('认证失败'));
  mode = 'redirect'; const before = requests; await assert.rejects(testProvider(candidate), /连接失败/); assert.equal(requests, before + 1);
  for (const failureMode of ['reasoning-http', 'reasoning-stream']) {
    mode = failureMode;
    await assert.rejects(testProvider(candidate), error => /思考强度/.test(error.message) && !error.message.includes('private-key'));
  }
  mode = 'wait'; const controller = new AbortController(); const result = testProvider(candidate, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30); await assert.rejects(result, /取消/);
});
