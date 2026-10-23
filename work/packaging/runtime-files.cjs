const fs = require('node:fs');
const path = require('node:path');

// 两种分发共用运行文件白名单，不遍历用户数据、配置或开发产物。
function runtimeFiles(root)
{
    const serverFiles = fs.readdirSync(path.join(root, 'work/server')).sort()
        .filter(file => file.endsWith('.cjs') && !/\.(?:test|local|secret|secrets)\.cjs$/.test(file))
        .map(file => `work/server/${file}`);

    return [
        'work/agent-manager-server.cjs',
        'work/server/provider-secrets.ps1',
        ...serverFiles,
        ...['run-activity.js', 'run-progress.js', 'run-reasoning.js', 'model-reasoning.js']
            .map(file => `work/shared/${file}`),
        'outputs/agent-manager.html',
        'outputs/product-company.json',
        'outputs/product-company-prompts.md',
        'outputs/THIRD_PARTY_LICENSES.txt'
    ];
}

module.exports = { runtimeFiles };
