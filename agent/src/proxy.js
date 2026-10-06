/**
 * 代理支持。
 *
 * 为什么需要这个：Node 的 http/https 模块**不会**使用系统代理，
 * 所以用户开着加速器（Clash / v2ray 之类）时，助手的下载依然走直连，
 * 在连 GitHub、qemu.weilnetz.de 这类境外源时会慢到几乎不可用。
 *
 * 这里做三件事：
 *   1. 解析代理地址：配置 → 环境变量 → Windows 系统代理（注册表）
 *   2. 提供 HTTP 代理的请求路径改写
 *   3. 提供 HTTPS 代理的 CONNECT 隧道（Node 原生不支持，得自己建）
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';

const TUNNEL_TIMEOUT_MS = 15000;

/** 常见的本地代理端口（Clash / v2ray / SS 等）。 */
const COMMON_PROXY_PORTS = [7897, 7890, 10809, 1080, 7891, 8889, 2080];

/** 把错误标记成「代理问题」，上层可以据此回退直连重试。 */
function markProxyError(err, message) {
  const wrapped = new Error(message);
  wrapped.isProxyError = true;
  wrapped.cause = err;
  return wrapped;
}

/* ------------------------------------------------------------------ */
/* 解析代理地址                                                        */
/* ------------------------------------------------------------------ */

function normalizeProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  // 允许写成 "127.0.0.1:7897"
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (!url.hostname) return null;
    if (!url.port) url.port = '8080';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** 读取 Windows 系统代理（Internet Settings 注册表项）。 */
function readWindowsSystemProxy() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer',
    ], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      const m = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(stdout.toString());
      if (!m) return resolve(null);
      // 可能是 "http=127.0.0.1:7897;https=127.0.0.1:7897" 这种分协议格式
      const value = m[1].trim();
      const httpsPart = /https=([^;]+)/i.exec(value);
      const httpPart = /http=([^;]+)/i.exec(value);
      resolve((httpsPart?.[1] || httpPart?.[1] || value).trim());
    });
  });
}

/** ProxyEnable 是否为 1。 */
function isWindowsProxyEnabled() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyEnable',
    ], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout) return resolve(false);
      const m = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout.toString());
      resolve(Boolean(m) && parseInt(m[1], 16) === 1);
    });
  });
}

/**
 * 解析出该用的代理。
 *
 * @param {object} options
 * @param {string} [options.setting] 配置值：`auto`（默认，自动探测）| `off` | 具体地址
 * @param {object} [options.logger]
 * @returns {Promise<{url:string|null, source:string, detail:string}>}
 */
export async function resolveProxy({ setting = 'auto', logger, verify = true } = {}) {
  const clean = String(setting ?? 'auto').trim();

  if (clean === 'off' || clean === 'none' || clean === 'false') {
    return { url: null, source: 'disabled', detail: '已手动关闭代理' };
  }

  // 按优先级收集候选，再逐个验证可达性
  const candidates = [];

  if (clean && clean !== 'auto' && clean !== 'true') {
    const url = normalizeProxyUrl(clean);
    if (url) candidates.push({ url, source: 'config', detail: '来自配置 network.proxy' });
    else logger?.warn('proxy', `配置里的代理地址无法解析：${clean}，将改为自动探测`);
  }

  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) {
    const url = normalizeProxyUrl(envProxy);
    if (url) candidates.push({ url, source: 'env', detail: '来自环境变量 HTTPS_PROXY/HTTP_PROXY' });
  }

  if (await isWindowsProxyEnabled()) {
    const raw = await readWindowsSystemProxy();
    const url = normalizeProxyUrl(raw);
    if (url) candidates.push({ url, source: 'system', detail: '来自 Windows 系统代理设置' });
  }

  for (const port of COMMON_PROXY_PORTS) {
    if (await isPortListening(port)) {
      candidates.push({ url: `http://127.0.0.1:${port}`, source: 'probe', detail: `自动发现本地代理端口 ${port}` });
    }
  }

  if (!candidates.length) return { url: null, source: 'none', detail: '未发现可用的代理' };
  if (!verify) return candidates[0];

  // 关键：逐个验证端口真的能连上。
  // 加速器退出时经常只关进程、把注册表留在那里，盲目使用会连累所有下载。
  const unreachable = [];
  for (const candidate of candidates) {
    if (await isProxyReachable(candidate.url)) return candidate;
    unreachable.push(candidate);
  }

  const detail = `发现 ${unreachable.length} 个代理配置但都连不上`
    + `（${unreachable.map((c) => c.url).join('、')}）`;
  logger?.warn('proxy', `${detail}，将直连。若想强制使用或关闭代理，请在设置里改「代理」选项`);
  return { url: null, source: 'unreachable', detail };
}

