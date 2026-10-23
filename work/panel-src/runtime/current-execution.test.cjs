const { test } = require('node:test');
const assert = require('node:assert/strict');
const { watchCurrentExecution } = require('./current-execution.js');

test('执行状态使用资源订阅并传递清理和错误', () => {
  let handler, released = false; const data = [], errors = [];
  const stop = watchCurrentExecution({ runId: 'a/b', onData: value => data.push(value), onError: error => errors.push(error),
    watchResource: (route, options) => {
      assert.equal(route, '/api/runs/a%2Fb/execution?view=compact'); handler = options;
      return () => { released = true; };
    } });
  handler.onData({ status: 'running' }); handler.onData({ status: 'completed' });
  handler.onError(new Error('offline'));
  assert.deepEqual(data.map(value => value.status), ['running', 'completed']);
  assert.match(errors[0], /执行状态同步失败：offline/);
  stop(); assert.equal(released, true);
});
