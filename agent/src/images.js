/**
 * 系统镜像管理：下载 Zorin OS ISO（多镜像源 + 断点续传 + SHA256 校验）、
 * 创建 qcow2 虚拟磁盘、以及「一键准备」把两者串起来并写好配置。
 *
 * 镜像源与校验和均为实测所得（详见 CATALOG 注释）：所有直链都返回
 * `Accept-Ranges: bytes`，因此支持断点续传。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { ensureDir, humanBytes, pathExists } from './util.js';

/**
 * 内置镜像目录。
 *
 * 免版权顾虑说明：这里只登记官方公开的下载地址与官方公布的 SHA256 校验和，
 * 不做镜像托管、不改动文件内容。
 *
 * 已实测（2026-10 校验）：
 *   · 三个镜像源均返回 200，Zorin-OS-18.1-Core-64-bit.iso = 3,909,091,328 字节
 *   · 均带 `Accept-Ranges: bytes`，支持断点续传
 */
export const CATALOG = [
  {
    id: 'zorin-18.1-core',
    name: 'Zorin OS 18.1 Core',
    edition: 'Core',
    version: '18.1',
    arch: 'x86_64',
    filename: 'Zorin-OS-18.1-Core-64-bit.iso',
    sizeBytes: 3909091328,
    sizeText: '约 3.6 GiB',
    sha256: '44649b97bd307fc4c8529205d098ebbf98575a1e1ba2ee7d7005b697af1721d5',
    recommended: true,
    note: '免费版，含 4 种基础桌面布局，日常使用首选',
    mirrors: [
      'https://mirrors.nju.edu.cn/zorinos/18/',
      'https://mirror.sjtu.edu.cn/zorinos-isos/18/',
      'https://mirrors.edge.kernel.org/zorinos-isos/18/',
      'https://mirror.kakao.com/Linux/zorinos/18/',
    ],
  },
  {
    id: 'zorin-18.1-lite',
    name: 'Zorin OS 18.1 Lite',
    edition: 'Lite',
    version: '18.1',
    arch: 'x86_64',
    filename: 'Zorin-OS-18.1-Lite-64-bit.iso',
    sizeBytes: null,
    sizeText: '约 3.7 GiB',
    sha256: 'b29ff7674cabb3d0698bdd0b39c1dbfc9def15f84d4a396de1ace1454c1e7a6d',
    recommended: false,
    note: '轻量版（XFCE），对 CPU / 内存要求更低，虚拟机里更流畅',
    mirrors: [
      'https://mirrors.nju.edu.cn/zorinos/18/',
      'https://mirror.sjtu.edu.cn/zorinos-isos/18/',
      'https://mirrors.edge.kernel.org/zorinos-isos/18/',
    ],
  },
  {
    id: 'zorin-18.1-education',
    name: 'Zorin OS 18.1 Education',
    edition: 'Education',
    version: '18.1',
    arch: 'x86_64',
    filename: 'Zorin-OS-18.1-Education-64-bit.iso',
    sizeBytes: null,
    sizeText: '约 7.5 GiB',
    sha256: 'f24b83bc1bf4f90618fb56e817fe3c1e67328e68720a8350131080db38bf9437',
    recommended: false,
    note: '教育版，预装教学软件，体积最大',
    mirrors: [
      'https://mirrors.nju.edu.cn/zorinos/18/',
      'https://mirror.sjtu.edu.cn/zorinos-isos/18/',
      'https://mirrors.edge.kernel.org/zorinos-isos/18/',
    ],
  },
];

const USER_AGENT = 'cloudlinux-agent/0.1 (+https://github.com/wangyvqian)';
const REDIRECT_LIMIT = 6;
const PROGRESS_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 30000;
// 算实时速度用滑动窗口。用“累计平均”会在刚启动时严重低估速度，
// 导致 ETA 显示成好几个小时，吓人且不准。
const SPEED_WINDOW_MS = 6000;

