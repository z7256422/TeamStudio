const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createNpmPackage } = require('../package-npm.cjs');
const { version } = require('../server/app-info.cjs');

function temporaryDirectory(t)
{
    const prefix = path.join(os.tmpdir(), 'team-studio-npm-');
    const directory = fs.mkdtempSync(prefix);
    t.after(() =>
    {
        assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

test('npm 分发只复制运行白名单，排除凭据、个人配置、测试与本地记录', t =>
{
    const directory = temporaryDirectory(t);
    const root = path.join(directory, 'source');
    const inputs = {
        'work/agent-manager-server.cjs': '// runtime',
        'work/server/app-info.cjs': "module.exports = { version: '1.2.3' };",
        'work/server/module.cjs': '// runtime',
        'work/server/provider-secrets.ps1': '# runtime',
        '.agent-manager/providers.json': 'personal-fixture-value',
        '.env': 'personal-fixture-value',
        '.npmrc': 'personal-fixture-value',
        'MIGRATION.md': 'personal-fixture-value',
        'work/server/providers.json': 'personal-fixture-value',
        'work/server/config.local.cjs': 'personal-fixture-value',
        'work/server/module.test.cjs': 'personal-fixture-value',
        'work/shared/run-activity.js': '// runtime',
        'work/shared/run-progress.js': '// runtime',
        'work/shared/run-reasoning.js': '// runtime',
        'work/shared/model-reasoning.js': '// runtime',
        'outputs/agent-manager.html': '<html>fixture</html>',
        'outputs/product-company.json': '{}',
        'outputs/product-company-prompts.md': '# Template',
        'outputs/THIRD_PARTY_LICENSES.txt': 'Third-party licenses'
    };
    for (const [relative, contents] of Object.entries(inputs))
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }
    const destination = path.join(directory, 'package');
    const result = createNpmPackage({ root, destination });
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
    assert.equal(result.version, '1.2.3');
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.name, '@z7256422/team-studio');
    assert.equal(manifest.publishConfig.registry, 'https://npm.pkg.github.com');
    for (const relative of fs.readdirSync(destination, { recursive: true }))
    {
        const file = path.join(destination, relative);
        if (fs.statSync(file).isFile())
        {
            assert.ok(!fs.readFileSync(file, 'utf8').includes('personal-fixture-value'), relative);
        }
    }
    assert.ok(fs.existsSync(path.join(destination, 'bin/team-studio.cjs')));
    assert.ok(fs.existsSync(path.join(destination, 'launcher.cjs')));
    assert.throws(() => createNpmPackage({ root, destination }), /必须为空/);
});

test('npm 命令可启动、查询、停止，配置和数据库保存在用户数据目录', { skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 30000 }, async t =>
{
    const directory = temporaryDirectory(t);
    const destination = path.join(directory, 'installed package');
    createNpmPackage({ destination });
    const entry = path.join(destination, 'bin/team-studio.cjs');
    const env = { ...process.env, LOCALAPPDATA: path.join(directory, 'user data'), TEAM_STUDIO_NO_BROWSER: '1' };
    delete env.AGENT_MANAGER_DATA_DIR;
    delete env.TEAM_STUDIO_LAUNCHER_STATE_DIR;
    const command = action => spawnSync(process.execPath, [entry, action], { env, cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(command('--version').stdout.trim(), version);
    assert.equal(command('invalid-action').status, 1);
    const data = path.join(env.LOCALAPPDATA, 'TeamStudio');
    assert.ok(!fs.existsSync(data), '帮助和无效命令不会创建用户数据');

    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    env.AGENT_MANAGER_PORT = String(probe.address().port);
    await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, [entry], { env, cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('exit', code => resolve(code));
    });
    try
    {
        let health;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline)
        {
            assert.equal(child.exitCode, null, output);
            try
            {
                health = await (await fetch(`http://127.0.0.1:${env.AGENT_MANAGER_PORT}/api/health`, { signal: AbortSignal.timeout(300) })).json();
                break;
            }
            catch
            {
                await delay(100);
            }
        }
        assert.equal(health?.version, version, output);
        assert.ok(fs.existsSync(path.join(data, 'runs.sqlite')));
        assert.ok(!fs.existsSync(path.join(destination, '.agent-manager')));
        const status = command('status');
        assert.equal(status.status, 0, status.stderr);
        assert.equal(JSON.parse(status.stdout).phase, 'running');
        const stopped = command('stop');
        assert.equal(stopped.status, 0, stopped.stderr);
        assert.equal(await done, 0, output);
        assert.ok(!fs.existsSync(path.join(data, 'launcher.json')));
    }
    finally
    {
        if (child.exitCode === null)
        {
            const stopped = command('stop');
            assert.equal(stopped.status, 0, stopped.stderr);
            await done;
        }
    }
});
