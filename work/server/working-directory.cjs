const fs = require('node:fs');
const path = require('node:path');

class WorkingDirectoryError extends Error {
  constructor(code, summary, cwd = '', statusCode = 400) {
    super(cwd ? `${summary}：${cwd}` : summary);
    this.name = 'WorkingDirectoryError';
    Object.assign(this, { code, summary, cwd, statusCode });
  }
}

// 只在未指定路径时使用默认目录；失效的项目路径必须由用户重新选择。
function resolveWorkingDirectory(input, fallback) {
  if (input != null && (typeof input !== 'string' || input.length > 400 || input.includes('\0'))) {
    throw new WorkingDirectoryError('invalid_working_directory', '工作目录必须是长度不超过 400 的有效路径');
  }
  let value = (input || '').trim();
  // 兼容资源管理器“复制为路径”，保留目录名称内部的空格与特殊字符。
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
  const cwd = path.resolve(fallback, value || '.');
  let stat;
  try { stat = fs.statSync(cwd); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new WorkingDirectoryError('working_directory_missing', '工作目录不存在，请重新选择', cwd, 404);
    if (['EACCES', 'EPERM'].includes(error.code)) throw new WorkingDirectoryError('working_directory_denied', '无权访问工作目录，请选择有权限的文件夹', cwd, 403);
    throw new WorkingDirectoryError('working_directory_unavailable', `无法读取工作目录（${error.code || '未知错误'}）`, cwd, 500);
  }
  if (!stat.isDirectory()) throw new WorkingDirectoryError('working_directory_not_folder', '工作目录指向了文件，请选择文件夹', cwd);
  return cwd;
}

function workingDirectoryDiagnostic(error) {
  return {
    status: 'blocked', category: 'working-directory', code: error.code,
    cwd: error.cwd, summary: error.summary, repair: { available: false },
    checkedAt: new Date().toISOString()
  };
}

module.exports = { WorkingDirectoryError, resolveWorkingDirectory, workingDirectoryDiagnostic };
