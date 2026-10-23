/* Codex 适配边界：仅将公开 summary 映射为通用事件，原始推理不进入历史或 SSE。 */
function stripPrivateReasoning(value) {
  if (Array.isArray(value)) return value.map(stripPrivateReasoning);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'reasoning') return { type: 'reasoning', id: value.id,
    summary: Array.isArray(value.summary) ? value.summary.filter(part => typeof part === 'string') : [] };
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['encrypted_content', 'encryptedContent'].includes(key))
    .map(([key, child]) => [key, stripPrivateReasoning(child)]));
}
function publicReasoningEvent(event) {
  const params = event.params || {}, item = params.item;
  if (event.type === 'provider_event') {
    const base = { type: 'reasoning_summary', runId: event.runId, time: event.time, sequence: event.sequence,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId || item?.id };
    if (event.method === 'item/reasoning/summaryTextDelta') return { ...base, stage: 'delta', summaryIndex: params.summaryIndex, delta: params.delta };
    if (event.method === 'item/reasoning/summaryPartAdded') return { ...base, stage: 'part', summaryIndex: params.summaryIndex };
    if (['item/started', 'item/completed'].includes(event.method) && item?.type === 'reasoning') return { ...base,
      stage: event.method === 'item/started' ? 'started' : 'completed', summary: Array.isArray(item.summary) ? item.summary.filter(part => typeof part === 'string') : [] };
    // 也丢弃旧协议 agent_reasoning / raw_content 通知，不把文本放进通用事件面板。
    if (/reasoning/i.test(event.method || '')) return null;
  }
  // turn/completed、thread/resume 快照也可能内嵌 reasoning item。
  return stripPrivateReasoning(event);
}
module.exports = { publicReasoningEvent };
