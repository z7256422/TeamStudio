/* 保存公开回复的消息边界和时间；不读取或保存模型推理内容。旧输出保留兼容显示。 */
function updateRunMessages(run, event) {
  const item = event.type === 'provider_event' && event.params?.item;
  if (event.type !== 'message_delta' && !(item?.type === 'agentMessage' && ['item/started', 'item/completed'].includes(event.method))) return;
  const messages = run.messages || (run.messages = []);
  const id = event.itemId || item?.id || 'legacy-stream';
  let message = messages.find(entry => entry.id === id);
  if (!message) { message = { id, text: '', phase: null, startedAt: event.time }; messages.push(message); }
  message.updatedAt = event.time;
  // 消息正文也是负责人读取成果的持久化来源，不能按界面预览上限丢掉正文开头。
  if (event.type === 'message_delta') message.text += event.delta || '';
  if (item) {
    if (typeof item.text === 'string') message.text = item.text;
    if (['commentary', 'final_answer'].includes(item.phase)) message.phase = item.phase;
    if (event.method === 'item/completed') message.endedAt = event.time;
  }
  // 仅清理旧进展；最终成果及当前消息保留完整，兼容未提供 phase 的最后一条回复。
  while (messages.length > 100 || (messages.length > 1 && messages.reduce((size, entry) => size + entry.text.length, 0) > 200000)) {
    const index = messages.findIndex(entry => entry !== message && entry.phase !== 'final_answer');
    if (index < 0) break;
    messages.splice(index, 1);
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { updateRunMessages };
