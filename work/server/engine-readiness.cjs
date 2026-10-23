// 安装/启动及认证独立于 Windows 沙箱。不发送模型请求，也不暴露账户资料。
function createEngineReadiness({ getClient, onChange = () => {}, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  const current = key => cache.get(key)?.result || { status: 'unknown', summary: '尚未检测引擎与认证', checkedAt: null };
  async function check(key = 'codex-app-server', { force = false, execution = null } = {}) {
    if (!force && cache.has(key) && now() - cache.get(key).time < 30000) return current(key);
    if (pending.has(key)) return pending.get(key);
    const promise = (async () => {
      let result;
      try {
        const client = getClient(key, execution); await client.start();
        if (execution) result = { status: 'ready', summary: '本机引擎可启动；自定义模型连通性需使用连接测试确认', authentication: 'custom-provider', modelConnectivity: 'unverified' };
        else {
          const account = await client.request('account/read', { refreshToken: false });
          if (!account || typeof account.requiresOpenaiAuth !== 'boolean') result = { status: 'unknown', summary: '引擎已连接，但未返回可识别的认证状态' };
          else if (account.requiresOpenaiAuth && !account.account) result = { status: 'blocked', summary: 'Codex 尚未登录，请先在本机完成登录', authentication: 'required' };
          else result = { status: 'ready', summary: '引擎连接与本机认证检查通过；模型请求可用性以实际执行为准', authentication: account.requiresOpenaiAuth ? 'configured' : 'not-required', modelConnectivity: 'unverified' };
        }
      } catch (error) {
        result = { status: 'blocked', summary: /ENOENT|not found|找不到|无法识别/.test(error.message) ? '未找到或无法启动 Codex，请检查安装与 CODEX_BIN' : '无法连接或检查 Codex 引擎，请查看本机配置' };
      }
      result = { ...result, checkedAt: new Date(now()).toISOString(), repair: { available: false }, category: 'engine' };
      cache.set(key, { time: now(), result }); onChange(); return result;
    })().finally(() => pending.delete(key));
    pending.set(key, promise); return promise;
  }
  return { check, current, invalidate: key => { cache.delete(key); onChange(); } };
}
module.exports = { createEngineReadiness };
