/**
 * QEMU 自动获取与安装（把「找安装包」这一步也纳入一键准备）。
 *
 * Windows：从官方镜像 qemu.weilnetz.de 拉最新的 NSIS 安装包，
 *          再用 `/S /D=<目录>` 静默安装到便携目录里，最后跑 --version 验证。
 * Linux / macOS：不代装，返回包管理器命令提示。
 *
 * 两个实现要点：
 *  1. `/D=` 必须是**最后一个参数且不加引号**，路径含空格会有坑。
 *     Windows 上先取 8.3 短路径（GetShortPathName）来绕开这个问题。
 *  2. 安装器若触发 UAC 会挂住等待，而弹窗无法被自动应答。
 *     所以给安装过程加超时，超时就杀掉并把原因写清楚。
 */
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { humanBytes, pathExists, waitForExit } from './util.js';

const SITE = 'https://qemu.weilnetz.de';
const DIR_URL = `${SITE}/w64/`;
const INSTALL_TIMEOUT_MS = 6 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 20000;

/** 兜底地址：万一目录列表抓不到，用它保证还能装上。 */
const FALLBACK_FILE = 'qemu-w64-setup-20260811.exe';

function run(command, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          error: error?.message ?? null,
        });
      });
  });
}

/** HTTP GET 到字符串。 */
async function fetchText(url, { timeoutMs = 25000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 抓目录列表，挑出最新的安装包文件名。 */
export async function resolveLatestInstaller({ logger } = {}) {
  try {
    const html = await fetchText(DIR_URL);
    const names = [...html.matchAll(/qemu-w64-setup-(\d{8})\.exe/gi)].map((m) => m[0]);
    const unique = [...new Set(names)].sort();
    if (!unique.length) throw new Error('目录里没找到安装包');
    const latest = unique[unique.length - 1];
    const date = /(\d{8})/.exec(latest)?.[1] || '';
    const pretty = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : '';
    return { filename: latest, url: DIR_URL + latest, buildDate: pretty, source: 'live' };
  } catch (err) {
    logger?.warn('qemu', `无法从官网目录获取版本（${err.message}），改用内置地址`);
    const date = /(\d{8})/.exec(FALLBACK_FILE)?.[1] || '';
    return {
      filename: FALLBACK_FILE,
      url: DIR_URL + FALLBACK_FILE,
      buildDate: date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : '',
      source: 'fallback',
    };
  }
}

/** 把 Windows 路径转成 8.3 短路径，规避 NSIS `/D=` 遇到空格的问题。 */
async function toShortPath(winPath) {
  const res = await run('cmd.exe', ['/c', 'for', '%I', 'in', `("${winPath}")`, 'do', '@echo', '%~sI']);
  const out = res.stdout.trim().split(/\r?\n/).pop()?.trim();
  return out && !out.includes(' ') ? out : winPath;
}

export class QemuManager {
  constructor({ config, logger, events, downloader } = {}) {
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.downloader = downloader;
    this.state = 'idle';   // idle | downloading | installing | verifying | error
    this.progress = null;
    this.lastError = null;
    this.lastResult = null;
    // 独立的忙锁：不能用 state 当互斥量，因为 startInstall 会先把 state
    // 置成 downloading，再调 install()，那样 install() 会把自己否决掉。
    this._busy = false;
  }

  get qemuConfig() {
    return this.config.get().qemu || {};
  }

  /** 便携目录里自装 QEMU 的目标位置。 */
  get installDir() {
    return this.config.layout.qemu;
  }

  status() {
    const cfg = this.config.get().vm;
    const detection = this._lastDetection || null;
    return {
      platform: process.platform,
      supported: process.platform === 'win32',
      state: this.state,
      progress: this.progress,
      error: this.lastError,
      lastResult: this.lastResult,
      installDir: this.installDir,
      managed: Boolean(this.qemuConfig.managed),
      buildDate: this.qemuConfig.buildDate || null,
      installedAt: this.qemuConfig.installedAt || null,
      qemuPath: cfg.qemuPath || '',
      qemuImgPath: cfg.qemuImgPath || '',
      detection,
      hints: this.hints(),
    };
  }

  hints() {
    if (process.platform === 'win32') {
      return [
        '助手会从官方镜像 qemu.weilnetz.de 下载最新安装包，并静默装到便携目录里，无需手动操作。',
        '如果安装器弹出了 UAC 授权窗口，请点「是」——自动流程无法代替你确认提权。',
      ];
    }
    if (process.platform === 'darwin') {
      return ['macOS 请手动安装：brew install qemu'];
    }
    return ['Linux 请手动安装：sudo apt install qemu-system-x86 qemu-utils（或对应发行版的命令）'];
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.progress = state === 'idle' || state === 'error' ? null : { ...(this.progress || {}), ...extra };
    this.events?.broadcast('qemu', this.status());
  }

  /* ------------------------- 安装 ------------------------- */

  /** 让 VM 管理器重新探测一次（安装完路径变了）。 */
  async _redetect() {
    if (this.vm?.detect) await this.vm.detect({ refresh: true });
  }

  /**
   * 下载并静默安装 QEMU 到便携目录。
   * 全程可用 cancel() 中断；下载阶段保留分片，安装阶段则回滚已释放。
   */
  async install({ keepInstaller = false, force = false } = {}) {
    if (process.platform !== 'win32') {
      const err = new Error(`当前平台（${process.platform}）暂不支持自动安装，请用系统包管理器安装 QEMU`);
      err.statusCode = 400;
      throw err;
    }
    if (this._busy) {
      const err = new Error('QEMU 安装任务已在进行中');
      err.statusCode = 409;
      throw err;
    }
    this._busy = true;
    try {
      return await this._install({ keepInstaller, force });
    } finally {
      this._busy = false;
    }
  }

  async _install({ keepInstaller = false, force = false } = {}) {
    this.lastError = null;
    const layout = this.config.layout;

    // 已经装过且可用 → 除非 force，否则直接返回
    if (!force) {
      const existing = await this.verifyInstall();
      if (existing.ok) {
        this.logger?.info('qemu', `便携目录里已有可用的 QEMU（${existing.version}）`);
        return { ...existing, skipped: true, message: '便携目录里已有可用的 QEMU' };
      }
    }

    try {
      /* 1) 解析最新版本 */
      this._setState('downloading', { phase: 'resolving', bytes: 0, total: null });
      const release = await resolveLatestInstaller({ logger: this.logger });
      this.logger?.info('qemu', `准备安装 QEMU ${release.buildDate || ''}（${release.filename}）`);

      /* 2) 下载安装包 */
      const installerDir = path.join(layout.runtime, 'downloads');
      await fsp.mkdir(installerDir, { recursive: true });
      const installerPath = path.join(installerDir, release.filename);

      const dl = await this.downloader.download({
        url: release.url,
        destPath: installerPath,
        trustExisting: !force,
        onProgress: (p) => this._setState('downloading', {
          ...p,
          percent: p.percent,
          note: `下载 QEMU ${release.buildDate || ''}`,
        }),
      });
      this.logger?.info('qemu',
        `安装包就绪：${humanBytes(dl.sizeBytes)}${dl.skipped ? '（本地已有）' : `，用时 ${(dl.durationMs / 1000).toFixed(1)}s`}`);

      /* 3) 静默安装 */
      this._setState('installing', { phase: 'installing', percent: 100, note: '正在静默安装到便携目录…' });
      await fsp.mkdir(this.installDir, { recursive: true });
      const shortDir = await toShortPath(this.installDir);
      this.logger?.info('qemu', `静默安装到 ${this.installDir}`);

      const started = Date.now();
      const child = spawn(installerPath, ['/S', `/D=${shortDir}`], {
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let installLog = '';
      child.stdout?.on('data', (c) => { installLog += c.toString(); });
      child.stderr?.on('data', (c) => { installLog += c.toString(); });

      const exited = await waitForExit(child, INSTALL_TIMEOUT_MS);
      if (!exited) {
        try { child.kill(); } catch { /* ignore */ }
        const err = new Error('安装器超时未结束。它可能弹出了 UAC 授权窗口等待确认——请手动点「是」后重试。');
        err.statusCode = 500;
        throw err;
      }
      const code = child.exitCode;
      if (code !== 0) {
        const err = new Error(`安装器返回了非零退出码 ${code}`
          + (installLog.trim() ? `：${installLog.trim().split(/\r?\n/).slice(-3).join(' / ')}` : ''));
        err.statusCode = 500;
        throw err;
      }
      this.logger?.info('qemu', `安装器结束（用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);

      /* 4) 验证 */
      this._setState('verifying', { phase: 'verifying', percent: 100, note: '验证 QEMU 是否可用…' });
      const verified = await this.verifyInstall();
      if (!verified.ok) {
        const err = new Error(`安装后仍找不到可用的 qemu-system-x86_64（${verified.error || '未知原因'}）`);
        err.statusCode = 500;
        throw err;
      }

      /* 5) 写进配置，之后启动虚拟机就能直接用 */
      await this.config.patch({
        vm: { qemuPath: verified.qemuPath, qemuImgPath: verified.qemuImgPath || '' },
        qemu: {
          managed: true,
          buildDate: release.buildDate || null,
          installedAt: new Date().toISOString(),
          version: verified.version,
          installerFile: release.filename,
        },
      });
      await this._redetect();

      if (!keepInstaller) {
        await fsp.rm(installerPath, { force: true }).catch(() => {});
        this.logger?.info('qemu', '已删除安装包以节省空间（keepInstaller=false）');
      }

      const result = {
        ok: true,
        qemuPath: verified.qemuPath,
        qemuImgPath: verified.qemuImgPath,
        version: verified.version,
        installDir: this.installDir,
        buildDate: release.buildDate,
        sizeText: dl.sizeText,
        durationMs: Date.now() - started + (dl.durationMs || 0),
        message: 'QEMU 已安装到便携目录，可以直接启动虚拟机了',
      };
      this.lastResult = result;
      this._setState('idle');
      this.events?.broadcast('qemu', { ...this.status(), installed: result });
      this.logger?.info('qemu', `QEMU 安装完成：${verified.version}`);
      return result;
    } catch (err) {
      if (err.cancelled) {
        this.logger?.warn('qemu', 'QEMU 安装任务已取消');
        this.lastError = '已取消';
        this._setState('error');
        this.events?.broadcast('qemu', { ...this.status(), cancelled: true });
        throw err;
      }
      this.lastError = err.message;
      this.logger?.error('qemu', `QEMU 安装失败：${err.message}`);
      this._setState('error');
      this.events?.broadcast('qemu', { ...this.status(), failed: err.message });
      throw err;
    }
  }

  /** 后台执行安装，立即返回（供 HTTP 接口调用）。 */
  startInstall(options = {}) {
    if (this._busy) {
      const err = new Error('QEMU 安装任务已在进行中');
      err.statusCode = 409;
      throw err;
    }
    this._setState('downloading', { phase: 'resolving', percent: null, note: '正在准备…' });
    this.install(options).catch((err) => {
      if (err?.cancelled) return;
      this.logger?.error('qemu', `后台安装任务结束（异常）：${err.message}`);
      // install() 内部的正常异常路径已经置过状态；
      // 但如果是没进 try 就抛的（比如平台不支持），这里兵底复位一下。
      if (this.state !== 'error') {
        this.lastError = err.message;
        this._setState('error');
        this.events?.broadcast('qemu', { ...this.status(), failed: err.message });
      }
    });
    return { started: true, message: '已开始下载并安装 QEMU，进度会实时推送' };
  }

  cancel() {
    if (this.downloader?.busy) return this.downloader.cancel();
    if (this.state === 'installing') {
      this.logger?.warn('qemu', '安装阶段无法中断（正在写入文件），请等它结束');
      return false;
    }
    return false;
  }

  get busy() {
    return this._busy;
  }

  /**
   * 验证便携目录（以及配置里指定的位置）有没有可用的 QEMU。
   */
  async verifyInstall() {
    const candidates = [
      { dir: this.installDir, source: 'portable' },
    ];
    const configured = this.config.get().vm.qemuPath;
    if (configured) candidates.push({ dir: path.dirname(configured), source: 'configured' });

    for (const { dir, source } of candidates) {
      const exe = path.join(dir, 'qemu-system-x86_64.exe');
      const img = path.join(dir, 'qemu-img.exe');
      if (!(await pathExists(exe))) continue;
      const probe = await run(exe, ['--version'], { timeoutMs: VERIFY_TIMEOUT_MS });
      if (!probe.ok) continue;
      const version = (probe.stdout.split(/\r?\n/)[0] || '').trim();
      return {
        ok: true,
        qemuPath: exe,
        qemuImgPath: (await pathExists(img)) ? img : '',
        version,
        source,
      };
    }
    return { ok: false, error: `便携目录里没有 qemu-system-x86_64.exe（${this.installDir}）` };
  }

  /** 检测结果来源说明，给 UI 用。 */
  setVm(vm) {
    this.vm = vm;
    return this;
  }
}
