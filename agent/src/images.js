/**
 * 系统镜像管理。
 *
 * 能力：
 *  - 内置镜像目录（Zorin OS）+ 任意自定义直链（其他发行版由用户自己找镜像）
 *  - 下载：多镜像源、断点续传、SHA256 校验（下载细节在 download.js）
 *  - 一键准备：可选自装 QEMU → 下载镜像 → 建盘 → 写配置
 *  - 两种镜像都支持：
 *      · ISO（安装盘）：建空 qcow2 磁盘，从 ISO 引导装系统
 *      · 云镜像 qcow2/img/raw（免安装）：以它作后端建 qcow2 **叠加层**直接用，
 *        原始镜像保持只读不动，想重置只需删掉叠加层
 *
 * 长任务都是「后台启动 + SSE 推进度」，HTTP 接口不会阻塞。
 */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, humanBytes, pathExists } from './util.js';

/**
 * 内置镜像目录。
 *
 * 只登记官方公开的下载地址与官方公布的 SHA256 校验和，不做镜像托管、不改动文件内容。
 * 其他发行版请用「自定义镜像链接」——来源由用户自己确认最稳妥。
 *
 * 已实测（2026-10）：三个镜像源均返回 200，
 * Zorin-OS-18.1-Core-64-bit.iso = 3,909,091,328 字节，且都带 `Accept-Ranges: bytes`。
 */
