const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cleanPackages } = require('./clean-packages.cjs');
const { runtimeFiles } = require('./packaging/runtime-files.cjs');

const root = path.resolve(__dirname, '..');
const templates = path.join(__dirname, 'packaging');
const { version } = require('./server/app-info.cjs');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} 执行失败：${result.status}`);
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  return response.text();
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('请使用 Windows x64 的 Node.js 24+ 执行打包。');
  }
  // 将使用的运行时与官方校验值核对，并保留对应版本的完整组件许可证。
  const [license, checksums] = await Promise.all([
    download(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`),
    download(`https://nodejs.org/dist/${process.version}/SHASUMS256.txt`)
  ]);
  const expected = checksums.split(/\r?\n/).find(line => line.endsWith('  win-x64/node.exe'))?.split(/\s+/)[0];
  const binary = fs.readFileSync(process.execPath);
  if (!expected || sha256(binary) !== expected) throw new Error('本机 Node 与对应版本官方校验值不匹配，已取消打包。');
  if (!license.includes('Node.js') || !license.includes('Permission is hereby granted')) throw new Error('Node 许可证内容异常，已取消打包。');
  // 发布产物必须通过全部回归，包含真实 Codex 传输（模型由本机夹具提供，不计费）。
  run(process.execPath, [path.join(__dirname, 'test.cjs')], { env: { ...process.env, REQUIRE_CODEX_TEST: '1' } });
  run(process.execPath, [path.join(__dirname, 'build-panel.cjs')]);
  run(process.execPath, [path.join(__dirname, 'export-company.cjs')]);

  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const buildName = `Team-Studio-${version}-windows-x64-${stamp}`;
  // 先生成独立目录并完成校验；只有新包可用时才清理旧分发，保留运行数据。
  const buildDir = path.join(dist, buildName);
  fs.mkdirSync(buildDir);
  const packageDir = path.join(buildDir, 'Team Studio');
  fs.mkdirSync(packageDir);
  const records = [];
  function write(relative, contents) {
    const output = path.join(packageDir, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, contents);
    records.push({ path: relative.replaceAll('\\', '/'), bytes: Buffer.byteLength(contents), sha256: sha256(contents) });
  }
  function copy(relative) { write(relative, fs.readFileSync(path.join(root, relative))); }
  // 分发采用白名单，不遍历用户工作区、历史数据库、凭据、测试输出与截图。
  for (const file of runtimeFiles(root))
  {
    copy(file);
  }
  for (const file of ['launcher.cjs', 'README.txt', 'Start.cmd', 'Stop.cmd']) {
    const contents = Buffer.from(fs.readFileSync(path.join(templates, file), 'utf8').replaceAll('{{VERSION}}', version), 'utf8');
    write(file, file.endsWith('.cmd') ? Buffer.from(contents.toString('utf8').replace(/\r?\n/g, '\r\n')) : contents);
  }
  write('runtime/node.exe', binary);
  write('runtime/NODE-LICENSE.txt', Buffer.from(license, 'utf8'));
  fs.writeFileSync(path.join(packageDir, 'manifest.json'), JSON.stringify({
    name: 'Team Studio', version, platform: 'win32', arch: 'x64',
    builtAt: new Date().toISOString(), nodeVersion: process.version,
    nodeSource: `https://nodejs.org/dist/${process.version}/win-x64/node.exe`,
    files: records.sort((a, b) => a.path.localeCompare(b.path))
  }, null, 2) + '\n');

  const archive = path.join(dist, `${buildName}.zip`);
  // 路径通过环境变量传递，不将包含空格、中文或 shell 字符的路径拼进命令。
  // CreateFromDirectory 在 Windows 上会写入反斜杠条目；手动创建条目，保证
  // ZIP 规范要求的正斜杠，便于 Linux/macOS/第三方解压工具读取。
  const zipCommand = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = (Resolve-Path $env:TEAM_STUDIO_PACKAGE_INPUT).Path
$archive = [System.IO.Compression.ZipFile]::Open($env:TEAM_STUDIO_PACKAGE_ZIP, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $source -File -Recurse | ForEach-Object {
    $name = $_.FullName.Substring($source.Length)
    $name = $name.TrimStart([char]92, [char]47)
    $name = $name.Replace([string][char]92, '/')
    $entry = $archive.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
    $input = [System.IO.File]::OpenRead($_.FullName)
    try {
      $output = $entry.Open()
      try { $input.CopyTo($output) } finally { $output.Dispose() }
    } finally { $input.Dispose() }
  }
} finally { $archive.Dispose() }
`;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', zipCommand], {
    env: { ...process.env, TEAM_STUDIO_PACKAGE_INPUT: buildDir, TEAM_STUDIO_PACKAGE_ZIP: archive }
  });
  const archiveHash = sha256(fs.readFileSync(archive));
  fs.writeFileSync(`${archive}.sha256`, `${archiveHash}  ${path.basename(archive)}\n`);
  run(process.execPath, [path.join(templates, 'smoke-test.cjs'), archive]);
  const cleanup = cleanPackages({ dist, keep: buildName });
  console.log('旧版本清理：' + JSON.stringify(cleanup, null, 2));
  console.log(JSON.stringify({ archive, sha256: archiveHash, bytes: fs.statSync(archive).size, packageDir }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
