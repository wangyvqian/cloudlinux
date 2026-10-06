/**
 * 通用工具函数。
 */
import crypto from 'node:crypto';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把 origin 模式转成正则：`*` 匹配任意字符。
 * 例：`https://*.github.io` 能匹配 `https://user.github.io`
 */
export function matchPattern(value, pattern) {
  if (typeof value !== 'string' || typeof pattern !== 'string') return false;
  if (pattern === '*') return true;
  if (pattern.toLowerCase() === value.toLowerCase()) return true;
  const rx = new RegExp(
    '^' + pattern.split('*').map(escapeRegExp).join('.*') + '$',
    'i',
  );
  return rx.test(value);
}

/**
 * 极简 glob：支持 `*`（不跨 `/`）、`**`（跨 `/`）、`?`。
 * 用于同步任务的 exclude 列表。
 */
export function globMatch(value, pattern) {
  const normalized = String(value).replace(/\\/g, '/');
  let rx = String(pattern)
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')   // 占位，稍后处理
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp('^' + rx + '$', 'i').test(normalized);
}

export function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function timestampSlug(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** 检测某个 TCP 端口是否可连接。 */
export function isPortOpen({ host = '127.0.0.1', port, timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 轮询等待端口就绪。 */
export async function waitForPort({ host = '127.0.0.1', port, timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortOpen({ host, port })) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 等待子进程退出，返回是否按时退出。 */
export function waitForExit(child, timeoutMs = 15000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', () => finish(true));
  });
}

/** 读取 JSON 请求体，带体积上限。 */
export function readJsonBody(req, { limitBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** 安全的相对路径拼接：禁止逃逸出 baseDir。 */
export function safeJoin(baseDir, ...segments) {
  const target = path.resolve(baseDir, ...segments);
  const rel = path.relative(path.resolve(baseDir), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('非法路径'), { statusCode: 400 });
  }
  return target;
}

export class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 深合并（数组整体替换）。 */
export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (
    base && patch &&
    typeof base === 'object' && typeof patch === 'object' &&
    !(base instanceof Date) && !(patch instanceof Date)
  ) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return patch;
}

/** 从对象里挑选允许的键。 */
export function pickAllowed(source, allowed) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of allowed) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

/** 有限并发地跑一批任务。 */
export async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
