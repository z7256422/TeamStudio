const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { recoverReportDeliveries } = require('./delivery-contract.cjs');
const { publicReasoningEvent } = require('./codex-reasoning.cjs');
const { projectReasoningSummaries } = require('../shared/run-reasoning.js');

/* 只保存可恢复的运行数据；进程、订阅和待审批回调不能跨服务进程恢复。 */
function storedRun(run) {
  const keys = ['id', 'agentId', 'adapter', 'goal', 'cwd', 'context', 'model', 'settings', 'delivery', 'feedback', 'alerts', 'interruption', 'batch', 'queuedInput', 'threadMigration', 'parentRunId', 'events', 'output', 'messages', 'progress', 'sequence', 'status', 'threadId', 'turnId', 'createdAt', 'startedAt', 'endedAt', 'updatedAt', 'error'];
  return Object.fromEntries(keys.filter(key => run[key] !== undefined).map(key => [key, key === 'events' ? run.events.map(publicReasoningEvent).filter(Boolean) : run[key]]));
}
function createRunStore(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const pending = new Map(); let timer = null;
  const write = db.prepare('INSERT INTO runs(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (!pending.size) return;
    db.exec('BEGIN');
    try { for (const [id, value] of pending) write.run(id, JSON.stringify(storedRun(value))); db.exec('COMMIT'); pending.clear(); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    load() {
      const loaded = db.prepare('SELECT data FROM runs ORDER BY rowid').all().map(row => {
        const run = JSON.parse(row.data);
        run.events = (run.events || []).map(publicReasoningEvent).filter(Boolean);
        if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
          run.status = 'cancelled'; run.endedAt = run.updatedAt = new Date().toISOString();
          run.interruption = 'service-restart';
          run.error = '服务重启，中断了运行状态跟踪；可在原会话中继续对话。';
          if (run.settings?.management) run.delivery = { status: 'cancelled', summary: '服务重启，团队任务尚未完成交付，请继续此会话。' };
          run.progress = { ...run.progress, status: 'cancelled', activity: '服务重启，等待继续', pendingApprovals: [], pendingFeedback: [] };
        }
        if (run.progress?.reasoningSummaries?.length) run.progress.reasoningSummaries = projectReasoningSummaries(run.progress.reasoningSummaries, { type: 'completed', status: run.status, time: run.endedAt || run.updatedAt });
        run.feedback = (run.feedback || []).map(item => item.status === 'pending' ? { ...item, status: 'cancelled', answer: '服务重启，本次反馈等待已取消；请继续原会话重新安排。', resolvedAt: new Date().toISOString() } : item);
        return { ...run, approvals: new Map(), subscribers: new Set() };
      });
      return recoverReportDeliveries(loaded);
    },
    save(run, immediate = false) {
      pending.set(run.id, run);
      if (immediate) return flush();
      if (!timer) { timer = setTimeout(() => { try { flush(); } catch (error) { console.error(`运行记录保存失败：${error.message}`); } }, 800); timer.unref(); }
    },
    remove(ids) {
      flush(); db.exec('BEGIN');
      try { const remove = db.prepare('DELETE FROM runs WHERE id=?'); for (const id of ids) remove.run(id); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { flush(); db.close(); },
    flush
  };
}
module.exports = { createRunStore, storedRun };
