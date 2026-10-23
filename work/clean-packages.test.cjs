const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanPackages } = require('./clean-packages.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const old = 'Team-Studio-0.10.1-windows-x64-20260922T010000Z', fresh = 'Team-Studio-0.11.0-windows-x64-20260922T020000Z';
function fixture(t) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-package-'));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  for (const name of [old, fresh]) {
    const folder = path.join(dist, name, 'Team Studio'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'app.cjs'), 'example');
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ name: 'Team Studio', files: [{ path: 'app.cjs', sha256: hash('example') }] }));
    fs.writeFileSync(path.join(dist, name + '.zip'), 'zipfixture');
    fs.writeFileSync(path.join(dist, name + '.zip.sha256'), `${hash('zipfixture')}  ${name}.zip\n`);
  }
  return dist;
}
test('只在新包校验有效后删除旧包，dry-run 不产生修改', t => {
  const dist = fixture(t);
  assert.equal(cleanPackages({ dist, keep: fresh, dryRun: true }).removed.length, 3);
  assert.ok(fs.existsSync(path.join(dist, old)));
  fs.writeFileSync(path.join(dist, fresh + '.zip'), 'broken');
  assert.throws(() => cleanPackages({ dist, keep: fresh }), /校验值/);
  assert.ok(fs.existsSync(path.join(dist, old + '.zip')));
  fs.writeFileSync(path.join(dist, fresh + '.zip'), 'zipfixture');
  assert.equal(cleanPackages({ dist, keep: fresh }).removed.length, 3);
  assert.ok(fs.existsSync(path.join(dist, fresh))); assert.ok(!fs.existsSync(path.join(dist, old)));
});
test('保留运行数据、额外文件和被修改的程序目录；无关文件不动', t => {
  const dist = fixture(t), folder = path.join(dist, old, 'Team Studio');
  fs.mkdirSync(path.join(folder, '.agent-manager')); fs.writeFileSync(path.join(folder, '.agent-manager/runs.sqlite'), 'user data');
  fs.writeFileSync(path.join(dist, 'notes.txt'), 'notes');
  const result = cleanPackages({ dist, keep: fresh });
  assert.match(result.preserved[0].reason, /运行数据/);
  assert.equal(fs.readFileSync(path.join(folder, '.agent-manager/runs.sqlite'), 'utf8'), 'user data');
  assert.ok(!fs.existsSync(path.join(dist, old + '.zip'))); assert.ok(fs.existsSync(path.join(dist, 'notes.txt')));
});
test('拒绝越界 keep 和清单路径，不触碰链接目标', t => {
  const dist = fixture(t);
  assert.throws(() => cleanPackages({ dist, keep: '../outside' }), /新构建/);
  const manifest = path.join(dist, old, 'Team Studio/manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'Team Studio', files: [{ path: '../../../outside.txt', sha256: hash('example') }] }));
  const result = cleanPackages({ dist, keep: fresh });
  assert.equal(result.preserved[0].path, old); assert.ok(fs.existsSync(manifest));
});
test('有用户修改或额外文件的旧目录不删除', t => {
  const dist = fixture(t), folder = path.join(dist, old, 'Team Studio');
  fs.writeFileSync(path.join(folder, 'app.cjs'), 'user changes');
  assert.match(cleanPackages({ dist, keep: fresh }).preserved[0].reason, /修改过/);
  assert.equal(fs.readFileSync(path.join(folder, 'app.cjs'), 'utf8'), 'user changes');
  fs.writeFileSync(path.join(folder, 'app.cjs'), 'example');
  fs.writeFileSync(path.join(folder, 'user.txt'), 'keep');
  assert.match(cleanPackages({ dist, keep: fresh }).preserved[0].reason, /清单外/);
  assert.ok(fs.existsSync(path.join(folder, 'user.txt')));
});
test('旧目录内的 junction 不会遍历和删除外部目录', t => {
  const dist = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'package-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'user.txt'), 'safe');
  fs.symlinkSync(outside, path.join(dist, old, 'Team Studio', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = cleanPackages({ dist, keep: fresh });
  assert.match(result.preserved[0].reason, /链接/);
  assert.equal(fs.readFileSync(path.join(outside, 'user.txt'), 'utf8'), 'safe');
});
