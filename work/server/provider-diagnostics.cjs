/* 通用诊断结果由供应商适配器产生；检查不会创建会话、改配置或降低任务权限。 */
function sandboxFault(text) { return /LookupAccountNameW|CodexSandboxOffline|windows sandbox[^\n]*(?:failed|error)|sandbox setup failed/i.test(String(text || '')); }
function createCodexDiagnostics({ getClient, platform = process.platform, now = Date.now, ttl = 30000, setupTimeout = 120000, onChange = () => {} }) {
  const cache = new Map(), pending = new Map();
  let setup = null, fault = '', revision = 0;
  const result = (status, summary, extra = {}) => ({ provider: 'codex-app-server', status, summary,
    checkedAt: new Date(now()).toISOString(), repair: { available: platform === 'win32', action: 'setup', mode: 'elevated' }, ...extra });
  async function check({ cwd, sandbox = 'workspace-write', force = false, client: suppliedClient } = {}) {
    // 无沙箱任务不依赖 Windows 沙箱账户，也不能被缓存的沙箱故障或修复过程阻止。
    if (sandbox === 'danger-full-access') return result('notApplicable', '当前使用无沙箱模式，无需 Windows 沙箱初始化', { sandbox, repair: { available: false } });
    if (platform !== 'win32') return result('notApplicable', '当前平台无需 Windows 沙箱初始化');
    if (setup?.status === 'running') return result('blocked', 'Windows 沙箱正在初始化，请等待完成', { setup });
    const key = cwd || '';
    if (!force && cache.has(key) && now() - cache.get(key).time < ttl) return cache.get(key).value;
    if (pending.has(key)) return pending.get(key);
    const version = revision;
    const promise = (async () => {
      let readiness;
      try {
        const client = getClient(suppliedClient); if (!suppliedClient) await client.start();
        readiness = (await client.request('windowsSandbox/readiness', {})).status;
        if (readiness !== 'ready') {
          const known = ['notConfigured', 'updateRequired'].includes(readiness);
          return result(known ? 'blocked' : 'unknown', readiness === 'notConfigured' ? 'Windows 沙箱尚未初始化' : readiness === 'updateRequired' ? 'Windows 沙箱需要更新' : '引擎返回未知的沙箱状态', { readiness, setup });
        }
        // readiness 只检查初始化状态；固定的空命令确认账户确实能在只读沙箱中启动。
        const probe = await client.request('command/exec', { command: ['cmd.exe', '/d', '/c', 'exit', '0'], cwd,
          sandboxPolicy: { type: 'readOnly' }, timeoutMs: 5000 });
        if (probe.exitCode !== 0 || sandboxFault(probe.stderr)) throw new Error(probe.stderr || `沙箱检查命令退出码 ${probe.exitCode}`);
        if (version === revision) fault = '';
        return result('ready', 'Windows 沙箱已就绪，只读启动检查通过', { readiness, probe: 'passed', setup });
      } catch (error) {
        const unsupported = /method not found|unknown (method|variant)|unsupported/i.test(error.message);
        return result(unsupported && !fault ? 'unknown' : 'blocked', unsupported && !fault ? '当前引擎不支持完整沙箱诊断，请更新 Codex 后重试' : '执行环境检查失败，请修复后重试',
          { readiness, detail: (fault || error.message).slice(0, 2000), repair: { available: !unsupported, action: 'setup', mode: 'elevated' }, setup });
      }
    })().then(value => {
      // 检查期间若出现新的运行故障，不让较早的成功结果覆盖它。
      if (version !== revision) return result('blocked', '检测期间执行环境发生变化，请重新检测', { detail: fault, setup });
      cache.set(key, { time: now(), value });
      if (cache.size > 32) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  function observe(event) {
    const p = event.params || {}, item = p.item;
    // 只识别引擎错误/失败命令/审批原因，不从用户目标或普通聊天中猜测故障。
    const detail = event.type === 'error' ? event.message : event.type === 'approval_required' ? p.reason
      : event.type === 'provider_event' && event.method === 'error' ? p.error?.message
      : event.type === 'provider_event' && event.method === 'item/completed' && item?.type === 'commandExecution' && item.exitCode !== 0 ? item.aggregatedOutput : '';
    if (sandboxFault(detail)) { fault = String(detail).slice(0, 2000); revision++; cache.clear(); onChange(); }
  }
  async function repair({ cwd } = {}) {
    if (platform !== 'win32') throw new Error('当前平台不需要 Windows 沙箱修复');
    if (setup?.status === 'running') return { ...setup };
    setup = { status: 'running', startedAt: new Date(now()).toISOString() }; revision++; cache.clear();
    onChange();
    let unsubscribe, timer;
    const finish = (status, error = '') => {
      clearTimeout(timer); unsubscribe?.();
      setup = { ...setup, status, error, endedAt: new Date(now()).toISOString() }; revision++; cache.clear();
      onChange();
    };
    try {
      const client = getClient(); await client.start();
      unsubscribe = client.on(event => {
        if (event.type === 'notification' && event.method === 'windowsSandbox/setupCompleted' && event.params?.mode === 'elevated') finish(event.params.success ? 'completed' : 'failed', event.params.error || '');
        if (event.type === 'provider_error') finish('failed', event.message);
      });
      timer = setTimeout(() => finish('failed', '初始化未在时限内返回结果，请检查 Codex 或系统提示后重新检测'), setupTimeout); timer.unref?.();
      const response = await client.request('windowsSandbox/setupStart', { cwd, mode: 'elevated' });
      if (!response.started && setup.status === 'running') finish('failed', '引擎未启动沙箱初始化');
    } catch (error) { finish('failed', error.message); }
    return { ...setup };
  }
  return { check, repair, observe };
}
module.exports = { createCodexDiagnostics, sandboxFault };
