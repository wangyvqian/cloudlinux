/**
 * 通用文件下载器：重定向跟随、断点续传、滑动窗口测速、SHA256 校验。
 *
 * 镜像（images.js）和 QEMU（qemu.js）共用它，避免两套重复的下载逻辑。
 * 全局同一时刻只允许一个任务（busy 锁），并发调用会拿到 409。
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { openTunnel, shouldBypassProxy } from './proxy.js';
import { humanBytes, pathExists } from './util.js';

const USER_AGENT = 'cloudlinux-agent/0.1 (+https://github.com/wangyvqian/cloudlinux)';
const REDIRECT_LIMIT = 6;
const PROGRESS_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 30000;
// 实时速度用滑动窗口。用累计平均会在刚启动时严重低估，把 ETA 算成好几个小时。
const SPEED_WINDOW_MS = 6000;
// 多久没收到数据就判定为“停滞”。给得宽一点，慢速下载本来就是一分几十 KB。
const STALL_TIMEOUT_MS = 180000;

/** 构造带标记的「已取消」错误，便于上层区分取消与真失败。 */
export function makeCancelledError(message = '任务已取消') {
  const err = new Error(message);
  err.cancelled = true;
  err.statusCode = 499;
  return err;
}

function busyError() {
  const err = new Error('已有下载任务在进行中，请先取消或等待完成');
  err.statusCode = 409;
  return err;
}

/* ------------------------------------------------------------------ */
/* HTTP 基础                                                           */
/* ------------------------------------------------------------------ */

/**
 * 发起 GET 并跟随重定向。start>0 时带 Range 头请求续传。
 *
 * proxyUrl 不为空时：HTTP 目标改写为向代理发绝对 URL；HTTPS 目标先建
 * CONNECT 隧道再做 TLS（Node 原生不支持 HTTPS 走代理，只能自己建）。
 */
export function openStream(url, {
  start = 0, redirects = 0, timeoutMs = PROBE_TIMEOUT_MS, proxyUrl = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > REDIRECT_LIMIT) {
      reject(new Error('重定向次数过多，已放弃'));
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`地址不合法：${url}`));
      return;
    }

    const useProxy = proxyUrl && !shouldBypassProxy(parsed.hostname);
    const headers = { 'User-Agent': USER_AGENT, Accept: '*/*' };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const finish = (res) => {
      const status = res.statusCode || 0;
      // 响应头一到就撤掉连接超时。之前一直挂着 30 秒超时，
      // 结果慢速下载中途一停顿就被白自干掉（报 "aborted"）。
      // 下载过程中的「停滞」由 download() 里的看门狗单独负责。
      try { res.req?.setTimeout(0); } catch { /* ignore */ }
      try { res.socket?.setTimeout(0); } catch { /* ignore */ }
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve(openStream(new URL(res.headers.location, parsed).toString(),
          { start, redirects: redirects + 1, timeoutMs, proxyUrl }));
        return;
      }
      resolve({ req: res.req, res, url: parsed.toString(), status, viaProxy: Boolean(useProxy) });
    };

    const onError = (err) => reject(err);

    if (useProxy && parsed.protocol === 'https:') {
      // HTTPS → 先 CONNECT 打隧道，再在隧道上发请求
      openTunnel(proxyUrl, parsed.hostname, Number(parsed.port) || 443,
        { timeoutMs, servername: parsed.hostname })
        .then((socket) => {
          const req = https.request({
            host: parsed.hostname,
            port: Number(parsed.port) || 443,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers,
            createConnection: () => socket,
          }, finish);
          req.setTimeout(timeoutMs, () => req.destroy(new Error('连接超时')));
          req.on('error', onError);
          req.end();
        })
        .catch(onError);
      return;
    }

    if (useProxy) {
      // HTTP → 直接把绝对 URL 发给代理
      const proxy = new URL(proxyUrl);
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port) || 8080,
        path: parsed.toString(),
        method: 'GET',
        headers: { ...headers, Host: parsed.host },
      }, finish);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('连接超时')));
      req.on('error', onError);
      req.end();
      return;
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(parsed, { headers, timeout: timeoutMs }, finish);
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', onError);
  });
}

