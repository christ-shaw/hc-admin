const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime } = require('./runtime.cjs');
let runtime = createRuntime();
const port = Number(process.env.SF_LOCAL_PORT || 5188);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = `http://127.0.0.1:${port}`;
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
    res.writeHead(403); res.end('Local requests only'); return;
  }
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && req.url === '/state') { res.end(JSON.stringify(runtime.snapshot())); return; }
    if (req.method !== 'POST') { res.writeHead(404); res.end('{}'); return; }
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 32768) throw new Error('请求过大'); }
    const payload = JSON.parse(body || '{}');
    let result;
    if (req.url === '/reset') { runtime = createRuntime(); result = { success: true }; }
    else if (req.url === '/role') { runtime.state.role = payload.role === 'viewer' ? 'viewer' : 'admin'; result = { success: true }; }
    else if (req.url === '/timeout') { runtime.state.timeoutNextCreate = true; result = { success: true }; }
    else if (req.url === '/invoke') result = await runtime.invoke(payload.name, payload.data);
    else { res.writeHead(404); result = { success: false }; }
    res.end(JSON.stringify(result));
  } catch (error) { res.writeHead(400); res.end(JSON.stringify({ success: false, errMsg: error.message })); }
});
server.listen(port, '127.0.0.1', () => console.log(`顺丰双配置本地调试：http://127.0.0.1:${port}（模拟数据，不连接云端）`));
