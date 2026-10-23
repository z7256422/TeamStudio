/* Markdown 浏览器夹具：仅内存记录 + 生产路由，不启动模型、不读写用户历史。 */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { route, runs, emitRun } = require('../agent-manager-server.cjs');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../outputs/example-team.json'), 'utf8'));
const agent = config.teams[0].agents[0];
const report = [
  '## 综述', '',
  '项目是自研的 **本机 Agent 协同控制台**，由浏览器面板、Node 本机控制面与 Codex 执行引擎组成。', '',
  '### 项目结构', '',
  '- `work/`：源代码与执行引擎适配。',
  '  - `server/`：团队调度、成员反馈与历史恢复。',
  '  - `panel-src/`：状态、组件、办公室与对话展示。',
  '- `outputs/`：离线界面和团队导出模板。', '',
  '### 检查结果', '',
  '| 模块 | 检查结果 | 建议 |', '| --- | --- | --- |',
  '| 团队调度 | **通过** | 保留事件唤醒机制 |',
  '| 对话展示 | 已修复 | 支持 Markdown 与流式更新 |', '',
  '> 检查采用只读方式，结论基于实际记录。', '',
  '1. 读取项目结构。', '2. 检查成员执行。', '3. 输出分析报告。', '',
  '- [x] 历史与新消息共用排版', '- [ ] 后续按需求扩展', '',
  '### 验证命令', '', '```powershell', 'node --test work/panel-src/runtime/markdown.test.cjs',
  'Write-Output "' + 'long-code-'.repeat(35) + '"', '```', '',
  '[查看文档](https://example.com/docs) · ~~旧的纯文本展示~~ 已替换。', '',
  '普通文本第一行\n普通文本第二行', '',
  '<script>window.markdownUnsafe = true</script>',
  '<img src="/unexpected-image-request" onerror="window.markdownUnsafe=true">', '',
  '[危险链接](javascript:alert%281%29) ![远程图片](https://example.com/preview.png)'
].join('\n');
const create = (id, goal, createdAt) => ({ id, agentId: agent.id, adapter: 'codex-app-server', threadId: id + '-thread', turnId: id + '-turn',
  model: 'default', cwd: process.cwd(), goal, createdAt, startedAt: createdAt, status: 'running',
  context: { taskId: id + '-task', taskTitle: goal, roundId: id + '-round', agentName: agent.name, agentRole: agent.role,
    teamId: config.teams[0].id, teamName: config.teams[0].team.name, source: { kind: 'user' }, dispatchMode: 'current' },
  settings: { sandbox: 'danger-full-access' }, events: [], approvals: new Map(), subscribers: new Set() });
const history = create('markdown-history', '分析项目结构并输出 **Markdown 报告**', new Date(Date.now() - 60000).toISOString());
history.settings.management = { deliveryMode: 'report', members: [agent] };
history.delivery = { status: 'completed', mode: 'report', summary: report, artifacts: [], verification: ['**验证通过**：标题、列表和表格。'] };
runs.set(history.id, history);
emitRun(history, { type: 'reasoning_summary', stage: 'completed', itemId: 'history-analysis', summary: ['**检查方向**\n\n- 先阅读结构\n- 再整理报告'] });
emitRun(history, { type: 'provider_event', method: 'item/completed', params: { item: { id: 'history-tool', type: 'commandExecution', command: 'echo "**日志原文**"', aggregatedOutput: '## literal log\n<script>literal</script>', exitCode: 0 } } });
emitRun(history, { type: 'provider_event', method: 'item/completed', params: { item: { id: 'history-reply', type: 'agentMessage', phase: 'final_answer', text: report } } });
history.status = 'completed'; emitRun(history, { type: 'completed', status: 'completed' });
const stream = create('markdown-stream', '验证 Markdown 流式输出', new Date().toISOString());
runs.set(stream.id, stream);
emitRun(stream, { type: 'started' });
emitRun(stream, { type: 'reasoning_summary', stage: 'delta', itemId: 'stream-analysis', summaryIndex: 0, delta: '**检查方向**\n\n- 接收公开摘要\n- 验证显示状态' });
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ data })); };
let stage = 0;
const chunks = ['## 实时报告\n\n**正在检查**\n\n```js\nconst value = ', '1;\n```\n\n| 检查项 | 结果 |\n| --- | --- |\n| 流式显示 | 通过 |\n\n**完成**'];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/fixture/config') return json(res, config);
  if (url.pathname === '/api/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, providers: [{ id: 'codex-app-server', kind: 'codex', label: '本机 Codex', status: 'available' }] })); }
  if (['/api/codex/skills', '/api/codex/mcp'].includes(url.pathname)) return json(res, []);
  if (url.pathname === '/fixture/update' && req.method === 'POST') {
    if (stage >= chunks.length) return json(res, { message: '流式夹具已结束' }, 409);
    emitRun(stream, { type: 'message_delta', itemId: 'stream-reply', delta: chunks[stage++] });
    if (stage === chunks.length) { stream.status = 'completed'; emitRun(stream, { type: 'completed', status: 'completed' }); }
    return json(res, { stage });
  }
  if (req.method === 'POST') return json(res, { message: '夹具禁止启动任务或发送真实消息' }, 405);
  return route(req, res);
});
server.listen(33217, '127.0.0.1', () => console.log('Markdown fixture: http://127.0.0.1:33217'));
