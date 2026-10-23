/* 显式启动的真实引擎烟测：仅在临时目录创建文本文件，不接触用户任务或历史库。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRun, continueRun, cancelRun, sessions, runs } = require('../agent-manager-server.cjs');
if (process.env.RUN_TEAM_ENGINE_SMOKE !== '1') throw new Error('Set RUN_TEAM_ENGINE_SMOKE=1 to run this real-engine check');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-engine-smoke-'));
const suffix = Date.now();
const managerId = 'smoke-pm-' + suffix, workerId = 'smoke-dev-' + suffix;
const members = [{ id: managerId, name: '测试经理', role: 'ProjectManager' }, { id: workerId, name: '测试工程师', role: 'Engineer' }].map(member => ({ ...member, provider: 'codex-app-server', model: 'default', cwd, prompt: '这是隔离烟测，只按本轮任务执行，简短回复。' }));
async function waitFor(run) {
  const started = Date.now(); let lastSize = -1;
  while (!['completed', 'failed', 'cancelled'].includes(run.status)) {
    const blocked = [...runs.values()].find(item => item.approvals.size);
    if (blocked) {
      await cancelRun(run);
      throw new Error(`真实引擎等待用户审批，烟测已停止且未自动批准：${blocked.context.agentName}。请检查本机沙箱与运行环境。`);
    }
    if (runs.size !== lastSize) { lastSize = runs.size; console.log(JSON.stringify({ runs: [...runs.values()].map(item => ({ agent: item.context.agentName, status: item.status })) })); }
    if (Date.now() - started > 240000) { await cancelRun(run); throw new Error('Engine smoke timeout'); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log(JSON.stringify({ status: run.status, delivery: run.delivery, error: run.error, outputTail: run.output?.slice(-1000), cwd }));
  if (run.status !== 'completed') throw new Error(run.error || 'Smoke did not complete');
}
(async () => {
  try {
    const first = await startRun({ agentId: managerId, cwd, approvalPolicy: 'on-request',
      goal: '隔离工具烟测：请立即派发测试工程师在工作区创建 greeting.txt，内容精确为 team-ready。通过 team_wait 获得结果；使用读取工具验证文件，再调用 team_complete 提供 greeting.txt 和验证结果。不要写项目计划，不安装依赖，不做其他工作。',
      management: { members, concurrency: 1 }, context: { taskId: 'smoke-' + suffix, taskTitle: '创建 greeting.txt 并验收', agentName: '测试经理', agentRole: 'ProjectManager', coordinatorAgentId: managerId, dispatchMode: 'manager', source: { kind: 'user' } } });
    await waitFor(first);
    if (fs.readFileSync(path.join(cwd, 'greeting.txt'), 'utf8').trim() !== 'team-ready') throw new Error('Artifact content mismatch');
    const next = await continueRun(first.id, { goal: '续聊工具烟测：请派发同一测试工程师把 greeting.txt 改成 team-resumed，读取结果并完成验收。' });
    await waitFor(next);
    if (fs.readFileSync(path.join(cwd, 'greeting.txt'), 'utf8').trim() !== 'team-resumed') throw new Error('Resumed artifact mismatch');
    console.log('PASS: real Codex manager dispatch, file creation, acceptance and resumed delegation');
  } finally {
    for (const session of sessions.values()) session.client.child?.stdin.end();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
