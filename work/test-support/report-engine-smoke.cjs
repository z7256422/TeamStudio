/* 显式执行的真实引擎验证：只审查临时样例，不调用用户项目或改写用户历史。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startRun, cancelRun, sessions, runs } = require('../agent-manager-server.cjs');
if (process.env.RUN_REPORT_ENGINE_SMOKE !== '1') throw new Error('Set RUN_REPORT_ENGINE_SMOKE=1 to run this real-engine check');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-report-smoke-'));
const source = 'function normalizeName(value) { return value.trim().toUpperCase(); }\nmodule.exports = { normalizeName };\n';
fs.writeFileSync(path.join(directory, 'sample.cjs'), source);
const member = { id: 'report-smoke-pm', name: '审查经理', role: 'ProjectManager', provider: 'codex-app-server', model: 'default', cwd: directory,
  prompt: '这是临时样例的代码审查验证。读取指定文件后，简洁给出真实问题、位置及依据，不需要运行浏览器或安装依赖。' };

(async () => {
  let manager;
  try {
    manager = await startRun({ agentId: member.id, cwd: directory, approvalPolicy: 'on-request',
      goal: '审查 sample.cjs 的输入校验，只给出问题、位置和依据，不要修改文件。不调用 team_complete，直接用最终回复提交报告，以验证报告自动完成流程。',
      management: { members: [member], concurrency: 1 }, context: { taskId: 'report-smoke', agentRole: 'ProjectManager', agentName: member.name, source: { kind: 'user' } } });
    const deadline = Date.now() + 120000;
    while (!['completed', 'failed', 'cancelled'].includes(manager.status)) {
      if (manager.approvals.size) throw new Error('真实引擎请求审批，验证不自动批准');
      if (Date.now() > deadline) throw new Error('报告验证超过 120 秒');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(manager.status, 'completed', manager.error);
    assert.equal(manager.delivery.mode, 'report');
    assert.equal(manager.delivery.source, 'final-answer');
    assert.match(manager.delivery.report, /trim|undefined|null|字符串|类型|输入/i);
    assert.deepEqual(fs.readdirSync(directory), ['sample.cjs']);
    assert.equal(fs.readFileSync(path.join(directory, 'sample.cjs'), 'utf8'), source);
    assert.equal(runs.size, 1);
    console.log(JSON.stringify({ status: manager.status, mode: manager.delivery.mode, source: manager.delivery.source,
      runCount: runs.size, artifacts: manager.delivery.artifacts, projectUnchanged: true, finalReportChars: manager.delivery.report.length }));
  } finally {
    if (manager && !['completed', 'failed', 'cancelled'].includes(manager.status)) await cancelRun(manager).catch(error => console.error(error.message));
    // 只关闭本验证直接启动的引擎树，避免 Windows cmd shim 留下子进程。
    for (const { client } of sessions.values()) {
      if (client.child?.pid && client.child.exitCode === null) await new Promise((resolve, reject) => {
        const stop = spawn('taskkill.exe', ['/PID', String(client.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        stop.once('error', reject); stop.once('exit', resolve);
      });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
