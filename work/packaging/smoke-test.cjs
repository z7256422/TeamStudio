// 对实际 ZIP 做离线冒烟测试，不调用真实 Codex，也不修改项目历史。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const archive = path.resolve(process.argv[2] || '');
  assert.ok(fs.statSync(archive).isFile(), '请提供生成的 ZIP 路径');
  const zipEntries = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead($env:TEAM_STUDIO_TEST_ZIP); try { $bad = @($zip.Entries | Where-Object { $_.FullName.Contains('\\') }); if ($bad.Count) { throw ('ZIP 条目使用反斜杠：' + ($bad -join ', ')) } } finally { $zip.Dispose() }"], { windowsHide: true, encoding: 'utf8', env: { ...process.env, TEAM_STUDIO_TEST_ZIP: archive } });
  assert.equal(zipEntries.status, 0, zipEntries.stderr || zipEntries.stdout);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'Team Studio 中文 & (smoke)-'));
  const extract = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:TEAM_STUDIO_TEST_ZIP, $env:TEAM_STUDIO_TEST_DEST)"], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, TEAM_STUDIO_TEST_ZIP: archive, TEAM_STUDIO_TEST_DEST: scratch }
  });
  assert.equal(extract.status, 0, extract.stderr);
  const directory = path.join(scratch, 'Team Studio');
  const node = path.join(directory, 'runtime/node.exe');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const record of manifest.files) {
    assert.ok(!record.path.split('/').includes('..'));
    const contents = fs.readFileSync(path.join(directory, record.path));
    assert.equal(contents.length, record.bytes);
    assert.equal(crypto.createHash('sha256').update(contents).digest('hex'), record.sha256, record.path);
  }
  const actualFiles = fs.readdirSync(directory, { recursive: true }).filter(file => fs.statSync(path.join(directory, file)).isFile());
  assert.equal(actualFiles.length, manifest.files.length + 1, '包内只有清单文件和 manifest');
  assert.ok(!fs.existsSync(path.join(directory, '.agent-manager')), '没有开发机历史');
  console.log(`PASS 解压至中文/空格/特殊字符路径，${actualFiles.length} 个文件通过 SHA-256 核验`);

  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  const env = { ...process.env, AGENT_MANAGER_PORT: String(port), TEAM_STUDIO_NO_BROWSER: '1' };
  delete env.AGENT_MANAGER_DATA_DIR;
  const launch = (command, args) => {
    const child = spawn(command, args, { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve({ code, output }));
    });
    return { child, done, output: () => output };
  };
  const timed = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试等待超过 20 秒')), 20000); })]); }
    finally { clearTimeout(timer); }
  };
  const command = action => launch(node, ['launcher.cjs', action]);
  const batch = name => {
    env.TEAM_STUDIO_TEST_BATCH = path.join(directory, name);
    return launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:TEAM_STUDIO_TEST_BATCH; exit $LASTEXITCODE']);
  };
  const base = `http://127.0.0.1:${port}`;
  let running;
  try {
    const occupied = await timed(command('start').done);
    assert.equal(occupied.code, 1, occupied.output);
    assert.match(occupied.output, /已被占用/);
    assert.ok(!fs.existsSync(path.join(directory, '.agent-manager/runs.sqlite')));
    console.log('PASS 端口占用时明确失败，未生成历史数据库');
    await new Promise(resolve => blocker.close(resolve));

    running = batch('Start.cmd');
    let health;
    for (let i = 0; i < 80; i++) {
      assert.equal(running.child.exitCode, null, running.output());
      try { health = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(300) })).json(); break; }
      catch { await delay(100); }
    }
    assert.equal(health?.service, 'agent-manager', running.output());
    assert.equal(health.ok, true);
    assert.equal(health.version, manifest.version, '服务版本应与分发清单一致');
    const html = await (await fetch(base)).text();
    assert.match(html, /Team Studio/);
    assert.ok(html.length > 100000);
    assert.deepEqual((await (await fetch(`${base}/api/conversations`)).json()).data, []);
    const diagnostic = (await (await fetch(`${base}/api/providers/codex-app-server/diagnostics`)).json()).data;
    assert.equal(diagnostic.status, 'notApplicable');
    assert.equal(diagnostic.sandbox, 'danger-full-access');
    assert.equal(diagnostic.repair.available, false);
    console.log('PASS 双击入口对应的 Start.cmd 可启动，首页、健康接口、空历史正常');
    console.log('PASS 默认无沙箱诊断，无需启动 Codex 或修复 Windows 账户');

    // 在解压后的中文/空格目录中验证凭据辅助脚本确实入包且可运行，不请求外部模型。
    const providerResponse = await fetch(`${base}/api/providers/custom`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Package test', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'package-test', apiKey: 'package-only-fake-key' }) });
    assert.equal(providerResponse.status, 200);
    const provider = (await providerResponse.json()).data;
    assert.equal(provider.hasApiKey, true);
    assert.ok(!JSON.stringify(provider).includes('package-only-fake-key'));
    const providerFile = fs.readFileSync(path.join(directory, '.agent-manager/providers.json'), 'utf8');
    assert.match(providerFile, /dpapi:/); assert.ok(!providerFile.includes('package-only-fake-key'));
    assert.equal((await fetch(`${base}/api/providers/custom/${provider.id}`, { method: 'DELETE' })).status, 200);
    console.log('PASS 自定义连接接口、Windows 密钥加密及包内辅助脚本正常');

    const duplicate = await timed(batch('Start.cmd').done);
    assert.equal(duplicate.code, 0, duplicate.output);
    assert.match(duplicate.output, /已启动/);
    const status = await timed(command('status').done);
    assert.equal(JSON.parse(status.output).phase, 'running');
    console.log('PASS 重复启动复用本目录服务');

    // 空消息流不会立即发送响应头；保留连接来检查停服，而不等待首条消息。
    const streamAbort = new AbortController();
    const eventStream = fetch(`${base}/api/messages/stream`, { signal: streamAbort.signal }).catch(() => null);
    await delay(150);
    const stopped = await timed(batch('Stop.cmd').done);
    assert.equal(stopped.code, 0, stopped.output);
    const completed = await timed(running.done);
    assert.equal(completed.code, 0, completed.output);
    streamAbort.abort();
    await eventStream;
    assert.ok(!fs.existsSync(path.join(directory, '.agent-manager/launcher.json')));
    const db = new DatabaseSync(path.join(directory, '.agent-manager/runs.sqlite'));
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
    await assert.rejects(fetch(`${base}/api/health`, { signal: AbortSignal.timeout(600) }));
    console.log('PASS SSE 保持连接时 Stop.cmd 正常退出，数据库完整，端口已释放');

    const stoppedAgain = await timed(batch('Stop.cmd').done);
    assert.equal(stoppedAgain.code, 0, stoppedAgain.output);
    assert.match(stoppedAgain.output, /当前没有运行/);
    console.log('PASS 重复停止安全返回');
    console.log(`验证目录：${directory}`);
  } finally {
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
    if (running && running.child.exitCode === null) await timed(command('stop').done);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
