// 回环监听本身不能阻止恶意网页。所有路由（包括读取、审批、SSE 和预检）共用此边界。
function assertLocalRequest(req, res) {
  const host = req.headers.host;
  let address;
  try { address = new URL(`http://${host}`); } catch { /* 下面统一拒绝畸形 Host。 */ }
  const port = req.socket?.localPort;
  if (!host || !address || address.host !== host.toLowerCase() || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
    || (port && Number(address.port || 80) !== port)) throw Object.assign(new Error('只允许通过本机服务地址访问'), { statusCode: 403 });
  const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  if ((origin && origin !== address.origin) || (site && !['same-origin', 'none'].includes(site))) {
    throw Object.assign(new Error('请从本机服务打开管理面板；不接受其他网站或本地文件页面的请求'), { statusCode: 403 });
  }
  if (res) {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  }
}
module.exports = { assertLocalRequest };
