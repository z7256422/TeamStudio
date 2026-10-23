const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const buildPattern = /^Team-Studio-\d+\.\d+\.\d+-windows-x64-\d{8}T\d{6}Z$/;
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = message => { throw new Error(message); };

// 清理仅限 dist 直属、命名符合本项目规范的构建。拒绝 junction/symlink，不跟随到工作区外。
function checkedPath(root, relative) {
  const target = path.resolve(root, relative);
  const inside = path.relative(root, target);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) fail('清理目标不在 dist 内');
  let cursor = root;
  for (const part of inside.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(`保留链接路径：${relative}`);
  }
  return target;
}
function packageFiles(dist, name) {
  const folder = checkedPath(dist, name);
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = checkedPath(dist, path.relative(dist, path.join(directory, entry.name)));
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('构建目录含链接或特殊文件');
      if (entry.name === '.agent-manager') fail('包含运行数据 .agent-manager，保留整个目录');
      if (entry.isDirectory()) visit(file); else result.push(file);
    }
  }
  visit(folder);
  const packageDir = path.join(folder, 'Team Studio');
  const manifestFile = path.join(packageDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.name !== 'Team Studio' || !Array.isArray(manifest.files) || !manifest.files.length) fail('缺少有效的分发清单');
  const expected = new Set([manifestFile]);
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('分发清单无效');
    const file = checkedPath(dist, path.join(name, 'Team Studio', item.path));
    if (!file.startsWith(packageDir + path.sep) || expected.has(file)) fail('分发清单路径无效');
    if (!fs.statSync(file).isFile() || sha256(file) !== item.sha256) fail('含修改过的程序文件，保留目录');
    expected.add(file);
  }
  if (result.length !== expected.size || result.some(file => !expected.has(file))) fail('包含分发清单外的文件，保留目录');
  return result;
}
function verifyArchive(dist, name) {
  const archive = checkedPath(dist, name + '.zip');
  const checksum = checkedPath(dist, name + '.zip.sha256');
  const contents = fs.readFileSync(checksum, 'utf8').trim();
  if (contents !== `${sha256(archive)}  ${name}.zip`) fail('ZIP 校验值不匹配');
  return [archive, checksum];
}
function cleanPackages({ dist = path.resolve(__dirname, '../dist'), keep, dryRun = false } = {}) {
  dist = path.resolve(dist);
  if (!fs.existsSync(dist)) return { kept: null, removed: [], preserved: [] };
  if (fs.lstatSync(dist).isSymbolicLink() || path.resolve(fs.realpathSync(dist)).toLowerCase() !== dist.toLowerCase()) fail('dist 或其父级是链接，取消清理');
  const names = fs.readdirSync(dist).filter(name => buildPattern.test(name)).sort((a, b) => b.slice(-16).localeCompare(a.slice(-16)));
  keep ||= names[0];
  if (!keep || !buildPattern.test(keep)) fail('找不到要保留的新构建；未清理任何旧版本');
  // 新 ZIP 和目录必须完整有效。打包流程还会在调用前完成启动烟测。
  verifyArchive(dist, keep); packageFiles(dist, keep);
  const candidates = new Set(fs.readdirSync(dist).map(name => name.replace(/\.zip(?:\.sha256)?$/, '')).filter(name => buildPattern.test(name) && name !== keep && name.slice(-16) < keep.slice(-16)));
  const report = { kept: keep, dryRun, removed: [], preserved: [] };
  for (const name of candidates) {
    const folder = checkedPath(dist, name);
    if (fs.existsSync(folder)) {
      try {
        const files = packageFiles(dist, name);
        if (!dryRun) {
          // 使用已核验的逐文件删除和空目录回收，不递归删除任何计算路径。
          for (const file of files) fs.unlinkSync(checkedPath(dist, path.relative(dist, file)));
          const removeEmpty = directory => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
              if (!entry.isDirectory() || entry.isSymbolicLink()) fail('清理期间目录发生变化，停止回收');
              removeEmpty(checkedPath(dist, path.relative(dist, path.join(directory, entry.name))));
            }
            fs.rmdirSync(directory);
          };
          removeEmpty(folder);
        }
        report.removed.push(name);
      } catch (error) { report.preserved.push({ path: name, reason: error.message }); }
    }
    if (!fs.existsSync(path.join(dist, name + '.zip')) && !fs.existsSync(path.join(dist, name + '.zip.sha256'))) continue;
    try {
      const files = verifyArchive(dist, name);
      if (!dryRun) for (const file of files) fs.unlinkSync(checkedPath(dist, path.relative(dist, file)));
      report.removed.push(name + '.zip', name + '.zip.sha256');
    } catch (error) { report.preserved.push({ path: name + '.zip', reason: error.message }); }
  }
  return report;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--dry-run', '--keep'].includes(arg) && !buildPattern.test(arg))) fail('用法：node work/clean-packages.cjs [--dry-run] [--keep 构建名称]');
    if (args.includes('--keep') && !buildPattern.test(args[args.indexOf('--keep') + 1] || '')) fail('--keep 后需要有效构建名称');
    console.log(JSON.stringify(cleanPackages({ dryRun: args.includes('--dry-run'), keep: args.includes('--keep') ? args[args.indexOf('--keep') + 1] : undefined }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { cleanPackages };
