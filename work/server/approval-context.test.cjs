const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rememberApprovalContext, approvalParams } = require('./approval-context.cjs');
const { emitRun, publicRun, runs } = require('../agent-manager-server.cjs');
const request = { method: 'item/fileChange/requestApproval', requestId: '1', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', reason: '需要文件权限' } };
const changed = (path = 'C:/project/file.js', diff = '+const value = 1;') => ({ type: 'provider_event', method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'fileChange', changes: [{ path, kind: { type: 'add' }, diff }] } } });
test('关联路径与 diff 在事件日志淘汰后仍可从审批接口读取，不改写引擎请求', t => {
  const run = { id: 'approval-test', status: 'running', threadId: 'thread', turnId: 'turn', approvals: new Map(), events: [], subscribers: new Set() };
  runs.set(run.id, run); t.after(() => runs.delete(run.id));
  emitRun(run, changed());
  run.approvals.set('1', { ...request, runId: run.id });
  for (let i = 0; i < 210; i++) emitRun(run, { type: 'tool_output', delta: 'output' });
  assert.equal(run.events.some(event => event.method === 'item/started'), false);
  const p = publicRun(run).approvals[0].params;
  assert.equal(p.changes[0].path, 'C:/project/file.js'); assert.equal(p.changes[0].diff, '+const value = 1;');
  assert.equal(request.params.changes, undefined);
});
test('相同 item id 不跨成员、线程、轮次串用；缺失时明确说明', () => {
  const a = { threadId: 'thread', turnId: 'turn' }, b = { threadId: 'thread', turnId: 'turn' };
  rememberApprovalContext(a, changed('a.js')); rememberApprovalContext(b, changed('b.js'));
  assert.equal(approvalParams(a, request).changes[0].path, 'a.js'); assert.equal(approvalParams(b, request).changes[0].path, 'b.js');
  for (const scope of [{ turnId: 'other' }, { threadId: 'other' }, { itemId: null }]) {
    assert.equal(approvalParams(a, { ...request, params: { ...request.params, ...scope } }).changesUnavailable, true);
  }
  const stale = changed('wrong.js'); stale.params.turnId = 'other'; rememberApprovalContext(a, stale);
  assert.equal(approvalParams(a, request).changes[0].path, 'a.js');
});
test('审批先到时允许后续事件补全；有请求原始差异时优先保留', () => {
  const run = { threadId: 'thread', turnId: 'turn' };
  assert.equal(approvalParams(run, request).changesUnavailable, true);
  rememberApprovalContext(run, changed()); assert.ok(approvalParams(run, request).changes.length);
  const changes = [{ path: 'new.js', diff: '+new' }];
  assert.equal(approvalParams(run, { ...request, params: { ...request.params, changes } }).changes, changes);
});
