const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

/* 目录浏览只返回文件夹名称和路径，绝不读取或上传文件内容。 */
async function listDirectories(input, workspace) {
  if (input != null && (typeof input !== 'string' || input.length > 400 || input.includes('\0'))) {
    throw Object.assign(new Error('目录路径无效，最多 400 个字符'), { statusCode: 400 });
  }
  const requested = input?.trim() || workspace;
  if (!path.isAbsolute(requested)) throw Object.assign(new Error('请输入完整的绝对目录路径'), { statusCode: 400 });
  try {
    const current = await fs.realpath(requested);
    if (!(await fs.stat(current)).isDirectory()) throw Object.assign(new Error('请选择文件夹，而不是文件'), { statusCode: 400 });
    const entries = await fs.readdir(current, { withFileTypes: true });
    const directories = entries.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, path: path.join(current, entry.name) }));
    // 链接按需检查，不递归展开，避免循环链接阻塞浏览。
    const links = await Promise.allSettled(entries.filter(entry => entry.isSymbolicLink()).map(async entry => {
      const candidate = path.join(current, entry.name);
      return (await fs.stat(candidate)).isDirectory() ? { name: entry.name, path: candidate } : null;
    }));
    for (const link of links) if (link.status === 'fulfilled' && link.value) directories.push(link.value);
    directories.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
    const shortcuts = [{ name: '控制台项目', path: workspace }, { name: '用户目录', path: os.homedir() }];
    if (process.platform === 'win32') {
      const drives = await Promise.allSettled(Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i) + ':\\').map(async drive => (await fs.stat(drive)).isDirectory() ? drive : null));
      for (const drive of drives) if (drive.status === 'fulfilled' && drive.value) shortcuts.push({ name: drive.value, path: drive.value });
    } else shortcuts.push({ name: '文件系统', path: '/' });
    const parent = path.dirname(current);
    return { path: current, parent: parent === current ? null : parent, directories, shortcuts };
  } catch (error) {
    if (error.statusCode) throw error;
    const messages = { ENOENT: '目录不存在，请选择其他目录', ENOTDIR: '所选路径不是文件夹', EACCES: '没有权限读取这个目录', EPERM: '没有权限读取这个目录' };
    throw Object.assign(new Error(messages[error.code] || `读取目录失败：${error.message}`), { statusCode: error.code === 'ENOENT' ? 404 : ['EACCES', 'EPERM'].includes(error.code) ? 403 : 400 });
  }
}
module.exports = { listDirectories };
