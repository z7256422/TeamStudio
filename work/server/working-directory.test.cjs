const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { resolveWorkingDirectory, WorkingDirectoryError } = require('./working-directory.cjs');
const { route, runs, sessions, JsonRpcClient } = require('../agent-manager-server.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-cwd-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, '中文 项目 & tools');
  fs.mkdirSync(folder);
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'fixture');
  return { root, folder, file, missing: path.join(root, '迁移前的项目') };
}

test('工作目录规范化支持空白、相对路径和复制的中文带引号路径', t => {
  const { root, folder } = fixture(t);
  for (const input of [undefined, null, '', '  ']) assert.equal(resolveWorkingDirectory(input, root), root);
  for (const input of [folder, `  ${folder}  `, ` "${folder}" `, `'${folder}'`, path.basename(folder)]) {
    assert.equal(resolveWorkingDirectory(input, root), folder);
  }
});

test('目录不存在或指向文件时不回退、不创建；非法输入在访问文件系统前失败', t => {
  const { root, missing, file } = fixture(t);
  for (const input of [false, 123, {}, [], 'a'.repeat(401), 'bad\0path']) {
    assert.throws(() => resolveWorkingDirectory(input, root), error => error instanceof WorkingDirectoryError && error.code === 'invalid_working_directory');
  }
  assert.throws(() => resolveWorkingDirectory(missing, root), error => error.code === 'working_directory_missing' && error.cwd === missing && error.message.includes(missing));
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => resolveWorkingDirectory(file, root), error => error.code === 'working_directory_not_folder' && error.statusCode === 400);
});

test('目录读取失败保留明确的权限或系统错误分类', t => {
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const mock = t.mock.method(fs, 'statSync', () => { throw Object.assign(new Error('fixture failure'), { code }); });
    assert.throws(() => resolveWorkingDirectory('project', os.tmpdir()), error => error.code === (code === 'EIO' ? 'working_directory_unavailable' : 'working_directory_denied') && error.cwd === path.join(os.tmpdir(), 'project'));
    mock.mock.restore();
  }
});

test('诊断与启动接口一致校验目录，无沙箱也报告目录故障且不启动引擎、不生成历史', async t => {
  const { folder, missing, file } = fixture(t);
  const engine = t.mock.method(JsonRpcClient.prototype, 'start', () => { throw new Error('不应启动引擎'); });
  const server = http.createServer(route);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); runs.clear(); sessions.clear(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const sandbox of ['danger-full-access', 'workspace-write', 'read-only']) {
    const response = await fetch(`${base}/api/providers/codex-app-server/diagnostics?cwd=${encodeURIComponent(missing)}&sandbox=${sandbox}`);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.status, 'blocked'); assert.equal(data.category, 'working-directory');
    assert.equal(data.code, 'working_directory_missing'); assert.equal(data.cwd, missing);
    assert.equal(data.repair.available, false); assert.match(data.summary, /不存在/);
  }
  for (const [cwd, code, status] of [[missing, 'working_directory_missing', 404], [file, 'working_directory_not_folder', 400], [123, 'invalid_working_directory', 400]]) {
    for (const [url, body] of [['/api/runs', { agentId: 'pm', goal: '检查目录', cwd }], ['/api/providers/codex-app-server/repair', { action: 'setup', cwd }]]) {
      const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    }
  }
  const corrected = await fetch(`${base}/api/providers/codex-app-server/diagnostics?cwd=${encodeURIComponent(` "${folder}" `)}&sandbox=danger-full-access`);
  const { data } = await corrected.json();
  assert.equal(data.status, 'notApplicable'); assert.equal(data.cwd, folder);
  assert.equal(data.category, undefined); assert.equal(engine.mock.callCount(), 0);
  assert.equal(sessions.size, 0); assert.equal(runs.size, 0);
});

test('前端检测与派发目录按任务、成员、团队优先级选择，忽略空白配置', () => {
  const context = vm.createContext({});
  for (const file of ['config/capabilities.js', 'runtime/team-management.js'])
  {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../panel-src', file), 'utf8'), context);
  }
  const choose = context.effectiveWorkingDirectory;
  assert.equal(choose(' task ', 'member', 'team'), 'task');
  assert.equal(choose(' ', ' member ', 'team'), 'member');
  assert.equal(choose('', ' ', ' team '), 'team');
  assert.equal(choose(undefined, null, ''), '');
  const snapshot = context.teamManagementSnapshot({ cwd: ' team ' }, [{ id: 'dev', cwd: ' ' }], ' ');
  assert.equal(snapshot.members[0].cwd, 'team');
});
