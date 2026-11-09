import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TicketAgent } from './agent-core.mjs';
import { BrowserDriver } from './agent-browser.mjs';

const WEB_FILES = new Set(['index.html', 'app.js', 'agent-ui.js', 'styles.css', 'sw.js', 'pulse-mark.svg', 'manifest.webmanifest', 'demo.html']);
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', webmanifest: 'application/manifest+json' };

export function createApp(agent, { port = 4180 } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Host rejected' });
    const url = new URL(req.url, origin);
    try {
      if (url.pathname.startsWith('/api/')) {
        if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '请从本机代理控制台操作。' });
        if (req.method === 'GET' && url.pathname === '/api/session') return send(200, { token, version: 4 });
        const candidate = String(req.headers['x-pulse-key'] || '');
        if (candidate.length !== token.length || !timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) return send(403, { error: '本机代理会话已失效，请刷新页面。' });
        if (req.method === 'GET' && url.pathname === '/api/jobs') return send(200, { jobs: agent.list() });
        if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) return send(405, { error: 'Unsupported request' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16384) return send(413, { error: '请求内容过长。' });
        }
        const data = JSON.parse(body || '{}');
        if (url.pathname === '/api/jobs') return send(201, { job: agent.create(data) });
        const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/(inspect|arm|cancel|approve-origin)$/);
        if (!match) return send(404, { error: 'Not found' });
        const [, id, action] = match;
        const result = action === 'inspect' ? await agent.inspect(id)
          : action === 'arm' ? agent.arm(id, data.mappings)
          : action === 'approve-origin' ? await agent.approveOrigin(id, data.origin)
          : agent.cancel(id);
        return send(200, { job: result });
      }
      if (req.method !== 'GET') return send(405, { error: 'Method not allowed' });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!WEB_FILES.has(file)) return send(404, { error: 'Not found' });
      const bytes = await readFile(new URL(`./${file}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': MIME[file.split('.').pop()] || 'application/octet-stream' });
      res.end(bytes);
    } catch (error) {
      send(400, { error: error instanceof SyntaxError ? '请求格式无效。' : String(error.message).slice(0, 200) });
    }
  });
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { console.error('请先运行 npm install 安装 Playwright。'); process.exit(1); }
  const driver = new BrowserDriver(chromium);
  const agent = new TicketAgent(driver, { allowDemo: true });
  const server = createApp(agent);
  const timer = setInterval(() => agent.tick().catch(() => {}), 250);
  server.listen(4180, '127.0.0.1', () => {
    console.log('PULSE 本机代理已运行：http://127.0.0.1:4180');
    console.log('关闭网页后预约继续；退出本程序或电脑休眠会停止执行。资料只保存在内存。');
  });
  const stop = () => { clearInterval(timer); server.close(); driver.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
