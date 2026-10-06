/**
 * 虚拟机管理：调用 QEMU 拉起 Zorin OS，通过 QMP 协议做优雅关机 / 快照。
 *
 * 加速器选择：Windows=whpx，Linux=kvm，macOS=hvf，失败自动回退 tcg（软件模拟）。
 */
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { humanBytes, pathExists, waitForExit, waitForPort } from './util.js';

const QEMU_BINARY = process.platform === 'win32' ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64';
const QEMU_IMG_BINARY = process.platform === 'win32' ? 'qemu-img.exe' : 'qemu-img';

const WIN_COMMON_DIRS = [
  'C:\\Program Files\\qemu',
  'C:\\Program Files (x86)\\qemu',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'qemu'),
];

/* ------------------------------------------------------------------ */
/* QMP 客户端                                                          */
/* ------------------------------------------------------------------ */

/**
 * 最小可用的 QEMU Machine Protocol 客户端（TCP，JSON 行协议）。
 */
export class QmpClient {
  constructor({ host = '127.0.0.1', port, logger } = {}) {
    this.host = host;
    this.port = port;
    this.logger = logger;
    this.socket = null;
    this.buffer = '';
    this.pending = [];
    this.connected = false;
    this.greeting = null;
    this._greetingResolve = null;
    this._greetingReject = null;
  }

  connect({ timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.connected) return resolve(this);
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`连接 QMP 超时（${this.host}:${this.port}）`));
      }, timeoutMs);

      const greetingPromise = new Promise((res, rej) => {
        this._greetingResolve = res;
        this._greetingReject = rej;
      });

      socket.on('data', (chunk) => this._onData(chunk));
      socket.once('error', (err) => {
        this.connected = false;
        this._rejectAll(err);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      socket.once('close', () => {
        this.connected = false;
        this._rejectAll(new Error('QMP 连接已关闭'));
      });

      greetingPromise.then(async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        try {
          await this.execute('qmp_capabilities');
          resolve(this);
        } catch (err) {
          reject(err);
        }
      }).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this._handle(message);
    }
  }

  _handle(message) {
    if (message.QMP) {
      this.greeting = message.QMP;
      this._greetingResolve?.(message.QMP);
      return;
    }
    if (message.event) {
      this.logger?.debug('qmp', `事件 ${message.event}`);
      return;
    }
    const waiter = this.pending.shift();
    if (!waiter) return;
    if (Object.prototype.hasOwnProperty.call(message, 'error')) {
      waiter.reject(new Error(`${message.error.class}: ${message.error.desc}`));
    } else {
      waiter.resolve(message.return);
    }
  }

  _rejectAll(err) {
    this._greetingReject?.(err);
    while (this.pending.length) this.pending.shift().reject(err);
  }

  execute(command, args) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('QMP 未连接'));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, command });
      const payload = { execute: command };
      if (args && Object.keys(args).length) payload.arguments = args;
      this.socket.write(`${JSON.stringify(payload)}\n`);
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
    this.connected = false;
  }
}

/* ------------------------------------------------------------------ */
/* 外部命令辅助                                                         */
/* ------------------------------------------------------------------ */

function run(command, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          error: error ? (error.code === 'ENOENT' ? 'ENOENT' : error.message) : null,
        });
      });
  });
}

function parseSnapshotJson(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return null;
    return data.map((s) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? s.tag ?? ''),
      vmSize: Number(s.vm_size ?? 0) || 0,
      vmSizeText: s.vm_size_str || humanBytes(Number(s.vm_size ?? 0) || 0),
      dateText: s.date_sec
        ? new Date(Number(s.date_sec) * 1000).toISOString()
        : (s.date || ''),
    }));
  } catch {
    return null;
  }
}