export const CATALOG = [
  {
    id: 'zorin-18.1-core',
    name: 'Zorin OS 18.1 Core',
    edition: 'Core',
    version: '18.1',
    arch: 'x86_64',
    kind: 'iso',
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
    kind: 'iso',
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
    kind: 'iso',
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

/** 可直接当磁盘用的镜像扩展名 → QEMU 磁盘格式。 */
const DISK_IMAGE_FORMATS = {
  '.qcow2': 'qcow2',
  '.qemu': 'qcow2',
  '.img': 'raw',
  '.raw': 'raw',
  '.vmdk': 'vmdk',
  '.vdi': 'vdi',
  '.vhd': 'vpc',
};

/** 判断一个文件名是安装盘（ISO）还是磁盘镜像。 */
export function classifyImage(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.iso') return { kind: 'iso', format: null };
  if (ext in DISK_IMAGE_FORMATS) return { kind: 'disk', format: DISK_IMAGE_FORMATS[ext] };
  return { kind: 'other', format: null };
}

export class ImageManager {
  constructor({ config, logger, events, vm, downloader, qemu } = {}) {
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.vm = vm;
    this.downloader = downloader;
    this.qemu = qemu;
    this.active = null;
    this._busy = false;
    this.lastResult = null;
    this._seq = 0;
  }

  get imagesConfig() {
    return this.config.get().images || {};
  }

  /** 默认下载目录：便携目录里的 images/。 */
  get downloadDir() {
    return this.imagesConfig.downloadDir || this.config.imagesDir;
  }

  /** 默认磁盘目录：便携目录里的 disks/。 */
  get disksDir() {
    return this.config.disksDir;
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
      disksDir: this.disksDir,
      diskSizeGb: this.imagesConfig.diskSizeGb || 32,
    };
  }

  _record(result) {
    this._seq += 1;
    this.lastResult = { ...result, seq: this._seq, finishedAt: new Date().toISOString() };
    return this.lastResult;
  }

  _report(patch) {
    this.active = { ...(this.active || {}), ...patch, updatedAt: new Date().toISOString() };
    this.events?.broadcast('image-progress', this.active);
  }

  _fail(message) {
    this.active = null;
    this._record({ kind: 'download', ok: false, error: message });
    this.events?.broadcast('image', { type: 'failed', error: message });
  }

  cancel() {
    if (this.downloader?.busy) return this.downloader.cancel();
    if (this.qemu && ['downloading', 'installing'].includes(this.qemu.state)) return this.qemu.cancel();
    return false;
  }

  /* ------------------------- 本地扫描 ------------------------- */

  async listLocal({ dir } = {}) {
    const target = dir || this.downloadDir;
    if (!(await pathExists(target))) return { dir: target, items: [] };
    let entries = [];
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      return { dir: target, items: [], error: err.message };
    }

    // 正式文件与 .part 分片分开收集：下到一半的也要在界面上可见
    const files = new Set();
    const partials = new Map();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (/\.part$/i.test(entry.name)) {
        partials.set(entry.name.replace(/\.part$/i, ''), path.join(target, entry.name));
      } else if (classifyImage(entry.name).kind !== 'other') {
        files.add(entry.name);
      }
    }

    const items = [];
    for (const name of new Set([...files, ...partials.keys()])) {
      const complete = files.has(name);
      const full = path.join(target, name);
      const { kind, format } = classifyImage(name);

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
        kind,
        format,
        exists: complete,
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

  /** 列出便携目录里的虚拟机磁盘。 */
  async listDisks() {
    const dir = this.disksDir;
    if (!(await pathExists(dir))) return { dir, items: [] };
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return { dir, items: [], error: err.message };
    }
    const currentImage = this.config.get().vm.imagePath;
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const c = classifyImage(entry.name);
      if (c.kind !== 'disk') continue;
      const full = path.join(dir, entry.name);
      const stat = await fsp.stat(full);
      let info = null;
      try { info = await this.diskInfo(full); } catch { /* 没装 qemu-img 时读不到 */ }
      items.push({
        name: entry.name,
        path: full,
        format: c.format,
        sizeBytes: stat.size,
        sizeText: humanBytes(stat.size),
        mtime: stat.mtime.toISOString(),
        virtualSizeText: info?.virtualSizeText || null,
        backingFile: info?.backingFile || null,
        inUse: currentImage === full,
      });
    }
    return { dir, items: items.sort((a, b) => b.mtime.localeCompare(a.mtime)) };
  }

  /* ------------------------- 磁盘工具 ------------------------- */

  async _qemuImg() {
    const detection = await this.vm.detect();
    if (!detection.qemuImgPath) {
      const err = new Error('未找到 qemu-img。请先安装 QEMU（可在「QEMU」卡片里一键安装）。');
      err.statusCode = 503;
      throw err;
    }
    return detection.qemuImgPath;
  }

  _runQemuImg(bin, args, { timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.toString().trim() || error.message));
            return;
          }
          resolve(stdout.toString());
        });
    });
  }

  /** 读取磁盘信息（含后端文件与真实占用）。 */
  async diskInfo(diskPath) {
    const bin = await this._qemuImg();
    const out = await this._runQemuImg(bin, ['info', '--output=json', diskPath], { timeoutMs: 30000 });
    const info = JSON.parse(out);
    return {
      format: info.format,
      virtualSizeBytes: info['virtual-size'] || 0,
      virtualSizeText: humanBytes(info['virtual-size'] || 0),
      onDiskBytes: info['actual-size'] || 0,
      onDiskText: humanBytes(info['actual-size'] || 0),
      backingFile: info['backing-filename'] || null,
      backingFormat: info['backing-filename-format'] || null,
    };
  }

  /** 建一个空 qcow2 磁盘。 */
  async createDisk({ path: diskPath, sizeGb = 32, force = false, format = 'qcow2' } = {}) {
    const clean = String(diskPath || '').trim();
    if (!clean) {
      const err = new Error('请提供磁盘路径');
      err.statusCode = 400;
      throw err;
    }
    const size = Math.min(4096, Math.max(4, Math.round(Number(sizeGb) || 32)));
    const resolved = path.resolve(clean);

    if (await pathExists(resolved)) {
      if (!force) {
        const info = await this.diskInfo(resolved);
        this.logger?.info('images', `磁盘已存在：${resolved}`);
        return { created: false, path: resolved, ...info };
      }
      await fsp.rm(resolved, { force: true });
    }

    const bin = await this._qemuImg();
    await ensureDir(path.dirname(resolved));
    this._report({ kind: 'create-disk', phase: 'creating', filename: path.basename(resolved) });
    this.logger?.info('images', `创建虚拟磁盘 ${resolved}（${size} GB，${format}）…`);
    await this._runQemuImg(bin, ['create', '-f', format, resolved, `${size}G`]);

    const stat = await fsp.stat(resolved);
    const info = await this.diskInfo(resolved);
    this.active = null;
    const result = {
      created: true,
      path: resolved,
      format,
      virtualSizeBytes: info.virtualSizeBytes,
      virtualSizeText: info.virtualSizeText,
      onDiskBytes: stat.size,
      onDiskText: humanBytes(stat.size),
    };
    this.logger?.info('images', `磁盘已创建：${resolved}（逻辑 ${result.virtualSizeText}）`);
    this.events?.broadcast('image', { type: 'disk-created', result });
    return result;
  }

  /**
   * 以某个镜像为后端建 qcow2 叠加层。
   * 这样云镜像（.qcow2/.img）免安装就能跑，且原始镜像保持只读、可随时重置。
   */
  async createOverlay({ basePath, overlayPath, overlayFormat = 'qcow2', resizeGb = null } = {}) {
    const base = String(basePath || '').trim();
    if (!base) {
      const err = new Error('请提供基础镜像路径');
      err.statusCode = 400;
      throw err;
    }
    if (!(await pathExists(base))) {
      const err = new Error(`基础镜像不存在：${base}`);
      err.statusCode = 400;
      throw err;
    }
    const baseInfo = await this.diskInfo(base);
    const resolvedOverlay = path.resolve(overlayPath
      || path.join(this.disksDir, `${path.basename(base).replace(/\.[^.]+$/, '')}-overlay.qcow2`));

    const bin = await this._qemuImg();
    await ensureDir(path.dirname(resolvedOverlay));
    if (await pathExists(resolvedOverlay)) await fsp.rm(resolvedOverlay, { force: true });

    this._report({ kind: 'create-disk', phase: 'creating', filename: path.basename(resolvedOverlay) });
    this.logger?.info('images',
      `创建叠加层 ${resolvedOverlay}（后端 ${path.basename(base)}，格式 ${baseInfo.format}）…`);
    await this._runQemuImg(bin, [
      'create', '-f', overlayFormat,
      '-F', baseInfo.format || 'raw',
      '-b', base, resolvedOverlay,
    ]);

    // 叠加层默认继承后端大小；用户想要更大就尝试扩容（失败不影响使用）
    let resized = false;
    if (resizeGb) {
      const want = Math.min(4096, Math.max(4, Math.round(Number(resizeGb))));
      if (want * 1024 ** 3 > (baseInfo.virtualSizeBytes || 0)) {
        try {
          await this._runQemuImg(bin, ['resize', resolvedOverlay, `${want}G`], { timeoutMs: 300000 });
          resized = true;
        } catch (err) {
          this.logger?.warn('images', `扩容叠加层失败（不影响使用）：${err.message}`);
        }
      }
    }

    const info = await this.diskInfo(resolvedOverlay);
    this.active = null;
    const result = {
      created: true,
      path: resolvedOverlay,
      basePath: base,
      format: overlayFormat,
      backingFile: info.backingFile,
      virtualSizeBytes: info.virtualSizeBytes,
      virtualSizeText: info.virtualSizeText,
      resized,
    };
    this.logger?.info('images', `叠加层就绪：${resolvedOverlay}（逻辑 ${result.virtualSizeText}）`);
    this.events?.broadcast('image', { type: 'disk-created', result });
    return result;
  }

  /* ------------------------- 下载 ------------------------- */

  async download(options = {}) {
    if (this._busy) {
      const err = new Error('已有镜像任务在进行中，请先取消或等待完成');
      err.statusCode = 409;
      throw err;
    }
    this._busy = true;
    try {
      return await this._download(options);
    } finally {
      this._busy = false;
      this.active = null;
    }
  }

  startDownload(options = {}) {
    if (this._busy) {
      const err = new Error('已有镜像任务在进行中，请先取消或等待完成');
      err.statusCode = 409;
      throw err;
    }
    this._report({ kind: 'download', phase: 'queued', filename: '准备中…', bytes: 0, total: null });
    this.download(options).catch((err) => {
      if (!err?.cancelled) this.logger?.error('images', `后台下载任务结束（异常）：${err.message}`);
    });
    return { started: true, message: '下载已在后台开始，进度会实时推送到控制台' };
  }

  async _download({
    id, url: rawUrl, destDir, mirrorIndex,
    verify = true, expectSha256 = null, resume = true,
  } = {}) {
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

    let filename;
    try {
      filename = entry?.filename
        || path.basename(new URL(sourceUrl).pathname)
        || `image-${Date.now()}.iso`;
    } catch {
      const err = new Error(`地址无法解析：${sourceUrl}`);
      err.statusCode = 400;
      throw err;
    }
    const finalPath = path.join(targetDir, filename);

    const customSha = typeof expectSha256 === 'string' && expectSha256.trim()
      ? expectSha256.trim().toLowerCase()
      : null;
    const expectedSha = entry?.sha256 || customSha;
    if (verify && !expectedSha) {
      this.logger?.warn('images', '没有可用的校验和，跳过 SHA256 校验（自定义链接请自行确认来源可信）');
    }

    this.logger?.info('images', `开始下载 ${filename} → ${finalPath}`);
    this.events?.broadcast('image', { type: 'started', filename, source: sourceUrl });

    try {
      const result = await this.downloader.download({
        url: sourceUrl,
        destPath: finalPath,
        resume,
        expectedSize: entry?.sizeBytes || null,
        sha256: verify ? expectedSha : null,
        trustExisting: true,
        onProgress: (p) => this._report({
          kind: 'download', filename, source: sourceUrl, ...p,
        }),
      });

      const out = {
        ...result,
        filename,
        source: result.source || sourceUrl,
        verified: Boolean(verify && expectedSha),
        kind: classifyImage(filename).kind,
      };

      if (result.skipped) {
        this.logger?.info('images', `${filename} 已存在（${result.sizeText}），跳过下载`);
        this._record({
          kind: 'download', ok: true, skipped: true, filename,
          path: finalPath, sizeBytes: result.sizeBytes, sizeText: result.sizeText, verified: null,
        });
        this.active = null;
        this.events?.broadcast('image', { type: 'skipped', result: out });
        return out;
      }

      this.logger?.info('images',
        `下载完成 ${filename}：${result.sizeText}，用时 ${(result.durationMs / 1000).toFixed(1)}s，`
        + `平均 ${result.avgSpeedText}${out.verified ? '，SHA256 校验通过 ✓' : ''}`);
      this._record({
        kind: 'download', ok: true, filename, path: finalPath,
        sizeBytes: result.sizeBytes, sizeText: result.sizeText,
        verified: out.verified, sha256: result.sha256,
      });
      this.active = null;
      this.events?.broadcast('image', { type: 'finished', result: out });
      return out;
    } catch (err) {
      const partialPath = `${finalPath}.part`;
      const partialBytes = (await pathExists(partialPath)) ? (await fsp.stat(partialPath)).size : 0;

      if (err.cancelled) {
        this.logger?.warn('images', `下载已取消，已保存 ${humanBytes(partialBytes)} 分片，下次可续传`);
        this.active = null;
        this._record({
          kind: 'download', ok: false, cancelled: true, filename,
          partialBytes, partialText: humanBytes(partialBytes),
        });
        this.events?.broadcast('image', {
          type: 'cancelled', filename, partialPath: partialBytes ? partialPath : null, partialBytes,
        });
        throw err;
      }

      this.logger?.error('images', `下载失败：${err.message}`);
      this._fail(err.message);
      const wrapped = new Error(`下载失败：${err.message}`);
      wrapped.statusCode = err.statusCode || 500;
      wrapped.detail = err.detail;
      throw wrapped;
    }
  }

  /** 删除未完成的分片（只接受 .part，避免误删正式文件）。 */
  async deletePartial({ path: targetPath }) {
    const clean = String(targetPath || '').trim();
    if (!clean) {
      const err = new Error('请提供分片路径');
      err.statusCode = 400;
      throw err;
    }
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

  /* ------------------------- 一键准备 ------------------------- */

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
    return { started: true, message: '一键准备已在后台开始，进度会实时推送到控制台' };
  }

  async prepare(options = {}) {
    if (this._busy) {
      const err = new Error('已有镜像任务在进行中，请先取消或等待完成');
      err.statusCode = 409;
      throw err;
    }
    this._busy = true;
    try {
      return await this._prepare(options);
    } finally {
      this._busy = false;
    }
  }

  async _prepare({
    id, url, mirrorIndex, isoDir, diskPath, diskSizeGb,
    verify = true, setInstaller = true, startVm = false, installQemu = false,
  } = {}) {
    const steps = [];
    const targetImagesDir = isoDir ? path.resolve(isoDir) : this.downloadDir;

    let entry = null;
    if (id) {
      entry = this.find(id);
      if (!entry) {
        const err = new Error(`未知的镜像 id：${id}`);
        err.statusCode = 404;
        throw err;
      }
    }

    // 0) 可选：先把 QEMU 装好
    if (installQemu && this.qemu) {
      this._report({ kind: 'prepare', phase: 'downloading', filename: 'QEMU', note: '正在准备 QEMU…' });
      try {
        const q = await this.qemu.install();
        steps.push({
          step: 'install-qemu',
          status: q.skipped ? 'skipped' : 'ok',
          message: q.skipped ? `QEMU 已就绪：${q.version}` : `QEMU 已安装：${q.version}`,
          data: { version: q.version, installDir: q.installDir, qemuPath: q.qemuPath },
        });
      } catch (err) {
        steps.push({ step: 'install-qemu', status: 'failed', message: `QEMU 安装失败：${err.message}` });
        const wrapped = new Error(`QEMU 安装失败，已中止准备：${err.message}`);
        wrapped.statusCode = err.statusCode || 500;
        wrapped.steps = steps;
        throw wrapped;
      }
    }

    // 1) 下载镜像
    const iso = await this._download({ id, url, destDir: targetImagesDir, mirrorIndex, verify });
    steps.push({
      step: 'download',
      status: iso.skipped ? 'skipped' : 'ok',
      message: iso.skipped
        ? `镜像已存在：${iso.path}`
        : `下载完成：${iso.sizeText}${iso.verified ? '（SHA256 校验通过）' : ''}`,
      data: iso,
    });

    const { kind } = classifyImage(iso.filename);
    const baseName = iso.filename.replace(/\.[^.]+$/, '');
    const resolvedDisk = diskPath
      ? path.resolve(diskPath)
      : path.join(this.disksDir, `${baseName}${kind === 'disk' ? '-overlay' : ''}.qcow2`);

    // 2) 建盘：云镜像走叠加层（免安装），ISO 走空盘 + 安装
    let disk;
    if (kind === 'disk') {
      disk = await this.createOverlay({
        basePath: iso.path,
        overlayPath: resolvedDisk,
        resizeGb: diskSizeGb || null,
      });
      steps.push({
        step: 'create-overlay',
        status: 'ok',
        message: `已基于云镜像创建叠加层：${disk.virtualSizeText}（原镜像保持只读，可随时重置）`,
        data: disk,
      });
    } else {
      disk = await this.createDisk({ path: resolvedDisk, sizeGb: diskSizeGb });
      steps.push({
        step: 'create-disk',
        status: disk.created ? 'ok' : 'skipped',
        message: disk.created ? `磁盘已创建：${disk.virtualSizeText}` : `磁盘已存在：${disk.path}`,
        data: disk,
      });
    }

    // 3) 写配置
    const patch = {
      vm: {
        enabled: true,
        imagePath: disk.path,
        diskFormat: disk.format || 'qcow2',
        name: entry?.name || baseName,
        // 只有 ISO 才需要安装盘；云镜像本身就是装好的系统
        installerIso: (setInstaller && kind === 'iso') ? iso.path : '',
      },
    };
    await this.config.patch(patch);

    steps.push({
      step: 'configure',
      status: 'ok',
      message: kind === 'iso'
        ? '已写入配置：磁盘 + 安装盘 + 启用虚拟机'
        : '已写入配置：磁盘 + 启用虚拟机（云镜像免安装）',
    });

    this.logger?.info('images',
      `一键准备完成：镜像=${iso.path}，磁盘=${disk.path}，类型=${kind === 'disk' ? '云镜像(免安装)' : 'ISO(需安装)'}`);

    const result = {
      ok: true,
      kind,
      qemuReady: this.qemu ? (await this.qemu.verifyInstall()).ok : undefined,
      iso: { path: iso.path, filename: iso.filename, sizeText: iso.sizeText, verified: iso.verified },
      disk: { path: disk.path, virtualSizeText: disk.virtualSizeText, created: disk.created },
      installerIso: (setInstaller && kind === 'iso') ? iso.path : '',
      steps,
      nextSteps: kind === 'iso'
        ? [
          '点「启动」拉起虚拟机，首次会从 ISO 引导进入安装程序。',
          '在客户机里完成安装（建议选「擦除磁盘并安装」，因为这是一块空盘）。',
          '安装完成后回到这里点「安装已完成」，助手会自动取消 ISO 引导。',
        ]
        : [
          '这是云镜像，系统已经装好了 —— 直接点「启动」即可。',
          '原始镜像不会被修改，所有改动都写在叠加层里。',
          '想恢复到初始状态，只要删掉叠加层再准备一次。',
          '很多云镜像默认没有图形桌面，需要用 SSH（端口见「设置」）登录。',
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
      message: '已取消 ISO 引导。虚拟机需要重启后生效（如果正在运行，请点「重启」）。',
      needRestart: Boolean(this.vm.state === 'running'),
    };
    this.events?.broadcast('image', { type: 'install-finished', result });
    return result;
  }

  /**
   * 把已下载的镜像投入应用：
   *  · ISO → 设为安装盘
   *  · 云镜像 → 建叠加层并设为系统盘（不改动原文件）
   */
  async useLocal({ path: localPath, role } = {}) {
    const clean = String(localPath || '').trim();
    if (!clean) {
      const err = new Error('请提供镜像路径');
      err.statusCode = 400;
      throw err;
    }
    if (!(await pathExists(clean))) {
      const err = new Error(`文件不存在：${clean}`);
      err.statusCode = 400;
      throw err;
    }
    const { kind } = classifyImage(clean);

    if (role === 'installer' || (role !== 'disk' && kind === 'iso')) {
      await this.config.patch({ vm: { enabled: true, installerIso: clean } });
      return { role: 'installer', path: clean, message: '已设为安装盘，点「启动」就会从它引导' };
    }

    const overlay = await this.createOverlay({
      basePath: clean,
      overlayPath: path.join(this.disksDir, `${path.basename(clean).replace(/\.[^.]+$/, '')}-overlay.qcow2`),
    });
    await this.config.patch({
      vm: {
        enabled: true, imagePath: overlay.path, diskFormat: overlay.format, installerIso: '',
      },
    });
    return {
      role: 'disk',
      basePath: clean,
      path: overlay.path,
      message: `已基于该镜像创建叠加层并设为系统盘：${overlay.virtualSizeText}`,
    };
  }
}
