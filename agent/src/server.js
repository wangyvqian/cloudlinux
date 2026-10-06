/**
 * HTTP 服务：路由、CORS、鉴权、SSE。
 */
import http from 'node:http';
import { escapeRegExp, HttpError, readJsonBody } from './util.js';

export const HANDLED = Symbol('response already handled');

function compilePattern(pattern) {
  const segments = pattern.split('/').filter(Boolean);
  const names = [];
  const body = segments
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return escapeRegExp(segment);
    })
    .join('/');
  return { regex: new RegExp(`^/${body}/?$`), names };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, { public: isPublic = false, raw = false, description = '' } = {}) {
    const { regex, names } = compilePattern(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern, regex, names, handler, public: isPublic, raw, description });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.regex);
      if (!m) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return null;
  }

  describe() {
    return this.routes.map((r) => ({
      method: r.method, path: r.pattern, public: r.public, description: r.description,
    }));
  }
}

export function extractToken(req, url) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = url.searchParams.get('token');
  return q ? q.trim() : '';
}

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function createAgentServer({ router, security, logger, agentName, agentVersion, events }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    try {
      // ---- 1. Host 校验（防 DNS Rebinding）----
      if (!security.isHostAllowed(req.headers.host)) {
        logger.warn('http', `拒绝非法 Host：${req.headers.host}（可能是一次 DNS Rebinding 尝试）`);
        return sendJson(res, 403, { ok: false, error: 'Host 不在白名单内', code: 'HOST_NOT_ALLOWED' });
      }

      // ---- 2. Origin 校验 + CORS ----
      const origin = req.headers.origin;
      if (origin && !security.isOriginAllowed(origin)) {
        logger.warn('http', `拒绝未授权 Origin：${origin}`);
        return sendJson(res, 403, { ok: false, error: 'Origin 不在白名单内', code: 'ORIGIN_NOT_ALLOWED' });
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      // ---- 3. 人类友好的落地页 ----
      if (url.pathname === '/' || url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'cloudlinux-agent',
          name: agentName,
          version: agentVersion,
          paired: security.isPaired,
          uptimeSec: Math.round(process.uptime()),
          message: 'CloudLinux 桌面助手正在运行。请通过网页控制台访问，或查看 /api/* 接口。',
        });
      }

      if (url.pathname === '/api/routes') {
        return sendJson(res, 200, { ok: true, data: router.describe() });
      }

      // ---- 4. 路由匹配 ----
      const matched = router.match(req.method, url.pathname);
      if (!matched) {
        return sendJson(res, 404, { ok: false, error: `未找到 ${req.method} ${url.pathname}`, code: 'NOT_FOUND' });
      }
      const { route, params } = matched;

      // ---- 5. 鉴权 ----
      if (!route.public) {
        const token = extractToken(req, url);
        const record = security.verifyToken(token);
        if (!record) {
          return sendJson(res, 401, { ok: false, error: '未配对或令牌无效，请先在控制台配对', code: 'UNAUTHORIZED' });
        }
        // 供 SSE 路由把连接和令牌绑定，撤销令牌时才能及时切断
        req.auth = record;
      }

      // ---- 6. 请求体 ----
      let body = {};
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        body = await readJsonBody(req);
      }

      // ---- 7. 执行 ----
      const result = await route.handler({ req, res, url, params, body, query: url.searchParams });

      if (result === HANDLED || route.raw || res.headersSent) return undefined;
      return sendJson(res, 200, { ok: true, data: result ?? null });
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return undefined;
      }
      const status = err instanceof HttpError ? err.statusCode : (err.statusCode || 500);
      // 只有「没被显式标记 statusCode」的错误才认为是意外 bug，才打堆栈；
      // 像「未安装 QEMU」这类预期内的 5xx 只记一行，避免刷屏。
      const expected = Boolean(err.statusCode) || err instanceof HttpError;
      if (status >= 500 && !expected) {
        logger.exception('http', err, `${req.method} ${url.pathname}`);
      } else if (status >= 500) {
        logger.error('http', `${req.method} ${url.pathname} → ${status} ${err.message}`);
      } else {
        logger.warn('http', `${req.method} ${url.pathname} → ${status} ${err.message}`);
      }
      const payload = {
        ok: false,
        error: err.message || '服务器内部错误',
        code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
      };
      if (err.detail) payload.detail = err.detail;
      return sendJson(res, status, payload);
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}
