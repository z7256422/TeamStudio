/* 按运行、线程、轮次和 item 关联审批事务；独立于只保留 200 条的事件日志。 */
const contexts = new WeakMap();
const keyOf = params => params?.threadId && params?.turnId && params?.itemId
  ? JSON.stringify([params.threadId, params.turnId, params.itemId]) : null;
function rememberApprovalContext(run, event) {
  if (event.type !== 'provider_event' || !['item/started', 'item/completed'].includes(event.method)) return;
  const p = event.params || {}, item = p.item;
  if (item?.type !== 'fileChange' || !Array.isArray(item.changes)) return;
  if (p.threadId !== run.threadId || p.turnId !== run.turnId) return;
  const key = keyOf({ ...p, itemId: item.id });
  if (!key) return;
  let entries = contexts.get(run);
  if (!entries) contexts.set(run, entries = new Map());
  entries.delete(key);
  entries.set(key, { changes: item.changes, source: event.method });
  // 审批中的上下文不能因其他工具输出而被挤掉；其余只保留最近 64 个 item。
  const pinned = new Set([...(run.approvals?.values() || [])].map(approval => keyOf(approval.params)));
  for (const old of entries.keys()) {
    if (entries.size <= 64) break;
    if (!pinned.has(old)) entries.delete(old);
  }
}
function approvalParams(run, approval) {
  const params = approval.params || {};
  if (approval.method !== 'item/fileChange/requestApproval') return params;
  if (Array.isArray(params.changes || params.fileChanges) && (params.changes || params.fileChanges).length) return { ...params, changesSource: 'request' };
  const context = run && contexts.get(run)?.get(keyOf(params));
  return context ? { ...params, changes: context.changes, changesSource: context.source }
    : { ...params, changesUnavailable: true };
}
module.exports = { rememberApprovalContext, approvalParams };
