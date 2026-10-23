/* 只整理展示顺序，不修改运行记录；正文隔开命令组，避免不同阶段的操作被混在一起。 */
function executionTranscriptBlocks(messages = [], steps = []) {
  const entries = [
    ...messages.map((message, index) => ({ id: 'message-' + (message.id || index), kind: 'message',
      label: message.legacy ? '历史合并输出' : message.phase === 'final_answer' ? '最终结果' : '公开进展',
      time: message.startedAt, text: message.text, order: index })),
    ...steps.map((step, index) => ({ ...step, id: 'step-' + (step.id || index),
      kind: step.label === '执行命令' ? 'command' : 'operation', label: step.label || '执行操作',
      time: step.startedAt || step.time, order: messages.length + index }))
  ].sort((left, right) => {
    const timestamp = value => value == null || !Number.isFinite(new Date(value).getTime()) ? Infinity : new Date(value).getTime();
    return timestamp(left.time) - timestamp(right.time) || left.order - right.order;
  });
  const blocks = [];
  for (const entry of entries) {
    const previous = blocks.at(-1);
    if (entry.kind === 'command' && previous?.kind === 'commands') previous.entries.push(entry);
    else if (entry.kind === 'command') blocks.push({ id: entry.id, kind: 'commands', entries: [entry] });
    else blocks.push(entry);
  }
  return blocks;
}
function executionCommandPreview(command) {
  const text = String(command || '').replace(/\s+/g, ' ').trim();
  // 摘要隐藏常见 PowerShell 启动包装；详情始终保留原始命令，不影响复制和核验。
  const prefix = /^(?:"[^"\r\n]*[\\/](?:powershell|pwsh)\.exe"|(?:powershell|pwsh)(?:\.exe)?)\s+(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+)*-Command\s+/i;
  const inner = text.replace(prefix, '');
  return inner !== text && ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) ? inner.slice(1, -1) : inner;
}
function executionOperationStatus(entry) {
  if (entry.status === 'failed' || (entry.exitCode != null && entry.exitCode !== 0)) return 'failed';
  if (entry.status === 'cancelled') return 'cancelled';
  if (['done', 'completed'].includes(entry.status)) return 'done';
  return entry.status || 'unknown';
}
if (typeof module !== 'undefined' && module.exports) module.exports = { executionTranscriptBlocks, executionCommandPreview, executionOperationStatus };