/** 探测远端：大小、是否支持断点续传。HEAD 不行就退回 Range GET。 */
export async function probeRemote(url, { proxyUrl = null, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const attempt = (method) => new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ ok: false, error: '地址不合法' });
    }
    const useProxy = proxyUrl && !shouldBypassProxy(parsed.hostname);
    const headers = { 'User-Agent': USER_AGENT };
    if (method === 'GET') headers.Range = 'bytes=0-0';

    const handle = (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ ok: false, redirect: true });
      }
      const contentRange = res.headers['content-range'];
      const total = contentRange
        ? Number(String(contentRange).split('/')[1]) || Number(res.headers['content-length']) || 0
        : Number(res.headers['content-length']) || 0;
      const resumable = String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes'
        || status === 206;
      res.resume();
      resolve({ ok: (status >= 200 && status < 300) || status === 206, status, sizeBytes: total || null, resumable });
    };

    const done = (req) => {
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: '探测超时' }); });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.end();
    };

    try {
      if (useProxy && parsed.protocol === 'https:') {
        openTunnel(proxyUrl, parsed.hostname, Number(parsed.port) || 443,
          { timeoutMs, servername: parsed.hostname })
          .then((socket) => {
            const req = https.request({
              host: parsed.hostname,
              port: Number(parsed.port) || 443,
              path: parsed.pathname + parsed.search,
              method,
              headers,
              createConnection: () => socket,
            }, handle);
            done(req);
          })
          .catch((err) => resolve({ ok: false, error: err.message }));
        return;
      }
      if (useProxy) {
        const proxy = new URL(proxyUrl);
        const req = http.request({
          host: proxy.hostname,
          port: Number(proxy.port) || 8080,
          path: parsed.toString(),
          method,
          headers: { ...headers, Host: parsed.host },
        }, handle);
        done(req);
        return;
      }
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(parsed, { method, headers, timeout: timeoutMs }, handle);
      done(req);
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });

  const head = await attempt('HEAD');
  if (head.ok) return { ...head, effectiveUrl: url, viaProxy: Boolean(proxyUrl) };
  if (head.redirect) {
    try {
      const { res, url: finalUrl } = await openStream(url, { proxyUrl, timeoutMs });
      const total = Number(res.headers['content-length']) || null;
      const resumable = String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
      res.resume();
      return { ok: true, status: res.statusCode, sizeBytes: total, resumable, effectiveUrl: finalUrl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  const get = await attempt('GET');
  return { ...get, effectiveUrl: url };
}

/** 流式计算文件 SHA256，onProgress 收到已处理的字节数。 */
export async function hashFile(filePath, onProgress) {
  const hash = createHash('sha256');
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let done = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      done += bytesRead;
      onProgress?.(done);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/* ------------------------------------------------------------------ */
/* 下载器                                                              */
/* ------------------------------------------------------------------ */

export class FileDownloader {
  constructor({ logger } = {}) {
    this.logger = logger;
    this._control = null;   // { cancelled, destroy }
    this._busy = false;
    this.proxyUrl = null;   // 由 setProxy() 注入；null = 直连
  }

  /**
   * 设置代理。传 null 表示直连。
   */
  setProxy(url) {
    const next = url || null;
    if (this.proxyUrl !== next) {
      this.logger?.info('download', next ? `下载将经代理：${next}` : '下载将直连（未使用代理）');
    }
    this.proxyUrl = next;
    return this;
  }

  /**
   * 设置代理解析器。
   * 每次任务开始前都会调一次 —— 因为用户可能在助手运行期间才把加速器打开，
   * 只靠启动时解析一次的话就必须重启助手才生效。
   * @param {() => Promise<string|null>} fn
   */
  setProxyResolver(fn) {
    this._resolveProxy = typeof fn === 'function' ? fn : null;
    return this;
  }

  /** 任务开始前刷新一次代理。解析失败就沿用上一个值，不阻断下载。 */
  async refreshProxy() {
    if (!this._resolveProxy) return this.proxyUrl;
    try {
      const url = await this._resolveProxy();
      this.setProxy(url || null);
    } catch (err) {
      this.logger?.warn('download', `代理探测失败，沿用上次设置：${err.message}`);
    }
    return this.proxyUrl;
  }

  get busy() {
    return this._busy;
  }

  /** 取消当前任务。已下载的分片会保留，下次可续传。 */
  cancel() {
    if (!this._control) return false;
    this._control.cancelled = true;
    try { this._control.destroy?.(); } catch { /* ignore */ }
    return true;
  }

  /**
   * 下载一个文件。
   *
   * @param {object} options
   * @param {string} options.url
   * @param {string} options.destPath            最终落盘路径（下载中写 <destPath>.part）
   * @param {boolean} [options.resume=true]      是否尝试断点续传
   * @param {number|null} [options.expectedSize]  预期大小（用于完整性判断）
   * @param {string|null} [options.sha256]        期望的 SHA256；校验失败会删掉分片
   * @param {boolean} [options.trustExisting=false] 已存在且大小相符时直接跳过
   * @param {(p:object)=>void} [options.onProgress]
   * @returns {Promise<object>}
   */
  async download({
    url, destPath, resume = true, expectedSize = null,
    sha256 = null, trustExisting = false, onProgress, stallTimeoutMs = null,
  } = {}) {
    if (!url) {
      const err = new Error('缺少下载地址');
      err.statusCode = 400;
      throw err;
    }
    if (!destPath) {
      const err = new Error('缺少落盘路径');
      err.statusCode = 400;
      throw err;
    }
    if (this._busy) throw busyError();

    this._busy = true;
    // 控制句柄必须在第一个 await 之前建好，否则“探测阶段”就没法取消
    this._control = { cancelled: false, destroy: null };
    const control = this._control;

    // 每次任务前重新解析代理（加速器可能刚被打开/关闭）
    await this.refreshProxy();

    const partPath = `${destPath}.part`;
    const report = (patch) => onProgress?.({ ...patch });

    try {
      // 已经下好了？
      if (trustExisting && await pathExists(destPath)) {
        const stat = await fsp.stat(destPath);
        if (!expectedSize || stat.size === expectedSize) {
          return {
            skipped: true, path: destPath, sizeBytes: stat.size,
            sizeText: humanBytes(stat.size), sha256: null,
          };
        }
        this.logger?.warn('download', `${path.basename(destPath)} 大小不符（${stat.size} ≠ ${expectedSize}），重新下载`);
      }

      report({ phase: 'probing', bytes: 0, total: expectedSize, percent: null });
      const remote = await probeRemote(url, { proxyUrl: this.proxyUrl });
      if (!remote.ok) {
        const err = new Error(`无法访问下载地址：${remote.error || `HTTP ${remote.status}`}`);
        err.statusCode = 502;
        throw err;
      }
      if (control.cancelled) throw makeCancelledError();

      const total = remote.sizeBytes || expectedSize || null;

      // 续传起点
      let start = 0;
      if (resume && await pathExists(partPath)) {
        start = (await fsp.stat(partPath)).size;
        if (total && start > total) {
          this.logger?.warn('download', '分片比远端还大，丢弃后重新下载');
          await fsp.rm(partPath, { force: true });
          start = 0;
        }
      }
      if (start > 0 && !remote.resumable) {
        this.logger?.warn('download', '服务端不支持断点续传，从头下载');
        start = 0;
      }

      report({
        phase: 'downloading', bytes: start, total,
        speed: 0, speedText: '', etaSec: null, resumedFrom: start || null,
        percent: total ? (start / total) * 100 : null,
        viaProxy: Boolean(this.proxyUrl),
      });

      const startedAt = Date.now();
      let bytes = start;
      let lastTick = 0;
      const samples = [{ t: startedAt, b: start }];

      const { res, url: effectiveUrl } = await openStream(url, { start, proxyUrl: this.proxyUrl });
      const status = res.statusCode || 0;
      if (status !== 200 && status !== 206) {
        res.resume();
        throw new Error(`服务端返回 HTTP ${status}`);
      }

      // 停滞看门狗：连接断开有时不会报错，只是永远没数据。
      // 用独立定时器而不是 socket 超时，这样「慢但正常」的下载不会被误杀。
      let lastDataAt = Date.now();
      const stallMs = Math.max(30000, Number(stallTimeoutMs) || STALL_TIMEOUT_MS);
      const watchdog = setInterval(() => {
        const idle = Date.now() - lastDataAt;
        if (idle > stallMs) {
          try { res.destroy(new Error(`下载停滞：已 ${Math.round(idle / 1000)} 秒没有收到数据`)); } catch { /* ignore */ }
        }
      }, 5000);
      // 请求了续传但服务端返回 200 → 只能从头来
      let effectiveStart = start;
      if (start > 0 && status === 200) {
        this.logger?.warn('download', '服务端忽略了 Range 请求，重新开始下载');
        effectiveStart = 0;
        bytes = 0;
        samples.length = 0;
        samples.push({ t: Date.now(), b: 0 });
      }

      const remaining = Number(res.headers['content-length']) || 0;
      const total2 = total || (effectiveStart + remaining) || null;

      const file = createWriteStream(partPath, { flags: effectiveStart > 0 ? 'a' : 'w' });

      // 注意：clearInterval 必须放在 finally 里。放 await 之后的话，
      // 一旦下载失败/被中断就会跳过去，看门狗会一直跑（泄漏定时器）。
      try {
        await new Promise((resolve, reject) => {
        // 销毁流不一定触发 'error'，必须自己保证 Promise 一定会 settle，
        // 否则任务会卡死、busy 锁不释放（后续请求全部 409）。
        let settled = false;
        const done = (fn, arg) => {
          if (settled) return;
          settled = true;
          fn(arg);
        };
        const abort = () => done(reject, makeCancelledError());

        control.destroy = () => {
          try { res.destroy(); } catch { /* ignore */ }
          try { file.destroy(); } catch { /* ignore */ }
          abort();
        };

        res.on('data', (chunk) => {
          lastDataAt = Date.now();
          bytes += chunk.length;
          if (!file.write(chunk)) {
            res.pause();
            file.once('drain', () => res.resume());
          }
          const now = Date.now();
          if (now - lastTick >= PROGRESS_INTERVAL_MS) {
            lastTick = now;
            samples.push({ t: now, b: bytes });
            while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift();
            const oldest = samples[0];
            const span = (now - oldest.t) / 1000;
            const speed = span > 0.5 ? (bytes - oldest.b) / span : 0;
            const etaSec = (total2 && speed > 0) ? Math.max(0, (total2 - bytes) / speed) : null;
            report({
              phase: 'downloading', bytes, total: total2,
              bytesText: humanBytes(bytes),
              speed: Math.round(speed),
              speedText: speed > 0 ? `${humanBytes(speed)}/s` : '',
              etaSec: etaSec === null ? null : Math.round(etaSec),
              percent: total2 ? Math.min(100, (bytes / total2) * 100) : null,
            });
          }
        });

        res.on('end', () => file.end(() => done(resolve)));
        res.on('error', (err) => done(reject, err));
        res.on('close', () => {
          if (control.cancelled) abort();
          else if (!res.complete) done(reject, new Error('连接被提前关闭，下载不完整'));
        });
        file.on('error', (err) => done(reject, err));
        file.on('close', () => { if (control.cancelled) abort(); });
        });
      } finally {
        clearInterval(watchdog);
      }

      if (control.cancelled) throw makeCancelledError();

      // 大小校验
      const stat = await fsp.stat(partPath);
      if (total2 && stat.size !== total2) {
        throw new Error(`下载不完整：${humanBytes(stat.size)} / ${humanBytes(total2)}`);
      }

      // SHA256 校验
      let actualSha = null;
      if (sha256) {
        report({ phase: 'verifying', bytes: 0, total: stat.size, hashedBytes: 0, percent: 0 });
        let lastHashTick = 0;
        actualSha = await hashFile(partPath, (doneBytes) => {
          const now = Date.now();
          if (now - lastHashTick < PROGRESS_INTERVAL_MS) return;
          lastHashTick = now;
          report({
            phase: 'verifying', hashedBytes: doneBytes, total: stat.size,
            percent: Math.min(100, (doneBytes / stat.size) * 100),
          });
        });
        if (actualSha !== sha256.toLowerCase()) {
          const err = new Error('SHA256 校验失败！期望 '
            + `${sha256.slice(0, 16)}…，实际 ${actualSha.slice(0, 16)}…。`
            + '文件可能损坏或源内容有变动，请换一个源重试。');
          err.detail = { expected: sha256, actual: actualSha };
          // 校验失败的残片没有续传价值，删掉避免下次误判
          await fsp.rm(partPath, { force: true });
          throw err;
        }
      }

      await fsp.rename(partPath, destPath);
      const durationMs = Date.now() - startedAt;
      const avg = durationMs > 0 ? (stat.size - effectiveStart) / (durationMs / 1000) : 0;
      return {
        ok: true,
        path: destPath,
        filename: path.basename(destPath),
        sizeBytes: stat.size,
        sizeText: humanBytes(stat.size),
        sha256: actualSha,
        verified: Boolean(sha256),
        source: effectiveUrl,
        downloadedBytes: stat.size - effectiveStart,
        resumedFrom: effectiveStart || null,
        durationMs,
        avgSpeedText: `${humanBytes(avg)}/s`,
      };
    } finally {
      this._busy = false;
      this._control = null;
    }
  }
}
