const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { codexLaunch, spawnCodexAppServer } = require('./codex-process.cjs');
const { JsonRpcClient } = require('../agent-manager-server.cjs');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const special = path.join(cwd, '中文 & (cli) ! %TEST_EXPANSION% ^');
  fs.mkdirSync(special);
  const script = path.join(cwd, 'capture.cjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  // 用环境变量传递绝对路径，夹具本身也不依赖 shell 拼接路径或全局 PATH。
  const shim = path.join(special, 'codex.cmd');
  fs.writeFileSync(shim, '@echo off\r\n"%TEST_NODE%" "%TEST_CAPTURE%" %*\r\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'pathext'].includes(key.toLowerCase())));
  Object.assign(env, { PATH: special, PATHEXT: '.EXE;.CMD;.BAT;.COM', TEST_NODE: process.execPath, TEST_CAPTURE: script, TEST_EXPANSION: 'unexpected-expansion' });
  return { cwd, special, shim, env };
}

function result(child) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('Windows PATH 中的 cmd shim 支持空格、中文、shell 特殊字符且参数无变化', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  for (const command of ['codex', f.shim, `"${f.shim}"`]) {
    const child = spawnCodexAppServer(command, f);
    const actual = await result(child);
    assert.equal(actual.code, 0, actual.stderr);
    assert.deepEqual(JSON.parse(actual.stdout), ['app-server', '--stdio']);
  }
});

test('cmd 路径不会成为额外 shell 命令；不会执行路径中的百分号变量', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const command = path.join(f.cwd, 'codex & echo injected.cmd');
  fs.copyFileSync(f.shim, command);
  const actual = await result(spawnCodexAppServer(command, f));
  assert.equal(actual.code, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), ['app-server', '--stdio']);
  const launch = codexLaunch(command, f);
  assert.equal(launch.options.shell, false);
  assert.ok(!launch.args.at(-1).includes(command));
});

test('原生 exe 直接启动，非 Windows 继续使用独立参数；不允许 CODEX_BIN 命令片段', t => {
  if (process.platform === 'win32') {
    const f = fixture(t);
    const launch = codexLaunch(process.execPath, f);
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, ['app-server', '--stdio']);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.windowsVerbatimArguments, undefined);
    assert.throws(() => codexLaunch('codex.cmd & echo injected', f), /CODEX_BIN|找不到/);
    assert.throws(() => codexLaunch('codex\nextra', f), /CODEX_BIN/);
  }
  const launch = codexLaunch('/opt/codex cli', { cwd: '/tmp', env: {}, platform: 'linux' });
  assert.equal(launch.command, '/opt/codex cli');
  assert.deepEqual(launch.args, ['app-server', '--stdio']); assert.equal(launch.options.shell, false);
});

test('启用 throw-deprecation 后依然能运行 Windows shim', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const verifier = path.join(f.cwd, 'verify.cjs');
  fs.writeFileSync(verifier, `const {spawnCodexAppServer}=require(${JSON.stringify(path.join(__dirname, 'codex-process.cjs'))});\nconst child=spawnCodexAppServer('codex',{cwd:process.cwd(),env:process.env});\nchild.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on('error',error=>{console.error(error);process.exitCode=1;});child.on('close',code=>process.exitCode=code);`);
  const actual = await result(spawn(process.execPath, ['--throw-deprecation', verifier], { cwd: f.cwd, env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(actual.code, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), ['app-server', '--stdio']);
  assert.doesNotMatch(actual.stderr, /DEP0190|DeprecationWarning/);
});

test('无效 Codex 路径释放启动状态，重试不会一直复用失败的 Promise', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), previous = process.env.CODEX_BIN;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; });
  process.env.CODEX_BIN = path.join(f.cwd, 'missing.exe');
  const client = new JsonRpcClient(100);
  await assert.rejects(client.start(), /找不到/); assert.equal(client.starting, null);
  await assert.rejects(client.start(), /找不到/); assert.equal(client.starting, null);
});
