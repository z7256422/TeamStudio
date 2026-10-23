/* 对话排版夹具：内存记录 + 生产读取/SSE 路由，禁止启动引擎和写真实历史。 */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { route, runs, emitRun } = require('../agent-manager-server.cjs');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../outputs/example-team.json'), 'utf8'));
const agent = config.teams[0].agents[0], base = Date.now() - 120000;
const iso = offset => new Date(base + offset).toISOString();
const step = (id, command, offset, output = '读取完成', status = 'done', exitCode = 0) => ({ id, label: '执行命令', detail: command,
  startedAt: base + offset, time: base + offset, endedAt: status === 'running' ? null : base + offset + 1000, output, status, exitCode: status === 'running' ? null : exitCode });
const run = { id: 'transcript-layout', agentId: agent.id, adapter: 'codex-app-server', threadId: 'transcript-thread', model: 'default', cwd: process.cwd(),
  createdAt: iso(0), startedAt: iso(1000), endedAt: iso(90000), updatedAt: iso(90000), status: 'completed',
  goal: '检查工程结构并验证团队协作流程', context: { taskId: 'transcript-task', taskTitle: '检查工程结构并验证团队协作流程', agentName: agent.name, agentRole: agent.role, teamId: config.teams[0].id, teamName: config.teams[0].team.name, dispatchMode: 'current', source: { kind: 'user' } },
  settings: { sandbox: 'danger-full-access' }, events: [], subscribers: new Set(), approvals: new Map(),
  messages: [{ id: 'progress1', phase: 'commentary', startedAt: iso(2000), text: '已定位团队调度、交付验收和权限处理模块。接下来检查成员反馈与恢复会话的完整链路。' },
    { id: 'progress2', phase: 'commentary', startedAt: iso(20000), text: '成员提问与经理回复的流程已确认。现在运行构建和验证，检查输出是否完整。' },
    { id: 'result', phase: 'final_answer', startedAt: iso(80000), text: '构建通过，验证通过。团队调度与会话恢复均沿用原有事件机制。\n发现的一项测试问题已修复，详情可展开对应命令查看。' }],
  progress: { status: 'done', startedAt: base + 1000, endedAt: base + 90000, steps: [
    ...['team-coordinator', 'team-feedback', 'provider-diagnostics', 'custom-providers'].map((name, index) => step('read-' + index, `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content work/server/${name}.cjs"`, 3000 + index * 2000, Array.from({ length: 70 }, (_, i) => `第 ${i + 1} 行 · 模拟模块输出，仅用于排版验证`).join('\n'))),
    step('build', 'node work/build-panel.cjs', 21000, 'Built offline HTML: 582,042 bytes\n构建完成'),
    step('failed', 'node --test work/server/example.test.cjs', 24000, 'AssertionError: expected 2, actual 1\n测试用例未通过', 'failed', 1),
    { id: 'file', label: '修改文件', detail: 'work/server/example.cjs', startedAt: base + 27000, endedAt: base + 28000, status: 'done', output: '文件修改完成' },
    step('verify', 'node --test work/server/example.test.cjs', 30000, 'tests 12\npass 12\nfail 0')
  ] }
};
runs.set(run.id, run);
const json = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ data })); };
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/fixture/config') return json(res, config);
  if (pathname === '/api/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, providers: [{ id: 'codex-app-server', kind: 'codex', label: '本机 Codex app-server', status: 'available' }] })); }
  if (['/api/codex/skills', '/api/codex/mcp'].includes(pathname)) return json(res, []);
  if (pathname === '/fixture/update' && req.method === 'POST') {
    // 模拟已有单命令组收到新操作以及输出更新，检查展开状态是否保留。
    const last = run.progress.steps.at(-1);
    last.output += '\n新增一行输出';
    if (!run.progress.steps.some(entry => entry.id === 'extra')) run.progress.steps.push(step('extra', 'node --version', 34000, 'v24.15.0'));
    emitRun(run, { type: 'fixture_update' });
    return json(res, {});
  }
  if (req.method === 'POST') return json(res, { message: '只读排版夹具' }, 405);
  return route(req, res);
});
server.listen(33214, '127.0.0.1', () => console.log('Transcript fixture: http://127.0.0.1:33214 (no real engine)'));
