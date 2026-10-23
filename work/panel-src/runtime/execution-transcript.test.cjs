const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executionTranscriptBlocks, executionCommandPreview, executionOperationStatus } = require('./execution-transcript.js');
test('按时间穿插正文与命令，只合并相邻命令，保留失败和工具记录', () => {
  const messages = [{ id: 'progress', text: '检查完成', startedAt: 30 }, { id: 'result', text: '交付结果', startedAt: 60, phase: 'final_answer' }];
  const steps = [{ id: 'b', label: '执行命令', startedAt: 20, status: 'failed', exitCode: 1 }, { id: 'a', label: '执行命令', startedAt: 10 },
    { id: 'c', label: '执行命令', startedAt: 40 }, { id: 'tool', label: '调用工具', startedAt: 50 }];
  const before = JSON.stringify({ messages, steps });
  const blocks = executionTranscriptBlocks(messages, steps);
  assert.deepEqual(blocks.map(block => block.kind), ['commands', 'message', 'commands', 'operation', 'message']);
  assert.deepEqual(blocks[0].entries.map(entry => entry.id), ['step-a', 'step-b']);
  assert.equal(blocks[0].entries[1].exitCode, 1);
  assert.equal(JSON.stringify({ messages, steps }), before);
  assert.equal(executionTranscriptBlocks(messages, [...steps, { id: 'new', label: '执行命令', startedAt: 25 }])[0].id, blocks[0].id);
});
test('缺少时间的旧合并输出仍显示，不伪造时间或打乱有效时间', () => {
  const blocks = executionTranscriptBlocks([{ id: 'legacy', text: 'old', legacy: true }], [{ id: 'a', label: '执行命令', time: 1 }]);
  assert.equal(blocks[0].kind, 'commands'); assert.equal(blocks[1].label, '历史合并输出'); assert.equal(blocks[1].time, undefined);
  assert.deepEqual(executionTranscriptBlocks(), []);
});
test('命令摘要简化启动包装，完整命令及退出失败状态保留', () => {
  const command = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content work/server.cjs"';
  assert.equal(executionCommandPreview(command), 'Get-Content work/server.cjs');
  assert.equal(executionCommandPreview('node --test ./test/example.cjs'), 'node --test ./test/example.cjs');
  assert.equal(executionCommandPreview('echo powershell.exe -Command "not a wrapper"'), 'echo powershell.exe -Command "not a wrapper"');
  assert.equal(executionTranscriptBlocks([], [{ detail: command, label: '执行命令' }])[0].entries[0].detail, command);
  assert.equal(executionOperationStatus({ status: 'done', exitCode: 1 }), 'failed');
  assert.equal(executionOperationStatus({ status: 'running' }), 'running');
  assert.equal(executionOperationStatus({ status: 'cancelled' }), 'cancelled');
});
