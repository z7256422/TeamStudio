const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodexDiagnostics } = require('./provider-diagnostics.cjs');
function fixture(options = {}) {
  const calls = [], listeners = new Set();
  let readiness = 'ready', probe = { exitCode: 0, stderr: '' }, setupResponse = { started: true };
  const client = { start: async () => {}, on: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'windowsSandbox/readiness') { if (readiness instanceof Error) throw readiness; return { status: readiness }; }
      if (method === 'command/exec') { if (probe instanceof Error) throw probe; return probe; }
      if (method === 'windowsSandbox/setupStart') return setupResponse;
      throw new Error('Unexpected method');
    } };
  const diagnostics = createCodexDiagnostics({ getClient: () => client, platform: 'win32', ...options });
  return { diagnostics, calls, listeners, client, setReadiness: value => { readiness = value; }, setProbe: value => { probe = value; },
    emit: event => { for (const listener of [...listeners]) listener(event); }, setSetup: value => { setupResponse = value; } };
}
test('预检确认初始化及只读启动，缓存按目录隔离，绝不启动轮次或修改权限', async () => {
  const f = fixture();
  assert.equal((await f.diagnostics.check({ cwd: 'C:/one' })).status, 'ready');
  assert.equal((await f.diagnostics.check({ cwd: 'C:/one' })).status, 'ready');
  assert.equal(f.calls.length, 2);
  await f.diagnostics.check({ cwd: 'C:/two' }); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[1].params.command, ['cmd.exe', '/d', '/c', 'exit', '0']);
  assert.equal(f.calls[1].params.sandboxPolicy.type, 'readOnly');
  assert.ok(f.calls.every(call => !/thread|turn|setup/.test(call.method)));
});
test('沙箱未配置或需更新时阻止启动；已初始化但账户故障仍明确失败', async () => {
  for (const readiness of ['notConfigured', 'updateRequired']) {
    const f = fixture(); f.setReadiness(readiness);
    assert.equal((await f.diagnostics.check()).status, 'blocked'); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.setProbe(new Error('LookupAccountNameW 1788: CodexSandboxOffline'));
  const result = await f.diagnostics.check(); assert.equal(result.status, 'blocked'); assert.match(result.detail, /1788/);
  f.setProbe({ exitCode: 0 }); assert.equal((await f.diagnostics.check({ force: true })).status, 'ready');
});
test('旧引擎不支持诊断时标未知，普通文本不误报；实际故障清理成功缓存', async () => {
  const f = fixture(); f.setReadiness(new Error('method not found'));
  assert.equal((await f.diagnostics.check()).status, 'unknown');
  f.setReadiness('ready'); await f.diagnostics.check({ force: true }); const count = f.calls.length;
  f.diagnostics.observe({ type: 'message_delta', delta: 'LookupAccountNameW' });
  await f.diagnostics.check(); assert.equal(f.calls.length, count);
  f.diagnostics.observe({ type: 'approval_required', params: { reason: 'LookupAccountNameW 1788' } });
  f.setProbe(new Error('CodexSandboxOffline')); assert.equal((await f.diagnostics.check()).status, 'blocked');
  assert.ok(f.calls.length > count);
});
test('修复显式开始，按完成通知收敛，失败及超时释放监听器', async () => {
  let changes = 0;
  const f = fixture({ setupTimeout: 15, onChange: () => changes++ });
  assert.equal((await f.diagnostics.repair({ cwd: 'C:/one' })).status, 'running');
  assert.equal((await f.diagnostics.check()).status, 'blocked');
  await f.diagnostics.repair(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, { cwd: 'C:/one', mode: 'elevated' });
  f.emit({ type: 'notification', method: 'windowsSandbox/setupCompleted', params: { mode: 'elevated', success: true } });
  assert.equal(f.listeners.size, 0); assert.equal((await f.diagnostics.check()).setup.status, 'completed');
  await f.diagnostics.repair(); f.emit({ type: 'provider_error', message: 'process exited' });
  assert.equal((await f.diagnostics.check()).setup.status, 'failed'); assert.equal(f.listeners.size, 0);
  await f.diagnostics.repair(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.listeners.size, 0); assert.match((await f.diagnostics.check()).setup.error, /时限/);
  assert.equal(changes, 6, '每次开始与结束都通知界面，不需要定时检测');
});
test('非 Windows 无额外 RPC，修复不适用', async () => {
  const f = fixture({ platform: 'linux' }); assert.equal((await f.diagnostics.check()).status, 'notApplicable');
  await assert.rejects(f.diagnostics.repair(), /不需要/); assert.equal(f.calls.length, 0);
});

test('无沙箱跳过检查，不受已缓存账户故障或修复状态影响；切回沙箱仍检查', async () => {
  const f = fixture(); f.setProbe(new Error('LookupAccountNameW 1788: CodexSandboxOffline'));
  assert.equal((await f.diagnostics.check({ sandbox: 'read-only' })).status, 'blocked');
  const count = f.calls.length;
  const unrestricted = await f.diagnostics.check({ sandbox: 'danger-full-access', force: true });
  assert.equal(unrestricted.status, 'notApplicable');
  assert.equal(unrestricted.repair.available, false);
  assert.equal(f.calls.length, count);
  await f.diagnostics.repair();
  const afterRepair = f.calls.length;
  assert.equal((await f.diagnostics.check({ sandbox: 'danger-full-access' })).status, 'notApplicable');
  assert.equal(f.calls.length, afterRepair);
  assert.equal((await f.diagnostics.check({ sandbox: 'workspace-write' })).status, 'blocked');
  f.emit({ type: 'notification', method: 'windowsSandbox/setupCompleted', params: { mode: 'elevated', success: false, error: 'fixture' } });
});
