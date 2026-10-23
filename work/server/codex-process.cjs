const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_SERVER_ARGS = ['app-server', '--stdio'];
const envValue = (env, name) => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())] || '';

function windowsExecutable(command, cwd, env) {
  let filename = command.trim();
  if (filename.startsWith('"') && filename.endsWith('"')) filename = filename.slice(1, -1);
  // CODEX_BIN 只接受可执行文件名或路径，不接受带参数的 shell 命令。
  if (!filename || /["\r\n\0]/.test(filename)) throw new Error('CODEX_BIN 必须是可执行文件路径，不能包含引号、换行或命令参数');
  const supported = ['.com', '.exe', '.bat', '.cmd'];
  const extension = path.win32.extname(filename).toLowerCase();
  if (extension && !supported.includes(extension)) throw new Error('Windows CODEX_BIN 请指向 .exe、.com、.cmd 或 .bat 文件');
  const configured = envValue(env, 'PATHEXT').toLowerCase().split(';').filter(value => supported.includes(value));
  const extensions = extension ? [''] : [...new Set([...configured, ...supported])];
  const hasDirectory = /[\\/:]/.test(filename);
  const directories = hasDirectory ? [''] : [cwd, ...envValue(env, 'PATH').split(';').filter(Boolean).map(value => value.replace(/^"|"$/g, ''))];
  for (const directory of directories) {
    for (const suffix of extensions) {
      const candidate = path.win32.resolve(cwd, directory, filename + suffix);
      try { if (fs.statSync(candidate).isFile()) return candidate; }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
  }
  throw Object.assign(new Error('找不到 Codex 可执行文件，请检查 PATH 或 CODEX_BIN 设置'), { code: 'ENOENT' });
}

function codexLaunch(command, { cwd, env = process.env, platform = process.platform }) {
  const options = { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  if (platform !== 'win32') return { command, args: [...APP_SERVER_ARGS], options };
  const executable = windowsExecutable(command, cwd, env);
  if (!/\.(?:cmd|bat)$/i.test(executable)) return { command: executable, args: [...APP_SERVER_ARGS], options };
  const cmd = path.win32.join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe');
  // .cmd 必须通过 cmd.exe 执行。命令文本只含固定参数，路径由带引号的环境变量提供，
  // 不把任意路径字符拼接成 shell 语法。禁用 AutoRun 和延迟展开，保护路径中的 &、!、% 等字符。
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'team_studio_codex_shim'));
  childEnv.TEAM_STUDIO_CODEX_SHIM = executable;
  return { command: cmd, args: ['/d', '/s', '/v:off', '/c', '""%TEAM_STUDIO_CODEX_SHIM%" app-server --stdio"'],
    options: { ...options, env: childEnv, windowsVerbatimArguments: true } };
}

function spawnCodexAppServer(command, options) {
  const launch = codexLaunch(command, options);
  return spawn(launch.command, launch.args, launch.options);
}

module.exports = { codexLaunch, spawnCodexAppServer };