function parseSnapshotText(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let started = false;
  for (const line of lines) {
    if (/^Snapshot list:/i.test(line.trim())) { started = true; continue; }
    if (!started) continue;
    if (!line.trim()) continue;
    if (/^(ID|TAG)\b/i.test(line.trim())) continue;
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const rest = m[3].trim();
    const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
    out.push({
      id: m[1],
      name: m[2],
      vmSizeText: rest.split(/\s{2,}/)[0] || '',
      dateText: dateMatch ? dateMatch[1] : '',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 虚拟机管理器                                                         */
/* ------------------------------------------------------------------ */

export class VmManager {
  constructor({ config, logger, events } = {}) {
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.state = 'stopped';
    this.since = new Date().toISOString();
    this.pid = null;
    this.child = null;
    this.qmp = null;
    this.lastError = null;
    this.lastExit = null;
    this.resolvedAccel = null;
    this.stderrTail = [];
    this.detected = { qemuPath: null, qemuImgPath: null, checkedAt: null, qemuVersion: null, error: null };
  }

  get vmConfig() {
    return this.config.get().vm;
  }

  _setState(state, reason) {
    if (this.state === state) return;
    this.state = state;
    this.since = new Date().toISOString();
    if (reason) this.logger?.info('vm', reason);
    this._broadcast();
  }

  _broadcast() {
    this.events?.broadcast('vm', this.status());
  }

  _captureStderr(child) {
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 60) this.stderrTail.shift();
        this.logger?.debug('qemu', trimmed);
      }
    });
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.logger?.debug('qemu', text);
    });
  }

  /* -------------------------- 探测 -------------------------- */

  async detect({ refresh = false } = {}) {
    if (!refresh && this.detected.checkedAt && Date.now() - this.detected.checkedAt < 60000) {
      return this.detected;
    }

    const cfg = this.vmConfig;
    const result = { qemuPath: null, qemuImgPath: null, checkedAt: Date.now(), qemuVersion: null, error: null };

    const candidates = [];
    if (cfg.qemuPath) candidates.push(cfg.qemuPath);
    candidates.push(QEMU_BINARY);
    if (process.platform === 'win32') {
      for (const dir of WIN_COMMON_DIRS) {
        if (dir) candidates.push(path.join(dir, QEMU_BINARY));
      }
    }

    for (const candidate of candidates) {
      const probe = await run(candidate, ['--version'], { timeoutMs: 5000 });
      if (probe.ok) {
        result.qemuPath = candidate;
        result.qemuVersion = (probe.stdout.split(/\r?\n/)[0] || '').trim() || null;
        break;
      }
    }

    if (result.qemuPath) {
      // qemu-img 一般和 qemu 同目录
      const imgCandidates = [];
      if (cfg.qemuImgPath) imgCandidates.push(cfg.qemuImgPath);
      if (result.qemuPath.includes(path.sep)) {
        imgCandidates.push(path.join(path.dirname(result.qemuPath), QEMU_IMG_BINARY));
      }
      imgCandidates.push(QEMU_IMG_BINARY);
      for (const candidate of imgCandidates) {
        const probe = await run(candidate, ['--version'], { timeoutMs: 5000 });
        if (probe.ok) { result.qemuImgPath = candidate; break; }
      }
    } else {
      result.error = process.platform === 'win32'
        ? '未找到 qemu-system-x86_64.exe，请从 https://www.qemu.org/download/ 安装，或在设置里手动指定路径'
        : '未找到 qemu-system-x86_64，请用包管理器安装（apt install qemu-system-x86 / brew install qemu）';
    }

    this.detected = result;
    return result;
  }

  accelCandidates() {
    const cfg = this.vmConfig;
    if (cfg.accel && cfg.accel !== 'auto') {
      return cfg.accel === 'tcg' ? ['tcg'] : [cfg.accel, 'tcg'];
    }
    const preferred = process.platform === 'win32'
      ? 'whpx'
      : (process.platform === 'darwin' ? 'hvf' : 'kvm');
    return [preferred, 'tcg'];
  }

  buildArgs(accel) {
    const cfg = this.vmConfig;
    const args = [
      '-name', `cloudlinux:${path.basename(cfg.imagePath || 'vm')}`,
      '-m', String(cfg.memoryMb),
      '-smp', String(cfg.cpus),
      '-accel', accel,
      '-drive', `file=${cfg.imagePath},if=virtio,format=qcow2,cache=writeback`,
      '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${cfg.sshPort}-:22`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-device', 'virtio-balloon-pci',
      '-vga', cfg.vga || 'std',
      '-usb', '-device', 'usb-tablet',
      '-rtc', 'base=localtime',
      '-monitor', 'none',
      '-qmp', `tcp:127.0.0.1:${cfg.qmpPort},server,nowait`,
    ];

    if (cfg.installerIso) {
      args.push('-cdrom', cfg.installerIso, '-boot', 'order=dc');
    } else {
      args.push('-boot', 'order=c');
    }

    const vnc = cfg.vnc || {};
    if (vnc.enabled !== false) {
      const options = [];
      if (vnc.password) options.push('password=on');
      if (vnc.websocketPort) options.push(`websocket=${vnc.websocketPort}`);
      const target = `127.0.0.1:${vnc.display ?? 0}`;
      args.push('-vnc', options.length ? `${target},${options.join(',')}` : target);
    }

    if (Array.isArray(cfg.extraArgs)) {
      for (const extra of cfg.extraArgs) {
        if (typeof extra === 'string' && extra.trim()) args.push(extra.trim());
      }
    }
    return args;
  }

  async _spawnOnce(accel) {
    const cfg = this.vmConfig;
    const args = this.buildArgs(accel);
    this.logger?.info('vm', `启动 QEMU（accel=${accel}，${cfg.memoryMb}MB / ${cfg.cpus}核）`);

    const child = spawn(this.detected.qemuPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pid = child.pid ?? null;
    this._captureStderr(child);

    const exitInfo = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.once('error', (err) => {
      this.logger?.error('vm', `QEMU 进程错误：${err.message}`);
    });

    const portInfo = waitForPort({
      host: '127.0.0.1',
      port: cfg.qmpPort,
      timeoutMs: cfg.bootTimeoutMs,
      intervalMs: 300,
    }).then((opened) => ({ opened }));

    const outcome = await Promise.race([
      exitInfo.then((info) => ({ type: 'exit', ...info })),
      portInfo.then((info) => ({ type: 'port', ...info })),
    ]);

    if (outcome.type === 'exit') {
      return { ok: false, reason: `QEMU 退出（code=${outcome.code}）`, detail: this.stderrTail.slice(-6) };
    }
    if (!outcome.opened) {
      child.kill('SIGKILL');
      return { ok: false, reason: `等待 QMP 端口 ${cfg.qmpPort} 超时`, detail: this.stderrTail.slice(-6) };
    }
    return { ok: true, child };
  }

  async start() {
    const cfg = this.vmConfig;
    if (this.state === 'running' || this.state === 'starting') {
      throw Object.assign(new Error('虚拟机已在运行或正在启动'), { statusCode: 409 });
    }
    if (!cfg.enabled) {
      throw Object.assign(new Error('虚拟机未启用，请先在设置里打开 enabled'), { statusCode: 400 });
    }
    if (!cfg.imagePath) {
      throw Object.assign(new Error('未配置磁盘镜像路径（vm.imagePath）'), { statusCode: 400 });
    }
    if (!(await pathExists(cfg.imagePath))) {
      throw Object.assign(new Error(`磁盘镜像不存在：${cfg.imagePath}`), { statusCode: 400 });
    }

    const env = os;
    const freeMb = Math.round(env.freemem() / 1024 / 1024);
    if (cfg.memoryMb > freeMb) {
      this.logger?.warn('vm', `分配内存 ${cfg.memoryMb}MB 超过当前空闲 ${freeMb}MB，可能变慢或失败`);
    }

    const detection = await this.detect();
    if (!detection.qemuPath) {
      throw Object.assign(new Error(detection.error || '未找到 QEMU'), { statusCode: 503 });
    }

    this._setState('starting', '正在启动虚拟机…');
    this.lastError = null;
    this.stderrTail = [];

    const candidates = this.accelCandidates();
    let lastFailure = null;

    for (let i = 0; i < candidates.length; i += 1) {
      const accel = candidates[i];
      const attempt = await this._spawnOnce(accel);
      if (attempt.ok) {
        this.resolvedAccel = accel;
        this.qmp = new QmpClient({ port: cfg.qmpPort, logger: this.logger });
        try {
          await this.qmp.connect({ timeoutMs: 8000 });
          if (cfg.vnc?.password) {
            await this.qmp.execute('change-vnc-password', { password: cfg.vnc.password });
            this.logger?.info('vm', '已设置 VNC 密码');
          }
        } catch (err) {
          this.logger?.warn('vm', `QMP 连接失败（不影响运行）：${err.message}`);
          this.qmp = null;
        }
        this._setState('running', `虚拟机已启动（accel=${accel}，pid=${this.pid}）`);
        this._watch(this.child);
        return this.status();
      }

      lastFailure = attempt;
      if (this.child && !this.child.killed) this.child.kill('SIGKILL');
      this.child = null;
      this.pid = null;
      this.logger?.warn('vm', `${accel} 启动失败：${attempt.reason}`);
      if (i < candidates.length - 1) {
        this.logger?.info('vm', `回退到 ${candidates[i + 1]} 重试…`);
      }
    }

    this.lastError = lastFailure?.reason || '启动失败';
    this._setState('error', `启动失败：${this.lastError}`);
    if (lastFailure?.detail?.length) {
      for (const line of lastFailure.detail) this.logger?.error('qemu', line);
    }
    throw Object.assign(new Error(this.lastError), { statusCode: 500, detail: lastFailure?.detail });
  }

  _watch(child) {
    child.once('exit', (code, signal) => {
      this.lastExit = { code, signal, at: new Date().toISOString() };
      this.qmp?.close();
      this.qmp = null;
      this.pid = null;
      if (this.state === 'stopping') {
        this._setState('stopped', `虚拟机已停止（code=${code}）`);
      } else if (code === 0) {
        this._setState('stopped', '虚拟机进程已退出');
      } else {
        this.lastError = `QEMU 异常退出（code=${code}, signal=${signal}）`;
        this._setState('error', this.lastError);
      }
    });
  }

  async stop({ force = false } = {}) {
    if (this.state !== 'running' && this.state !== 'starting') {
      return this.status();
    }
    const cfg = this.vmConfig;
    this._setState('stopping', force ? '正在强制关闭虚拟机…' : '正在优雅关闭虚拟机…');

    if (!force && this.qmp?.connected) {
      try {
        await this.qmp.execute('system_powerdown');
        this.logger?.info('vm', '已发送 ACPI 关机信号，等待客户机响应…');
      } catch (err) {
        this.logger?.warn('vm', `发送关机信号失败：${err.message}`);
      }
      const exited = await waitForExit(this.child, cfg.shutdownTimeoutMs);
      if (exited) return this.status();
      this.logger?.warn('vm', '客户机未在超时内关机，改为强制结束进程');
    }

    if (this.qmp?.connected) {
      try { await this.qmp.execute('quit'); } catch { /* ignore */ }
    }
    if (this.child) {
      this.child.kill('SIGTERM');
      const exited = await waitForExit(this.child, 5000);
      if (!exited) this.child.kill('SIGKILL');
      await waitForExit(this.child, 5000);
    }
    if (this.state !== 'stopped') this._setState('stopped', '虚拟机已停止');
    return this.status();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  /* ------------------------ 快照 ------------------------ */

  async listSnapshots() {
    const cfg = this.vmConfig;
    const detection = await this.detect();
    if (!detection.qemuImgPath) {
      throw Object.assign(new Error('未找到 qemu-img，无法管理快照'), { statusCode: 503 });
    }
    if (!cfg.imagePath) {
      throw Object.assign(new Error('未配置磁盘镜像路径'), { statusCode: 400 });
    }
    const json = await run(detection.qemuImgPath, ['snapshot', '-l', '--output=json', cfg.imagePath]);
    if (json.ok) {
      const parsed = parseSnapshotJson(json.stdout);
      if (parsed) return parsed;
    }
    const text = await run(detection.qemuImgPath, ['snapshot', '-l', cfg.imagePath]);
    if (!text.ok) {
      throw Object.assign(new Error(`读取快照失败：${text.stderr || text.error}`), { statusCode: 500 });
    }
    return parseSnapshotText(text.stdout);
  }

  async createSnapshot(name) {
    const cfg = this.vmConfig;
    const clean = String(name || '').trim();
    if (!/^[\w][\w.\-]{0,60}$/.test(clean)) {
      throw Object.assign(new Error('快照名只能是字母、数字、点、下划线、连字符'), { statusCode: 400 });
    }
    const detection = await this.detect();
    if (!detection.qemuImgPath) {
      throw Object.assign(new Error('未找到 qemu-img'), { statusCode: 503 });
    }

    if (this.state === 'running' && this.qmp?.connected) {
      this.logger?.info('vm', `创建在线快照 ${clean}…`);
      await this.qmp.execute('human-monitor-command', { 'command-line': `savevm ${clean}` });
    } else {
      const res = await run(detection.qemuImgPath, ['snapshot', '-c', clean, cfg.imagePath], { timeoutMs: 120000 });
      if (!res.ok) {
        throw Object.assign(new Error(`创建快照失败：${res.stderr || res.error}`), { statusCode: 500 });
      }
    }
    this.logger?.info('vm', `快照 ${clean} 已创建`);
    this._broadcast();
    return this.listSnapshots();
  }

  async restoreSnapshot(name) {
    const cfg = this.vmConfig;
    const clean = String(name || '').trim();
    const detection = await this.detect();
    if (!detection.qemuImgPath) {
      throw Object.assign(new Error('未找到 qemu-img'), { statusCode: 503 });
    }
    if (this.state === 'running') {
      if (this.qmp?.connected) {
        this.logger?.info('vm', `在线回滚到快照 ${clean}…`);
        await this.qmp.execute('human-monitor-command', { 'command-line': `loadvm ${clean}` });
        this._broadcast();
        return this.listSnapshots();
      }
      throw Object.assign(new Error('虚拟机运行中但 QMP 不可用，请先关机再回滚'), { statusCode: 409 });
    }
    const res = await run(detection.qemuImgPath, ['snapshot', '-a', clean, cfg.imagePath], { timeoutMs: 180000 });
    if (!res.ok) {
      throw Object.assign(new Error(`回滚失败：${res.stderr || res.error}`), { statusCode: 500 });
    }
    this.logger?.info('vm', `已回滚到快照 ${clean}`);
    return this.listSnapshots();
  }

  async deleteSnapshot(name) {
    const cfg = this.vmConfig;
    const clean = String(name || '').trim();
    const detection = await this.detect();
    if (!detection.qemuImgPath) {
      throw Object.assign(new Error('未找到 qemu-img'), { statusCode: 503 });
    }
    if (this.state === 'running' && this.qmp?.connected) {
      await this.qmp.execute('human-monitor-command', { 'command-line': `delvm ${clean}` });
    } else {
      const res = await run(detection.qemuImgPath, ['snapshot', '-d', clean, cfg.imagePath], { timeoutMs: 60000 });
      if (!res.ok) {
        throw Object.assign(new Error(`删除快照失败：${res.stderr || res.error}`), { statusCode: 500 });
      }
    }
    this.logger?.info('vm', `快照 ${clean} 已删除`);
    return this.listSnapshots();
  }

  /* ------------------------ 状态 ------------------------ */

  async status() {
    const cfg = this.vmConfig;
    const detection = this.detected.checkedAt ? this.detected : await this.detect();
    let imageInfo = null;
    if (cfg.imagePath && await pathExists(cfg.imagePath)) {
      const stat = await fsp.stat(cfg.imagePath);
      imageInfo = { path: cfg.imagePath, size: stat.size, sizeText: humanBytes(stat.size), mtime: stat.mtime.toISOString() };
    }
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);
    const freeMb = Math.round(os.freemem() / 1024 / 1024);

    return {
      state: this.state,
      since: this.since,
      pid: this.pid,
      error: this.lastError,
      lastExit: this.lastExit,
      accel: this.resolvedAccel,
      accelCandidates: this.accelCandidates(),
      qemu: {
        available: Boolean(detection.qemuPath),
        path: detection.qemuPath,
        imgPath: detection.qemuImgPath,
        version: detection.qemuVersion,
        error: detection.error,
      },
      image: imageInfo,
      imagePath: cfg.imagePath || '',
      installerIso: cfg.installerIso || '',
      memoryMb: cfg.memoryMb,
      cpus: cfg.cpus,
      vnc: {
        enabled: cfg.vnc?.enabled !== false,
        display: cfg.vnc?.display ?? 0,
        port: cfg.vnc?.port ?? 5900,
        websocketPort: cfg.vnc?.websocketPort ?? 0,
        hasPassword: Boolean(cfg.vnc?.password),
      },
      qmp: { port: cfg.qmpPort, connected: Boolean(this.qmp?.connected) },
      ssh: { port: cfg.sshPort },
      host: { platform: process.platform, arch: process.arch, cpuCount: os.cpus().length, totalMb, freeMb },
      stderrTail: this.stderrTail.slice(-15),
      enabled: Boolean(cfg.enabled),
    };
  }

  async shutdown() {
    this.qmp?.close();
    this.qmp = null;
    if (this.child && this.state === 'running') {
      this.logger?.info('vm', '助手退出，正在关闭虚拟机…');
      try { await this.stop({ force: false }); } catch { /* ignore */ }
    }
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}
