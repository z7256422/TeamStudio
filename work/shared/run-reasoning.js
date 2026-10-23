/* 供应商无关的公开摘要投影；按执行内 item 分段，快照替换增量，不混入正文。 */
function projectReasoningSummaries(previous = [], event) {
  const terminal = ['completed', 'error', 'cancelled'].includes(event.type);
  const item = event.type === 'provider_event' && event.params?.item;
  const nextActivity = event.type === 'message_delta' || event.type === 'tool_output' ||
    (event.method === 'item/started' && item && !['reasoning', 'userMessage'].includes(item.type));
  const summaryEvent = event.type === 'reasoning_summary';
  if (!terminal && !nextActivity && !summaryEvent) return previous;
  const validId = typeof event.itemId === 'string' && event.itemId.length > 0 && event.itemId.length <= 300;
  const partEvent = ['part', 'delta'].includes(event.stage);
  if (summaryEvent && (!validId || !['started', 'part', 'delta', 'completed'].includes(event.stage) ||
    (partEvent && (!Number.isInteger(event.summaryIndex) || event.summaryIndex < 0 || event.summaryIndex >= 32)) ||
    (event.stage === 'delta' && typeof event.delta !== 'string'))) return previous;
  const found = previous.find(entry => entry.id === event.itemId);
  if (summaryEvent && found && ((event.sequence && event.sequence <= (found.sequence || 0)) ||
    (found.status !== 'streaming' && event.stage !== 'completed'))) return previous;
  const interrupted = event.type === 'error' || event.type === 'cancelled' ||
    (event.type === 'completed' && event.status !== 'completed');
  let entries = previous.map(entry => {
    const close = entry.status === 'streaming' && (terminal || nextActivity || (summaryEvent && !found && event.stage !== 'completed' && entry.id !== event.itemId));
    return close ? { ...entry, status: interrupted ? 'interrupted' : 'completed', endedAt: event.time, updatedAt: event.time } : entry;
  });
  if (summaryEvent) {
    let index = entries.findIndex(entry => entry.id === event.itemId);
    const old = index < 0 ? { id: event.itemId, number: (entries.at(-1)?.number || entries.length) + 1, parts: [], startedAt: event.time, status: 'streaming' } : entries[index];
    const entry = { ...old, parts: [...old.parts], updatedAt: event.time, sequence: event.sequence || old.sequence };
    if (partEvent) {
      while (entry.parts.length <= event.summaryIndex) entry.parts.push('');
      if (event.stage === 'delta') entry.parts[event.summaryIndex] += event.delta;
    }
    // 完成快照经常包含整段文本；覆盖而不是再次追加。空快照不抹掉已收到的摘要。
    if (Array.isArray(event.summary) && event.summary.some(part => typeof part === 'string' && part)) {
      entry.parts = event.summary.slice(0, 32).map(part => typeof part === 'string' ? part : '');
      if (event.summary.length > 32) entry.truncated = true;
    }
    let remaining = 20000;
    entry.parts = entry.parts.map(part => { const text = part.slice(0, remaining); remaining -= text.length; if (text.length < part.length) entry.truncated = true; return text; });
    if (event.stage === 'completed') { entry.status = old.status === 'interrupted' ? 'interrupted' : 'completed'; entry.endedAt ||= event.time; }
    if (index < 0) entries.push(entry); else entries[index] = entry;
  }
  // 独立于滚动事件缓冲保留摘要，限制长任务的内存和历史体积。
  while (entries.length > 40 || (entries.length > 1 && entries.reduce((size, entry) => size + entry.parts.join('').length, 0) > 120000)) entries.shift();
  return entries;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { projectReasoningSummaries };
