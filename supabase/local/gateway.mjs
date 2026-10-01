// 로컬 검증용 API 게이트웨이: Supabase 클라우드의 주소 구조(/auth/v1, /rest/v1)를 흉내 낸다.
// 실제 서비스에서는 쓰지 않는다.
import http from 'node:http';

const PORT = Number(process.env.GATEWAY_PORT || 54321);
const ROUTES = [
  { prefix: '/auth/v1', target: { host: '127.0.0.1', port: 9999 } },
  { prefix: '/rest/v1', target: { host: '127.0.0.1', port: 3000 } },
];
const ALLOW_HEADERS = 'authorization, apikey, content-type, x-client-info, x-supabase-api-version, prefer, accept, accept-profile, content-profile, range, x-retry-count';

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'content-range, x-supabase-api-version');
  }
}

http.createServer((req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204).end();
    return;
  }
  const route = ROUTES.find((r) => req.url === r.prefix || req.url.startsWith(r.prefix + '/') || req.url.startsWith(r.prefix + '?'));
  if (!route) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"no route"}'); return; }

  const headers = { ...req.headers, host: `${route.target.host}:${route.target.port}` };
  if (!headers.authorization && headers.apikey) headers.authorization = `Bearer ${headers.apikey}`;
  const upstream = http.request({
    ...route.target,
    method: req.method,
    path: req.url.slice(route.prefix.length) || '/',
    headers,
  }, (up) => {
    const h = { ...up.headers };
    delete h['access-control-allow-origin'];
    delete h['access-control-allow-credentials'];
    res.writeHead(up.statusCode || 502, h);
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'upstream error', detail: String(e) }));
  });
  req.pipe(upstream);
}).listen(PORT, '127.0.0.1', () => console.log(`gateway http://localhost:${PORT}`));
