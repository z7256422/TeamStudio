/* 只裁剪展示标题；目标、分派指令和对话正文始终保留原文。 */
function shortTaskTitle(value, limit = 48) {
  const line = String(value || '').trim().split(/\r?\n/).find(part => part.trim())?.replace(/^#+\s*/, '').trim() || '未命名任务';
  const chars = Array.from(line);
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : line;
}
