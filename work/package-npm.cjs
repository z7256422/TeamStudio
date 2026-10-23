const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { runtimeFiles } = require('./packaging/runtime-files.cjs');

const projectRoot = path.resolve(__dirname, '..');
const packageName = '@z7256422/team-studio';

function createNpmPackage({ root = projectRoot, destination })
{
    if (!destination)
    {
        throw new Error('必须指定独立的 npm 包暂存目录。');
    }
    destination = path.resolve(destination);
    if (fs.existsSync(destination) && fs.readdirSync(destination).length)
    {
        throw new Error('npm 包暂存目录必须为空，避免混入上次构建或用户数据。');
    }
    fs.mkdirSync(destination, { recursive: true });

    const { version } = require(path.join(root, 'work/server/app-info.cjs'));
    if (!/^\d+\.\d+\.\d+$/.test(version))
    {
        throw new Error('发布版本必须使用 x.y.z 格式。');
    }
    const copy = (source, target) =>
    {
        if (!fs.lstatSync(source).isFile())
        {
            throw new Error('分发文件必须是普通文件，不能包含目录或符号链接。');
        }
        const output = path.join(destination, target);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.copyFileSync(source, output);
    };
    for (const relative of runtimeFiles(root))
    {
        copy(path.join(root, relative), relative);
    }
    copy(path.join(__dirname, 'packaging/launcher.cjs'), 'launcher.cjs');
    copy(path.join(__dirname, 'packaging/npm-entry.cjs'), 'bin/team-studio.cjs');
    fs.chmodSync(path.join(destination, 'bin/team-studio.cjs'), 0o755);
    const readme = fs.readFileSync(path.join(__dirname, 'packaging/npm-README.md'), 'utf8').replaceAll('{{VERSION}}', version);
    fs.writeFileSync(path.join(destination, 'README.md'), readme, 'utf8');
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
        name: packageName,
        version,
        description: '基于本机 Codex 的多团队协作面板，支持派发、反馈、审批与历史续聊。',
        license: 'UNLICENSED',
        homepage: 'https://github.com/z7256422/TeamStudio#readme',
        repository: { type: 'git', url: 'git+https://github.com/z7256422/TeamStudio.git' },
        bugs: { url: 'https://github.com/z7256422/TeamStudio/issues' },
        bin: { 'team-studio': 'bin/team-studio.cjs' },
        engines: { node: '>=24' },
        os: ['win32'],
        cpu: ['x64'],
        files: ['bin/', 'launcher.cjs', 'work/', 'outputs/'],
        publishConfig: { registry: 'https://npm.pkg.github.com', access: 'public' }
    }, null, 2) + '\n', 'utf8');

    return { version, directory: destination };
}

function main()
{
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !fs.existsSync(npmCli))
    {
        throw new Error('请使用 npm run package:npm 构建安装包。');
    }
    const output = path.join(projectRoot, 'dist/npm');
    fs.mkdirSync(output, { recursive: true });
    // 每次使用全新目录，不清理或复用可能已包含用户数据的旧目录。
    const stage = fs.mkdtempSync(path.join(output, 'package-'));
    const result = createNpmPackage({ destination: stage });
    const packed = spawnSync(process.execPath, [npmCli, 'pack', stage, '--ignore-scripts', '--pack-destination', output, '--json'], {
        cwd: projectRoot, encoding: 'utf8', windowsHide: true
    });
    if (packed.error)
    {
        throw packed.error;
    }
    if (packed.status !== 0)
    {
        throw new Error(packed.stderr || 'npm pack 失败。');
    }
    // npm 12 按包名返回对象；兼容旧版 npm 的数组结果。
    const report = JSON.parse(packed.stdout);
    const records = Array.isArray(report) ? report : report.filename ? [report] : Object.values(report);
    if (records.length !== 1 || typeof records[0]?.filename !== 'string'
        || path.basename(records[0].filename) !== records[0].filename)
    {
        throw new Error('npm pack 未返回唯一的安装包文件名。');
    }
    const [record] = records;
    const tarball = path.join(output, record.filename);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    fs.writeFileSync(`${tarball}.sha256`, `${sha256}  ${record.filename}\n`, 'utf8');
    console.log(JSON.stringify({ ...result, tarball, sha256, files: record.entryCount ?? record.files?.length }, null, 2));
}

if (require.main === module)
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { createNpmPackage };