function isPortListening(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/* ------------------------------------------------------------------ */
/* 请求辅助                                                            */
/* ------------------------------------------------------------------ */

/** 目标地址是否应绕过代理（本机地址与已知国内镜像不该走代理）。 */
export function shouldBypassProxy(hostname, extra = []) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || h.startsWith('127.')) {
    return true;
  }
  for (const raw of extra) {
    let p = String(raw || '').toLowerCase().trim();
    if (!p) continue;
    if (p.startsWith('*.')) p = p.slice(2);
    else if (p.startsWith('.')) p = p.slice(1);
    if (!p) continue;
    if (h === p || h.endsWith('.' + p)) return true;
  }
  return false;
}

/**
 * 代理端口是否真的能连上。
 *
 * 这一步很关键：加速器退出时常常只把进程关掉，**把注册表里的 ProxyServer 留着**。
 * 盲目相信注册表就会拿一个已经死掉的代理去下载，结果是全线 ECONNREFUSED。
 */
export async function isProxyReachable(proxyUrl, { timeoutMs = 1500 } = {}) {
  try {
    const url = new URL(proxyUrl);
    return await isPortListening(Number(url.port) || 8080, url.hostname, timeoutMs);
  } catch {
    return false;
  }
}

/**
 * 为 HTTPS 建立 CONNECT 隧道。
 * @returns {Promise<import('node:tls').TLSSocket>} 已经完成 TLS 握手的 socket
 */
export function openTunnel(proxyUrl, targetHost, targetPort, {
  timeoutMs = TUNNEL_TIMEOUT_MS, servername,
} = {}) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port) || 8080,
    });

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail(markProxyError(null,
      `连接代理超时（${proxy.hostname}:${proxy.port}）`)));
    socket.once('error', (err) => fail(markProxyError(err,
      `无法连接代理 ${proxy.hostname}:${proxy.port}：${err.message}`)));

    socket.once('connect', () => {
      let auth = '';
      if (proxy.username) {
        const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`;
        auth = `Proxy-Authorization: Basic ${Buffer.from(raw).toString('base64')}\r\n`;
      }
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`
        + `Host: ${targetHost}:${targetPort}\r\n`
        + auth
        + 'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });

    // 只等响应头，之后的数据属于隧道内容
    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 8192) fail(new Error('代理返回的响应头异常'));
        return;
      }
      socket.removeListener('data', onData);
      const statusLine = head.split('\r\n')[0] || '';
      const code = Number((statusLine.match(/\s(\d{3})\s?/) || [])[1]);
      if (code !== 200) {
        fail(markProxyError(null, `代理拒绝建立隧道：${statusLine.trim() || '无响应'}`));
        return;
      }
      // 隧道通了，在其上做 TLS
      socket.setTimeout(0);
      const tlsSocket = tls.connect({
        socket,
        servername: servername || targetHost,
        rejectUnauthorized: true,
      });
      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        resolve(tlsSocket);
      });
      tlsSocket.once('error', (err) => fail(markProxyError(err, `TLS 握手失败：${err.message}`)));
    };
    socket.on('data', onData);
  });
}

/**
 * 探测代理是否真的可用（用它去连目标地址）。
 *
 * 注意：这是 ESM 模块，不能用 require()。这里统一走 openStream 那条路，
 * 让代理逻辑只在一处实现。
 * @returns {Promise<{ok:boolean, ms:number, status?:number, error?:string}>}
 */
export async function testProxy(proxyUrl, targetUrl = 'https://qemu.weilnetz.de/w64/', {
  timeoutMs = 8000,
} = {}) {
  const started = Date.now();
  let res = null;
  try {
    const target = new URL(targetUrl);
    if (target.protocol === 'https:') {
      const socket = await openTunnel(proxyUrl, target.hostname,
        Number(target.port) || 443, { timeoutMs });
      res = await new Promise((resolve, reject) => {
        const req = https.request({
          host: target.hostname,
          port: Number(target.port) || 443,
          path: target.pathname + target.search,
          method: 'GET',
          createConnection: () => socket,
          headers: { 'User-Agent': 'cloudlinux-agent', Host: target.host },
        }, resolve);
        req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时')); });
        req.on('error', reject);
        req.end();
      });
    } else {
      // HTTP 目标：直接经代理请求
      const proxy = new URL(proxyUrl);
      res = await new Promise((resolve, reject) => {
        const req = http.request({
          host: proxy.hostname,
          port: Number(proxy.port) || 8080,
          path: targetUrl,
          method: 'GET',
          headers: { 'User-Agent': 'cloudlinux-agent', Host: target.host },
        }, resolve);
        req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时')); });
        req.on('error', reject);
        req.end();
      });
    }
    const status = res.statusCode || 0;
    res.resume();
    return { ok: status >= 200 && status < 400, ms: Date.now() - started, status };
  } catch (err) {
    try { res?.destroy(); } catch { /* ignore */ }
    return { ok: false, ms: Date.now() - started, error: err.message };
  }
}
