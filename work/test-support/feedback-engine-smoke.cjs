/* 显式启用的反馈协议烟测：真实 Codex，只在临时目录操作，默认不运行。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRun, continueRun, cancelRun, sessions, runs } = require('../agent-manager-server.cjs');
if (process.env.RUN_FEEDBACK_ENGINE_SMOKE !== '1') throw new Error('Set RUN_FEEDBACK_ENGINE_SMOKE=1');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-feedback-engine-'));
const suffix = Date.now(), managerId = 'feedback-pm-' + suffix, memberId = 'feedback-dev-' + suffix;
const members = [{ id: managerId, name: '反馈测试经理', role: 'ProjectManager' }, { id: memberId, name: '反馈测试成员', role: 'Engineer' }].map(member => ({ ...member, cwd, model: 'default', provider: 'codex-app-server', prompt: '这是隔离协议验证，严格执行指定的反馈工具调用，简短输出，不做其他工作。' }));
async function wait(run) {
  await new Promise((resolve, reject) => {
    let signature = '', settled = false;
    const observer = { write: () => queueMicrotask(check) };
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); run.subscribers.delete(observer);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (settled) return;
      const next = JSON.stringify([...runs.values()].map(item => ({ name: item.context.agentName, state: item.status, feedback: item.feedback?.map(q => q.status) })));
      if (next !== signature) { console.log(next); signature = next; }
      if ([...runs.values()].some(item => item.approvals.size)) return finish(new Error('Smoke requires user approval; stopped without granting it'));
      if (['completed', 'failed', 'cancelled'].includes(run.status)) finish();
    };
    const timer = setTimeout(() => finish(new Error('Feedback engine smoke timeout')), 240000);
    run.subscribers.add(observer); check();
  });
  assert.equal(run.status, 'completed', run.error || run.output?.slice(-1500));
  assert.equal(run.feedback?.length, 1); assert.equal(run.feedback[0].status, 'answered');
  return [...runs.values()].find(item => item.context?.coordinatorRunId === run.id);
}
const goal = token => `隔离反馈协议验证：必须只派发测试成员一个任务：先调用 team_ask_manager 询问“本轮 feedback.txt 应写什么内容”，收到经理答复后才写入 feedback.txt。经理调用 team_wait 收到 feedbackRequests 后调用 team_reply_member，明确答复内容精确为 ${token}。之后等待成员完成，读取文件验证，再调用 team_complete 验收。不要写计划文档，不安装依赖，不自行使用其他子代理。`;
(async () => {
  try {
    const first = await startRun({ agentId: managerId, cwd, sandbox: 'danger-full-access', approvalPolicy: 'on-request', goal: goal('feedback-ready'),
      management: { members, concurrency: 1 }, context: { taskId: 'feedback-' + suffix, agentName: '反馈测试经理', agentRole: 'ProjectManager', dispatchMode: 'manager', coordinatorAgentId: managerId, source: { kind: 'user' } } });
    const worker = await wait(first);
    assert.equal(fs.readFileSync(path.join(cwd, 'feedback.txt'), 'utf8').trim(), 'feedback-ready');
    const second = await continueRun(first.id, { goal: goal('feedback-resumed') });
    const resumedWorker = await wait(second);
    assert.equal(worker.threadId, resumedWorker.threadId); assert.equal(first.threadId, second.threadId);
    assert.equal(runs.size, 4, '问答没有增加运行');
    assert.equal(fs.readFileSync(path.join(cwd, 'feedback.txt'), 'utf8').trim(), 'feedback-resumed');
    console.log('PASS real feedback, reply, artifact, and resumed thread: ' + cwd);
  } finally {
    for (const run of runs.values()) if (!['completed', 'failed', 'cancelled'].includes(run.status)) await cancelRun(run).catch(error => console.error(error.message));
    for (const session of sessions.values()) session.client.child?.stdin.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
