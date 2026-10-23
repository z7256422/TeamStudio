const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { fork, spawn } = require('node:child_process');

const root = __dirname;
const stateDir = path.join(root, '.agent-manager');
const stateFile = path.join(stateDir, 'launcher.json');
const identity = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24);
const pipeName = `\\\\.\\pipe\\team-studio-${identity}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 本地命名管道负责单实例和关闭；随机凭据避免其他本地程序误发停止命令。
function request(action) {
  return new Promise((resolve, reject) => {
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (error) { reject(error); return; }
    const socket = net.connect(pipeName);
    let data = '';
    socket.setTimeout(15000, () => socket.destroy(new Error('控制请求超时。')));
    socket.once('connect', () => socket.write(JSON.stringify({ action, token: state.token }) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 16384) socket.destroy(new Error('控制响应过大。'));
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const response = JSON.parse(data);
        if (!response.ok) throw new Error(response.error || '控制请求失败。');
        resolve(response);
      } catch (error) { reject(error); }
    });
  });
}

function openBrowser(url) {
  if (process.env.TEAM_STUDIO_NO_BROWSER === '1') return;
  // URL 仅由固定回环地址和已校验的数字端口组成，不插入目录或用户文本。
  const browser = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' });
  browser.once('error', error => console.error(`无法自动打开浏览器，请手动访问 ${url}：${error.message}`));
  browser.unref();
}

async function start() {
  try {
    const active = await request('status');
    console.log(`Team Studio 已启动：${active.url}`);
    openBrowser(active.url);
    return;
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  const port = Number(process.env.AGENT_MANAGER_PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AGENT_MANAGER_PORT 必须是 1 至 65535 的整数。');
  const url = `http://127.0.0.1:${port}`;
  const token = crypto.randomBytes(32).toString('hex');
  let child, stopping = false, phase = 'starting', exited;
  const control = net.createServer(socket => {
    let input = '';
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', error => { if (error.code !== 'ECONNRESET') console.error(`控制连接失败：${error.message}`); });
    socket.on('data', async chunk => {
      input += chunk;
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      const reply = data => { if (!socket.destroyed) socket.end(JSON.stringify(data)); };
      try {
        const message = JSON.parse(input);
        if (message.token !== token) throw new Error('控制凭据不匹配。');
        if (message.action === 'status') return reply({ ok: true, url, phase });
        if (message.action !== 'stop') throw new Error('未知控制操作。');
        socket.setTimeout(15000);
        await stop();
        reply({ ok: true, stopped: true });
      } catch (error) { reply({ ok: false, error: error.message }); }
    });
  });
  const stop = async () => {
    if (!stopping) {
      stopping = true; phase = 'stopping';
      if (child?.connected) child.send({ type: 'team-studio:shutdown' }, error => { if (error) console.error(`发送停止请求失败：${error.message}`); });
    }
    if (exited) await exited;
  };
  // listen 本身是原子的；不会依赖 PID 文件杀进程，也不会误关别的 Node 服务。
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(pipeName, resolve);
  }).catch(error => {
    if (error.code === 'EADDRINUSE') throw new Error('此目录中的 Team Studio 正在启动或运行，请稍后再试。');
    throw error;
  });
  try {
    // 提前检测占用，避免误把其他服务的健康接口当作本次启动成功。
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请先关闭原服务或设置 AGENT_MANAGER_PORT。` : error.message)));
      probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ token, url }), { mode: 0o600 });
    const env = { ...process.env, AGENT_MANAGER_HOST: '127.0.0.1', AGENT_MANAGER_PORT: String(port) };
    // 让 npm 安装的 Codex shim 也能找到包内 Node，无需另装全局 Node。
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
    child = fork(path.join(root, 'work/agent-manager-server.cjs'), [], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务启动超过 15 秒，请查看窗口中的错误信息。')), 15000);
      const ready = message => { if (message?.type === 'team-studio:ready') { clearTimeout(timer); resolve(); } };
      child.on('message', ready);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`服务启动失败，退出码 ${code}。`)); });
    });
    phase = 'running';
    const onSignal = () => { void stop(); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    console.log(`\nTeam Studio 已启动：${url}\n请保留此窗口。按 Ctrl+C 或双击 Stop.cmd 停止服务。\n`);
    openBrowser(url);
    const result = await exited;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (result.code !== 0) throw new Error(`服务已退出（${result.code ?? result.signal}）。请查看上面的错误信息。`);
    console.log('Team Studio 已停止，运行记录已保存。');
  } finally {
    await stop();
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.token === token) fs.unlinkSync(stateFile);
    }
    // 给停止请求的响应留出发送时间，再关闭控制通道。
    await delay(50);
    await new Promise(resolve => control.close(resolve));
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('此便携包适用于 Windows。');
  const action = process.argv[2] || 'start';
  if (action === 'start') return start();
  if (!['stop', 'status'].includes(action)) throw new Error('用法：launcher.cjs start|stop|status');
  try {
    const response = await request(action);
    console.log(action === 'stop' ? 'Team Studio 已停止。' : JSON.stringify(response));
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code) && action === 'stop') console.log('此目录中的 Team Studio 当前没有运行。');
    else throw error;
  }
}
main().catch(error => { console.error(`\n${error.message}`); process.exitCode = 1; });
