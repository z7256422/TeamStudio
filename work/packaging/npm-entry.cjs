#!/usr/bin/env node
const os = require('node:os');
const path = require('node:path');
const { version } = require('../work/server/app-info.cjs');

function main()
{
    const action = process.argv[2] || 'start';
    if (process.argv.length > 3)
    {
        throw new Error('用法：team-studio [start|stop|status|--version|--help]');
    }
    if (['--version', '-v'].includes(action))
    {
        console.log(version);
        return;
    }
    if (['--help', '-h'].includes(action))
    {
        console.log('用法：team-studio [start|stop|status]\n默认启动本机面板；--version 查看版本。\n可用 AGENT_MANAGER_PORT 修改端口，AGENT_MANAGER_DATA_DIR 指定数据目录。');
        return;
    }
    if (!['start', 'stop', 'status'].includes(action))
    {
        throw new Error('未知命令。运行 team-studio --help 查看用法。');
    }
    if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24)
    {
        throw new Error('此安装包需要 Windows x64 和 Node.js 24+。');
    }

    // npm 的全局安装目录可能只读；用户历史和启动状态独立保存，升级包时不会覆盖。
    const localData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    process.env.AGENT_MANAGER_DATA_DIR = path.resolve(process.env.AGENT_MANAGER_DATA_DIR || path.join(localData, 'TeamStudio'));
    process.env.TEAM_STUDIO_LAUNCHER_STATE_DIR = process.env.AGENT_MANAGER_DATA_DIR;
    require('../launcher.cjs');
}

try
{
    main();
}
catch (error)
{
    console.error(error.message);
    process.exitCode = 1;
}
