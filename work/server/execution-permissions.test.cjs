const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executionPermissions } = require('./execution-permissions.cjs');

test('新任务默认无沙箱；显式只读与工作区限制不被默认值覆盖', () => {
  const cwd = 'C:/project';
  assert.deepEqual(executionPermissions({}, cwd), { sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } });
  assert.deepEqual(executionPermissions({ sandbox: 'read-only' }, cwd), { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } });
  assert.deepEqual(executionPermissions({ sandbox: 'workspace-write' }, cwd).sandboxPolicy,
    { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false });
});

test('历史快照或调用方提供的策略可以恢复；缺失快照不扩大历史权限', () => {
  assert.deepEqual(executionPermissions({}, 'C:/project', true), {});
  const policy = { type: 'workspaceWrite', writableRoots: ['C:/explicit'], networkAccess: false };
  assert.deepEqual(executionPermissions({ sandboxPolicy: policy }, 'C:/project'), { sandbox: 'workspace-write', sandboxPolicy: policy });
  assert.equal(executionPermissions({ sandbox: 'danger-full-access' }, 'C:/project', true).sandboxPolicy.type, 'dangerFullAccess');
});

test('不允许会话与轮次策略矛盾或未知权限意外扩大访问', () => {
  assert.throws(() => executionPermissions({ sandbox: 'read-only', sandboxPolicy: { type: 'dangerFullAccess' } }, 'C:/project'), /must match/);
  assert.throws(() => executionPermissions({ sandbox: 'typo' }, 'C:/project'), /sandbox must/);
  assert.throws(() => executionPermissions({ sandboxPolicy: { type: 'typo' } }, 'C:/project'), /must match/);
});
