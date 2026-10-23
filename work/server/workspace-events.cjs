const { randomUUID } = require('node:crypto');
const { writeStream, guardStream } = require('./sse.cjs');

// 通知只携带失效范围，快照仍由通用 HTTP 接口提供。无变更时不安排刷新任务。
function createWorkspaceEvents({ batchMs = 250 } = {}) {
  const clients = new Set(), epoch = randomUUID();
  let timer = null, heartbeat = null;
  const topics = new Set(), runs = new Map();
  function write(client, value) {
    // 慢客户端断开后由 EventSource 重连并补快照，避免无限堆积输出。
    if (!writeStream(client, value)) clients.delete(client);
  }
  function flush() {
    timer = null;
    const data = JSON.stringify({ topics: [...topics], runs: [...runs.values()] });
    topics.clear(); runs.clear();
    for (const client of clients) write(client, `event: change\ndata: ${data}\n\n`);
  }
  function publish(changed, run) {
    if (!clients.size) return;
    changed.forEach(topic => topics.add(topic));
    if (run) runs.set(run.runId, run);
    if (!timer) { timer = setTimeout(flush, batchMs); timer.unref?.(); }
  }
  function attach(res) {
    guardStream(res);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    clients.add(res);
    // 每次连接都要求客户端重新取快照，包括服务重启和断线期间丢失的事件。
    write(res, `retry: 3000\nevent: ready\ndata: ${JSON.stringify({ epoch })}\n\n`);
    if (!heartbeat) {
      heartbeat = setInterval(() => { for (const client of clients) write(client, ': heartbeat\n\n'); }, 15000);
      heartbeat.unref?.();
    }
    res.once('close', () => {
      clients.delete(res);
      if (!clients.size) {
        clearInterval(heartbeat); heartbeat = null;
        clearTimeout(timer); timer = null; topics.clear(); runs.clear();
      }
    });
  }
  return { publish, attach };
}
module.exports = { createWorkspaceEvents };
