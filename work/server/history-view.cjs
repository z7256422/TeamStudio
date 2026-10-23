const { randomUUID } = require('node:crypto');
const short = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : value;
function compactDelivery(delivery, runId) {
  if (!delivery) return null;
  const { report, reply, ...rest } = delivery;
  return { ...rest, runId, summary: short(delivery.summary, 2000), reply: short(reply, 6000),
    verification: delivery.verification?.slice(0, 10).map(value => short(value, 500)), artifacts: delivery.artifacts?.slice(0, 30),
    truncated: Boolean(report || (reply?.length > 6000) || delivery.summary?.length > 2000 || delivery.verification?.length > 10 || delivery.artifacts?.length > 30) };
}
function compactRun(run, base, detail = false) {
  const messages = run.messages || [], steps = run.progress?.steps || [];
  const hasTranscript = messages.length > 0 || Boolean(run.output);
  let budget = 16000;
  const previews = detail ? messages.slice(-30).reverse().map(message => {
    const text = (message.text || '').slice(0, Math.min(8000, budget)); budget -= text.length;
    return { ...message, text, truncated: text.length < (message.text || '').length };
  }).reverse() : [];
  let summaryBudget = 10000;
  const reasoningSummaries = (run.progress?.reasoningSummaries || []).slice(-5).reverse().map(entry => {
    const parts = entry.parts.map(part => { const value = part.slice(0, summaryBudget); summaryBudget -= value.length; return value; });
    return { ...entry, parts, truncated: entry.truncated || parts.join('').length < entry.parts.join('').length };
  }).reverse();
  return { ...base, compact: true, revision: `${run.sequence || 0}:${run.status}:${run.updatedAt || ''}`,
    coordination: compactDelivery(base.coordination, run.id), goal: short(base.goal, 1000), approvals: [],
    context: base.context ? { ...base.context, taskTitle: short(base.context.taskTitle, 1000), assignment: short(base.context.assignment, 1000) } : null,
    feedback: (base.feedback || []).slice(-5).map(item => ({ ...item, question: short(item.question, 500), context: short(item.context, 500), answer: short(item.answer, 1000) })),
    progress: { ...run.progress, steps: detail ? steps.map(step => ({ ...step, detail: short(step.detail, 2000), output: short(step.output, 2000) })) : [], reasoningSummaries },
    messages: previews, output: detail && !messages.length ? short(run.output || '', 16000) : '', events: [],
    messageCount: messages.length || (run.output ? 1 : 0), operationCount: steps.length,
    transcriptUrl: `/api/runs/${encodeURIComponent(run.id)}/transcript`,
    // 未展开时正文是有意省略，不应把“未加载”误报为“被截断”。
    transcriptAvailable: hasTranscript,
    transcriptOmitted: !detail && hasTranscript,
    transcriptTruncated: detail && (messages.length > previews.length || previews.some(message => message.truncated) || (run.output?.length > 16000)) };
}

// 缓存只保存运行版本号，不再复制巨型文本。过期版本自动返回新快照，断线后可收敛。
function createHistorySnapshots(maxEntries = 128) {
  const snapshots = new Map();
  function project(scope, since, runs, base, projectRun) {
    const old = snapshots.get(since), previous = old?.scope === scope ? old : null;
    const versions = new Map(runs.map(run => [run.id, `${run.sequence || 0}:${run.status}:${run.updatedAt || ''}`]));
    const changed = runs.filter(run => previous?.versions.get(run.id) !== versions.get(run.id));
    const same = previous && !changed.length && previous.versions.size === versions.size;
    const revision = same ? since : randomUUID();
    if (!same) {
      snapshots.set(revision, { scope, versions });
      while (snapshots.size > maxEntries) snapshots.delete(snapshots.keys().next().value);
    }
    return { ...base, revision, reset: !previous, runOrder: runs.map(run => run.id), runs: changed.map(projectRun) };
  }
  return { project };
}
module.exports = { compactRun, compactDelivery, createHistorySnapshots };
