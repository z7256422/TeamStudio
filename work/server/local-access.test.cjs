const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { route, runs } = require('../agent-manager-server.cjs');

function rawRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

function firstStreamChunk(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, response => {
      response.setEncoding('utf8');
      response.once('data', chunk => {
        settled = true;
        resolve({ status: response.statusCode, headers: response.headers, chunk });
        request.destroy();
        response.destroy();
      });
      response.once('error', error => { if (!settled) reject(error); });
    });
    request.once('error', error => { if (!settled) reject(error); });
    request.end();
  });
}

test('所有控制接口、SSE 和 OPTIONS 拒绝外站及 null Origin，不能用伪造 Host 绕过', async t => {
  const server = http.createServer(route); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const origin of ['https://attacker.example', 'null', 'http://localhost:9876']) {
    for (const [method, path] of [['GET', '/api/health'], ['GET', '/api/conversations'], ['GET', '/api/config'], ['GET', '/api/events'],
      ['GET', '/api/messages/stream'], ['GET', '/api/runs/fake/events'], ['GET', '/api/sessions'], ['POST', '/api/approvals/fake/respond'],
      ['POST', '/api/runs'], ['POST', '/api/sessions/fake/turns'], ['POST', '/api/codex/skills'], ['DELETE', '/api/conversations'], ['OPTIONS', '/api/runs']]) {
      const response = await fetch(base + path, { method, headers: { origin } });
      assert.equal(response.status, 403, method + path + origin);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
  // fetch/undici normalizes the connection Host and cannot exercise the DNS-rebinding guard.
  // Use a raw HTTP request so the server really receives the forged Host header.
  const rebound = await rawRequest(server.address().port, '/api/health', { Host: `rebind.example:${server.address().port}`, origin: `http://rebind.example:${server.address().port}` });
  assert.equal(rebound.status, 403);
  assert.equal((await fetch(base + '/api/health', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const local = await fetch(base + '/api/health', { headers: { origin: base } });
  assert.equal(local.status, 200); assert.equal(local.headers.get('access-control-allow-origin'), base);
  assert.equal(local.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(base + '/api/health')).status, 200, '本机原生客户端兼容');
  const preflight = await fetch(base + '/api/runs', { method: 'OPTIONS', headers: { origin: base } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), base);
  const stream = await firstStreamChunk(server.address().port, '/api/messages/stream');
  assert.equal(stream.status, 200);
  assert.match(stream.chunk, /: connected/);
  assert.equal(runs.size, 0, '被拒绝的请求没有启动任务');
});