/** 构造一个带标记的“已取消”错误，方便上层区分取消与真失败。 */
function makeCancelledError(message) {
  const err = new Error(message);
  err.cancelled = true;
  err.statusCode = 499;
  return err;
}

/* ------------------------------------------------------------------ */
/* HTTP 辅助                                                           */
/* ------------------------------------------------------------------ */

/** 发起 GET 并跟随重定向，返回 { res, url }。start>0 时请求断点续传。 */
function openStream(url, { start = 0, redirects = 0, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
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
    const mod = parsed.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': USER_AGENT, Accept: '*/*' };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const req = mod.get(parsed, { headers, timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve(openStream(new URL(res.headers.location, parsed).toString(),
          { start, redirects: redirects + 1, timeoutMs }));
        return;
      }
      resolve({ req, res, url: parsed.toString(), status });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

/** 探测远端文件的大小与是否支持断点续传；HEAD 不行就退回 Range GET。 */
export async function probeRemote(url) {
  const attempt = (method) => new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ ok: false, error: '地址不合法' });
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': USER_AGENT };
    if (method === 'GET') headers.Range = 'bytes=0-0';
    const req = mod.request(parsed, { method, headers, timeout: PROBE_TIMEOUT_MS }, (res) => {
      const status = res.statusCode || 0;
      // 重定向：交给 openStream 处理更省事
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ ok: false, redirect: true });
      }
      const contentRange = res.headers['content-range'];
      const total = contentRange
        ? Number(String(contentRange).split('/')[1]) || Number(res.headers['content-length']) || 0
        : Number(res.headers['content-length']) || 0;
      const ranges = String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes'
        || status === 206;
      res.resume();
      resolve({ ok: status >= 200 && status < 300 || status === 206, status, sizeBytes: total || null, resumable: ranges });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '探测超时' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });

  const head = await attempt('HEAD');
  if (head.ok) return { ...head, effectiveUrl: url };
  if (head.redirect) {
    // 跟随一次重定向后再探测
    try {
      const { res, url: finalUrl } = await openStream(url);
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

/** 流式计算文件 SHA256。 */
async function hashFile(filePath, onProgress) {
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
/* 镜像管理器                                                          */
/* ------------------------------------------------------------------ */

export class ImageManager {
  constructor({ config, logger, events, vm } = {}) {
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.vm = vm;
    this.active = null;      // 当前任务快照（同时只允许一个）
    this._control = null;    // 内部控制句柄：{ cancelled, destroy }
    this._busy = false;      // 同步忙锁：异步方法体在第一个 await 前是同步执行的，用它防竞态
    this.lastResult = null;  // 上一次任务的结果（UI 会显示“上次结果”）
    this._seq = 0;           // 结果序号，方便判断“是不是新结果”
    this._probeCache = new Map();
  }

  get imagesConfig() {
    return this.config.get().images || {};
  }

  /** 默认下载目录。 */
  get downloadDir() {
    return this.imagesConfig.downloadDir || path.join(this.config.dataDir, 'images');
  }

  catalog() {
    return CATALOG.map((entry) => ({
      ...entry,
      url: entry.mirrors[this.preferredMirrorIndex(entry)] + entry.filename,
    }));
  }

  preferredMirrorIndex(entry) {
    const preferred = Number(this.imagesConfig.preferredMirror) || 0;
    return Math.min(Math.max(0, preferred), entry.mirrors.length - 1);
  }

  find(id) {
    return CATALOG.find((entry) => entry.id === id) || null;
  }

  status() {
    return {
      active: this.active,
      lastResult: this.lastResult,
      downloadDir: this.downloadDir,
      diskSizeGb: this.imagesConfig.diskSizeGb || 32,
    };
  }

  /** 记录一次任务结果（成功 / 失败 / 取消）。 */
  _record(result) {
    this._seq += 1;
    this.lastResult = {
      ...result,
      seq: this._seq,
      finishedAt: new Date().toISOString(),
    };
    return this.lastResult;
  }

  _report(patch) {
    this.active = { ...(this.active || {}), ...patch, updatedAt: new Date().toISOString() };
    this.events?.broadcast('image-progress', this.active);
  }

  _fail(message) {
    this.active = null;
    this._control = null;
    this._record({ kind: 'download', ok: false, error: message });
    this.events?.broadcast('image', { type: 'failed', error: message });
  }

  /** 取消当前任务（已下载的分片会保留，方便续传）。 */
  cancel() {
    if (!this._control) return false;
    this._control.cancelled = true;
    try { this._control.destroy?.(); } catch { /* ignore */ }
    return true;
  }

  /* ------------------------- 本地 ISO 扫描 ------------------------- */

  async listLocal({ dir } = {}) {
    const target = dir || this.downloadDir;
    if (!(await pathExists(target))) return { dir: target, items: [] };
    let entries = [];
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      return { dir: target, items: [], error: err.message };
    }

    // 把 .iso 和 .iso.part 分开收集：下到一半的 ISO 也要在界面上可见
    const isos = new Set();
    const partials = new Map(); // iso 名 -> .part 完整路径
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (/\.iso$/i.test(entry.name)) isos.add(entry.name);
      else if (/\.part$/i.test(entry.name)) partials.set(entry.name.replace(/\.part$/i, ''), path.join(target, entry.name));
    }

    const items = [];
    for (const name of new Set([...isos, ...partials.keys()])) {
      const complete = isos.has(name);
      const full = path.join(target, name);
      let sizeBytes = 0;
      let mtime = null;
      if (complete) {
        try {
          const stat = await fsp.stat(full);
          sizeBytes = stat.size;
          mtime = stat.mtime.toISOString();
        } catch { /* 读不到就当不存在 */ }
      }

      const partialPath = partials.get(name) || null;
      let partialBytes = 0;
      if (partialPath) {
        try { partialBytes = (await fsp.stat(partialPath)).size; } catch { partialBytes = 0; }
      }

      const known = CATALOG.find((c) => c.filename === name);
      const expectedBytes = known?.sizeBytes || null;
      items.push({
        name,
        path: full,
        exists: complete,
        // 没下完、但有分片 → UI 应显示“未完成，可续传”
        incomplete: !complete && partialBytes > 0,
        sizeBytes,
        sizeText: complete ? humanBytes(sizeBytes) : null,
        mtime,
        catalogId: known?.id || null,
        partialPath,
        partialBytes,
        partialText: partialBytes ? humanBytes(partialBytes) : null,
        expectedBytes,
        expectedText: expectedBytes ? humanBytes(expectedBytes) : null,
        partialPercent: expectedBytes && partialBytes
          ? Math.min(100, (partialBytes / expectedBytes) * 100)
          : null,
      });
    }

    return {
      dir: target,
      items: items.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || ''))),
    };
  }

  /* ------------------------- 下载 ------------------------- */

  /**
   * 下载 ISO。支持断点续传与 SHA256 校验。
   *
   * 注意：整个过程可能持续几十分钟到几小时，HTTP 接口请不要直接 await 它，
   * 用 startDownload() 让它在后台跑，进度通过 SSE 汇报。
   * @param {{id?:string,url?:string,destDir?:string,mirrorIndex?:number,verify?:boolean,resume?:boolean}} options
   */
  async download(options = {}) {
    if (this._busy) {
      const err = new Error('已有镜像任务在进行中，请先取消或等待完成');
      err.statusCode = 409;
      throw err;
    }
    this._busy = true;
    // 控制句柄必须在第一个 await 之前建好，否则“探测阶段”就没法取消
    this._control = { cancelled: false, destroy: null };
    try {
      return await this._download(options);
    } finally {
      this._busy = false;
      this.active = null;
      this._control = null;
    }
  }

  /** 后台启动下载，立即返回；进度与结果都通过 SSE 推送。 */
  startDownload(options = {}) {
    if (this._busy) {
      const err = new Error('已有镜像任务在进行中，请先取消或等待完成');
      err.statusCode = 409;
      throw err;
    }
    this._report({
      kind: 'download', phase: 'queued', filename: '准备中…',
      bytes: 0, total: null, speed: 0, etaSec: null,
    });
    this.download(options).catch((err) => {
      // 失败/取消已在各分支里广播过事件，这里只落日志
      if (!err?.cancelled) this.logger?.error('images', `后台下载任务结束（异常）：${err.message}`);
    });
    return { started: true, message: '下载已在后台开始，进度会实时推送到控制台' };
  }

  /** 后台启动「一键准备」，立即返回。 */
  startPrepare(options = {}) {
    if (this._busy) {
      const err = new Error('已有镜像任务在进行中，请先取消或等待完成');
      err.statusCode = 409;
      throw err;
    }
    this._report({ kind: 'prepare', phase: 'queued', filename: '准备中…', bytes: 0, total: null });
    this.prepare(options)
      .then((result) => {
        this.active = null;
        this._report({ kind: 'prepare', phase: 'done', result });
      })
      .catch((err) => {
        if (!err?.cancelled) this.logger?.error('images', `一键准备失败：${err.message}`);
      });
    return { started: true, message: '一键准备已在后台开始：下载 → 建盘 → 写配置' };
  }

  async _download({ id, url: rawUrl, destDir, mirrorIndex, verify = true, resume = true, expectSha256 = null } = {}) {
    let entry = null;
    let sourceUrl = rawUrl;
    if (id) {
      entry = this.find(id);
      if (!entry) {
        const err = new Error(`未知的镜像 id：${id}`);
        err.statusCode = 404;
        throw err;
      }
      const index = Math.min(
        Math.max(0, Number.isFinite(mirrorIndex) ? Number(mirrorIndex) : this.preferredMirrorIndex(entry)),
        entry.mirrors.length - 1,
      );
      sourceUrl = entry.mirrors[index] + entry.filename;
    }
    if (!sourceUrl) {
      const err = new Error('必须提供镜像 id 或直链 url');
      err.statusCode = 400;
      throw err;
    }

    const targetDir = destDir ? path.resolve(destDir) : this.downloadDir;
    await ensureDir(targetDir);

    const filename = entry?.filename
      || path.basename(new URL(sourceUrl).pathname)
      || `image-${Date.now()}.iso`;
    const finalPath = path.join(targetDir, filename);
    const partPath = `${finalPath}.part`;

    // 已经下好了？
    if (await pathExists(finalPath)) {
      const stat = await fsp.stat(finalPath);
      const expected = entry?.sizeBytes;
      if (!expected || stat.size === expected) {
        this.logger?.info('images', `${filename} 已存在（${humanBytes(stat.size)}），跳过下载`);
        const skipped = {
          skipped: true,
          path: finalPath,
          filename,
          sizeBytes: stat.size,
          sizeText: humanBytes(stat.size),
        };
        // 即使跳过也要记录结果并广播，否则界面上点“下载”会毫无反应
        this._record({
          kind: 'download', ok: true, skipped: true, filename,
          path: finalPath, sizeBytes: stat.size, sizeText: humanBytes(stat.size),
          verified: null,
        });
        this.events?.broadcast('image', { type: 'skipped', result: skipped });
        return skipped;
      }
      this.logger?.warn('images', `${filename} 已存在但大小不符（${stat.size} ≠ ${expected}），继续走下载流程`);
    }

    // 探测远端：拿总大小、确认能否续传
    this._report({
      kind: 'download', phase: 'probing', filename, source: sourceUrl,
      bytes: 0, total: entry?.sizeBytes || null, speed: 0, etaSec: null,
    });
    const remote = await probeRemote(sourceUrl);
    if (!remote.ok) {
      this._fail(`无法访问镜像源：${remote.error || `HTTP ${remote.status}`}`);
      const err = new Error(`无法访问镜像源：${remote.error || `HTTP ${remote.status}`}`);
      err.statusCode = 502;
      throw err;
    }

    const totalBytes = remote.sizeBytes || entry?.sizeBytes || null;

    const control0 = this._control;
    if (control0?.cancelled) throw makeCancelledError('下载已取消');

    // 续传起点
    let start = 0;
    if (resume && await pathExists(partPath)) {
      start = (await fsp.stat(partPath)).size;
      if (totalBytes && start >= totalBytes) {
        this.logger?.warn('images', '分片已完整，直接进入校验');
      }
    }
    if (start > 0 && !remote.resumable) {
      this.logger?.warn('images', '镜像源不支持断点续传，将从头下载');
      start = 0;
    }

    this._control = this._control || { cancelled: false, destroy: null };
    const control = this._control;

    this._report({
      kind: 'download', phase: 'downloading', filename, source: sourceUrl,
      bytes: start, total: totalBytes, speed: 0, etaSec: null, resumedFrom: start || null,
    });
    this.logger?.info('images',
      `开始下载 ${filename}${start ? `（从 ${humanBytes(start)} 续传）` : ''} → ${finalPath}`);
    this.events?.broadcast('image', { type: 'started', filename, source: sourceUrl });

    const startedAt = Date.now();
    let bytes = start;
    let lastTick = 0;
    let samples = [{ t: startedAt, b: start }]; // 滑动窗口样本

    try {
      const { res, url: effectiveUrl } = await openStream(sourceUrl, { start });
      const status = res.statusCode || 0;

      if (status !== 200 && status !== 206) {
        res.resume();
        throw new Error(`镜像源返回 HTTP ${status}`);
      }
      // 请求了续传但服务端返回 200 → 只能从头来
      if (start > 0 && status === 200) {
        this.logger?.warn('images', '服务端忽略 Range 请求，重新开始下载');
        start = 0;
        bytes = 0;
      }

      const remaining = Number(res.headers['content-length']) || 0;
      const total = totalBytes || (start + remaining) || null;
      this._report({ total });

      const file = createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' });

      await new Promise((resolve, reject) => {
        // 销毁流不一定触发 'error'，所以必须自己保证 Promise 一定会 settle，
        // 否则任务会卡死、忙锁不释放（后续请求全部 409）。
        let settled = false;
        const done = (fn, arg) => {
          if (settled) return;
          settled = true;
          fn(arg);
        };
        const abort = () => done(reject, makeCancelledError('下载已取消'));

        control.destroy = () => {
          try { res.destroy(); } catch { /* ignore */ }
          try { file.destroy(); } catch { /* ignore */ }
          abort();
        };

        res.on('data', (chunk) => {
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
            const etaSec = (total && speed > 0) ? Math.max(0, (total - bytes) / speed) : null;
            this._report({
              phase: 'downloading', bytes, total,
              bytesText: humanBytes(bytes),
              speed: Math.round(speed), speedText: `${humanBytes(speed)}/s`,
              etaSec: etaSec === null ? null : Math.round(etaSec),
              percent: total ? Math.min(100, (bytes / total) * 100) : null,
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

      if (control.cancelled) throw new Error('已取消');

      // 大小校验
      const stat = await fsp.stat(partPath);
      if (total && stat.size !== total) {
        throw new Error(`下载不完整：${humanBytes(stat.size)} / ${humanBytes(total)}`);
      }

      // SHA256 校验：内置目录条目自带校验和；自定义链接可用 expectSha256 传入
      const customSha = typeof expectSha256 === 'string' && expectSha256.trim()
        ? expectSha256.trim().toLowerCase()
        : null;
      const expectedSha = entry?.sha256 || customSha;
      if (verify && expectedSha) {
        this._report({ phase: 'verifying', bytes: 0, total: stat.size, hashedBytes: 0, percent: 0 });
        this.logger?.info('images', `正在校验 SHA256（${humanBytes(stat.size)}）…`);
        let lastHashTick = 0;
        const actualSha = await hashFile(partPath, (done) => {
          const now = Date.now();
          if (now - lastHashTick < PROGRESS_INTERVAL_MS) return;
          lastHashTick = now;
          this._report({
            phase: 'verifying', hashedBytes: done, total: stat.size,
            percent: Math.min(100, (done / stat.size) * 100),
          });
        });
        if (actualSha !== expectedSha) {
          const err = new Error(`SHA256 校验失败！期望 ${expectedSha.slice(0, 16)}…，实际 ${actualSha.slice(0, 16)}…。`
            + '文件可能损坏或镜像源内容有变动，请换一个镜像源重试。');
          err.detail = { expected: expectedSha, actual: actualSha };
          // 校验失败的残片没有续传价值，删掉避免下次误判
          await fsp.rm(partPath, { force: true });
          throw err;
        }
        this.logger?.info('images', 'SHA256 校验通过 ✓');
      } else if (verify && !expectedSha) {
        this.logger?.warn('images', '没有可用的校验和，跳过 SHA256 校验（自定义链接请自行确认来源可信）');
      }

      await fsp.rename(partPath, finalPath);
      const durationMs = Date.now() - startedAt;
      const avgSpeed = durationMs > 0 ? (stat.size - start) / (durationMs / 1000) : 0;

      const result = {
        ok: true,
        path: finalPath,
        filename,
        sizeBytes: stat.size,
        sizeText: humanBytes(stat.size),
        sha256: expectedSha || null,
        verified: Boolean(verify && expectedSha),
        source: effectiveUrl,
        durationMs,
        avgSpeedText: `${humanBytes(avgSpeed)}/s`,
        downloadedBytes: stat.size - start,
      };
      this.logger?.info('images',
        `下载完成 ${filename}：${humanBytes(stat.size)}，用时 ${(durationMs / 1000).toFixed(1)}s，平均 ${result.avgSpeedText}`);
      this.active = null;
      this._control = null;
      this._record({
        kind: 'download', ok: true, filename, path: finalPath,
        sizeBytes: stat.size, sizeText: humanBytes(stat.size),
        verified: result.verified, sha256: result.sha256,
      });
      this.events?.broadcast('image', { type: 'finished', result });
      return result;
    } catch (err) {
      const cancelled = control.cancelled;
      const partial = await pathExists(partPath);
      const partialSize = partial ? (await fsp.stat(partPath)).size : 0;

      if (cancelled) {
        this.logger?.warn('images', `下载已取消，已保存 ${humanBytes(partialSize)} 分片，下次可续传`);
        this.active = null;
        this._control = null;
        this._record({
          kind: 'download', ok: false, cancelled: true, filename,
          partialBytes: partialSize, partialText: humanBytes(partialSize),
        });
        this.events?.broadcast('image', {
          type: 'cancelled', filename, partialPath: partial ? partPath : null, partialBytes: partialSize,
        });
        const cancelErr = new Error(`下载已取消（已保留 ${humanBytes(partialSize)}，下次可续传）`);
        cancelErr.statusCode = 499;
        cancelErr.cancelled = true;
        throw cancelErr;
      }
      this.logger?.error('images', `下载失败：${err.message}`);
      this._fail(err.message);
      const wrapped = new Error(`下载失败：${err.message}`);
      wrapped.statusCode = err.statusCode || 500;
      wrapped.detail = err.detail;
      throw wrapped;
    }
  }

  /** 删除未完成的下载分片。 */
  async deletePartial({ path: targetPath }) {
    const clean = String(targetPath || '').trim();
    if (!clean) {
      const err = new Error('请提供分片路径');
      err.statusCode = 400;
      throw err;
    }
    // 只允许删 .part，避免误删正式文件
    if (!/\.part$/i.test(clean)) {
      const err = new Error('只允许删除以 .part 结尾的未完成分片');
      err.statusCode = 400;
      throw err;
    }
    if (!(await pathExists(clean))) return { deleted: false, path: clean };
    const stat = await fsp.stat(clean);
    await fsp.rm(clean, { force: true });
    this.logger?.info('images', `已删除分片 ${clean}（${humanBytes(stat.size)}）`);
    return { deleted: true, path: clean, freedBytes: stat.size, freedText: humanBytes(stat.size) };
  }

  /* ------------------------- 磁盘 ------------------------- */

  /** 用 qemu-img 创建 qcow2 虚拟磁盘。 */
  async createDisk({ path: diskPath, sizeGb = 32, force = false, format = 'qcow2' } = {}) {
    const clean = String(diskPath || '').trim();
    if (!clean) {
      const err = new Error('请提供磁盘镜像路径');
      err.statusCode = 400;
      throw err;
    }
    const size = Math.min(4096, Math.max(4, Math.round(Number(sizeGb) || 32)));
    const resolved = path.resolve(clean);

    if (await pathExists(resolved)) {
      if (!force) {
        const stat = await fsp.stat(resolved);
        this.logger?.info('images', `磁盘已存在：${resolved}（${humanBytes(stat.size)}）`);
        return { created: false, path: resolved, sizeBytes: stat.size, sizeText: humanBytes(stat.size) };
      }
      await fsp.rm(resolved, { force: true });
    }

    const detection = await this.vm.detect();
    if (!detection.qemuImgPath) {
      const err = new Error('未找到 qemu-img，无法创建磁盘。请先安装 QEMU。');
      err.statusCode = 503;
      throw err;
    }

    await ensureDir(path.dirname(resolved));
    this._report({ kind: 'create-disk', phase: 'creating', filename: path.basename(resolved), diskPath: resolved });
    this.logger?.info('images', `创建虚拟磁盘 ${resolved}（${size} GB，${format}）…`);

    await new Promise((resolve, reject) => {
      execFile(detection.qemuImgPath, ['create', '-f', format, resolved, `${size}G`],
        { timeout: 120000, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.toString().trim() || error.message));
            return;
          }
          resolve(stdout);
        });
    });

    // qcow2 是稀疏文件，逻辑大小和占用空间不是一个概念，两个都报
    const stat = await fsp.stat(resolved);
    const info = await new Promise((resolve) => {
      execFile(detection.qemuImgPath, ['info', '--output=json', resolved],
        { timeout: 30000, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(null);
          try { resolve(JSON.parse(stdout.toString())); } catch { resolve(null); }
        });
    });

    this.active = null;
    const result = {
      created: true,
      path: resolved,
      format,
      virtualSizeBytes: info?.['virtual-size'] || size * 1024 ** 3,
      virtualSizeText: humanBytes(info?.['virtual-size'] || size * 1024 ** 3),
      onDiskBytes: stat.size,
      onDiskText: humanBytes(stat.size),
    };
    this.logger?.info('images', `磁盘已创建：${resolved}（逻辑 ${result.virtualSizeText}）`);
    this.events?.broadcast('image', { type: 'disk-created', result });
    return result;
  }

  /* ------------------------- 一键准备 ------------------------- */

  /**
   * 一键准备：下载 ISO → 创建磁盘 → 写入配置（启用虚拟机 + 设为安装盘）。
   * 任意一步失败都会中断并返回已完成的部分。
   */
  async prepare({
    id, url, mirrorIndex, isoDir, diskPath, diskSizeGb,
    verify = true, setInstaller = true, startVm = false,
  } = {}) {
    if (this._busy) {
      const err = new Error('已有镜像任务在进行中，请先取消或等待完成');
      err.statusCode = 409;
      throw err;
    }
    this._busy = true;
    this._control = { cancelled: false, destroy: null };
    try {
      return await this._prepare({
        id, url, mirrorIndex, isoDir, diskPath, diskSizeGb, verify, setInstaller, startVm,
      });
    } finally {
      this._busy = false;
      this.active = null;
      this._control = null;
    }
  }

  async _prepare({
    id, url, mirrorIndex, isoDir, diskPath, diskSizeGb,
    verify = true, setInstaller = true, startVm = false,
  } = {}) {
    const steps = [];
    const targetIsoDir = isoDir ? path.resolve(isoDir) : this.downloadDir;

    let entry = null;
    if (id) {
      entry = this.find(id);
      if (!entry) {
        const err = new Error(`未知的镜像 id：${id}`);
        err.statusCode = 404;
        throw err;
      }
    }

    // 解析磁盘路径：没给就用 <ISO目录>/<版本>-<时间戳>.qcow2
    const resolvedDisk = diskPath
      ? path.resolve(diskPath)
      : path.join(targetIsoDir,
        `${(entry?.id || 'custom')}-${new Date().toISOString().slice(0, 10)}.qcow2`);

    // 1) 下载（这里直接 await 内部实现，因为 _busy 已经由外层占用）
    const iso = await this._download({ id, url, destDir: targetIsoDir, mirrorIndex, verify });
    steps.push({
      step: 'download',
      status: iso.skipped ? 'skipped' : 'ok',
      message: iso.skipped
        ? `ISO 已存在：${iso.path}`
        : `下载完成：${iso.sizeText}${iso.verified ? '（校验通过）' : ''}`,
      data: iso,
    });

    // 2) 建盘
    const disk = await this.createDisk({ path: resolvedDisk, sizeGb: diskSizeGb });
    steps.push({
      step: 'create-disk',
      status: disk.created ? 'ok' : 'skipped',
      message: disk.created ? `磁盘已创建：${disk.virtualSizeText}` : `磁盘已存在：${disk.path}`,
      data: disk,
    });

    // 3) 写配置
    const patch = { vm: { enabled: true, imagePath: disk.path } };
    if (setInstaller) patch.vm.installerIso = iso.path;
    await this.config.patch(patch);
    steps.push({
      step: 'configure',
      status: 'ok',
      message: setInstaller
        ? '已写入配置：镜像 + 安装盘 + 启用虚拟机'
        : '已写入配置：镜像 + 启用虚拟机',
    });

    this.logger?.info('images',
      `一键准备完成：ISO=${iso.path}，磁盘=${disk.path}，下一步点「启动」即可进入安装程序`);

    const result = {
      ok: true,
      iso: { path: iso.path, filename: iso.filename, sizeText: iso.sizeText, verified: iso.verified },
      disk: { path: disk.path, virtualSizeText: disk.virtualSizeText, created: disk.created },
      installerIso: setInstaller ? iso.path : '',
      steps,
      nextSteps: [
        '点「启动」拉起虚拟机，首次会从 ISO 引导进入 Zorin OS 安装程序。',
        '在客户机里完成安装（建议选「擦除磁盘并安装」，因为这是一块空盘）。',
        '安装完成后回到这里点「安装已完成」，助手会自动取消 ISO 引导，之后就从硬盘启动了。',
      ],
    };

    if (startVm) {
      try {
        await this.vm.start();
        result.started = true;
      } catch (err) {
        result.started = false;
        result.startError = err.message;
      }
    }

    this.events?.broadcast('image', { type: 'prepared', result });
    return result;
  }

  /** 安装完成后：取消 ISO 引导，改为从硬盘启动。 */
  async finishInstall() {
    const vm = this.config.get().vm;
    const had = vm.installerIso;
    if (!had) {
      return { changed: false, message: '当前没有配置安装 ISO，无需处理' };
    }
    await this.config.patch({ vm: { installerIso: '' } });
    this.logger?.info('images', '已取消 ISO 引导，下次启动将从硬盘引导');
    const result = {
      changed: true,
      removedIso: had,
      message: had
        ? '已取消 ISO 引导。虚拟机需要重启后生效（如果正在运行，请点「重启」）。'
        : '无需处理',
      needRestart: Boolean(this.vm.state === 'running'),
    };
    this.events?.broadcast('image', { type: 'install-finished', result });
    return result;
  }
}
