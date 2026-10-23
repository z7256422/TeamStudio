const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Windows 密钥绑定当前系统用户；敏感内容仅经 stdin 传递，不进入命令行参数。
function dpapi(value, decrypt) {
  const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'provider-secrets.ps1'), decrypt ? 'unprotect' : 'protect'], {
    input: value, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, shell: false
  });
  if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/=]+$/.test(result.stdout)) throw new Error('无法使用当前 Windows 用户加密或解密 API Key，请重新填写密钥');
  return result.stdout;
}
function protectSecret(value) {
  if (!value) return '';
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return process.platform === 'win32' ? `dpapi:${dpapi(encoded, false)}` : `local:${encoded}`;
}
function revealSecret(value) {
  if (!value) return '';
  if (value.startsWith('dpapi:') && process.platform === 'win32') return Buffer.from(dpapi(value.slice(6), true), 'base64').toString('utf8');
  if (value.startsWith('local:') && process.platform !== 'win32') return Buffer.from(value.slice(6), 'base64').toString('utf8');
  throw new Error('此密钥来自其他系统或用户，请重新填写 API Key');
}
module.exports = { protectSecret, revealSecret };
