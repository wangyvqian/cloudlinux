/**
 * 配置管理：默认值 + data/config.json 覆盖。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge, ensureDir, pathExists } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const AGENT_ROOT = path.resolve(HERE, '..');
export const AGENT_VERSION = '0.1.0';

export const DEFAULT_CONFIG = {
  agent: {
    name: `${os.hostname()} 的云端桌面`,
    host: '127.0.0.1',
    port: 8765,
    logLevel: 'info',
    // 浏览器侧允许跨域的 Origin 白名单，支持 * 通配。
    allowedOrigins: [
      'http://localhost:*',
      'http://127.0.0.1:*',
      'https://localhost:*',
      'https://127.0.0.1:*',
      'https://*.github.io',
      'null', // 允许直接用 file:// 打开 index.html 调试
    ],
    // Host 头白名单，用于防 DNS Rebinding。
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', '::1'],
  },

  vm: {
    enabled: false,
    qemuPath: '',
    qemuImgPath: '',
    imagePath: '',
    // 首次安装系统时指向 ISO；装完后清空即可。
    installerIso: '',
    memoryMb: 4096,
    cpus: 2,
    // auto | kvm | whpx | hvf | tcg
    accel: 'auto',
    vga: 'std',
    sshPort: 2222,
    qmpPort: 4444,
    bootTimeoutMs: 120000,
    shutdownTimeoutMs: 25000,
    shareDir: '',
    extraArgs: [],
    vnc: {
      enabled: true,
      display: 0,
      port: 5900,
      websocketPort: 5700,
      password: '',
    },
  },

  sync: {
    jobs: [],
    // 备份保留份数
    keepBackups: 5,
  },

  images: {
    // ISO 下载目录，留空则用 <data>/images
    downloadDir: '',
    // 一键准备时默认创建的虚拟磁盘大小（GB）
    diskSizeGb: 32,
    // 优先使用镜像的 mirrors 数组第几项
    preferredMirror: 0,
  },
};

/** 需要屏蔽在前端展示或禁止前端修改的敏感字段。 */
export const SENSITIVE_CONFIG_PATHS = ['vm.vnc.password'];

export class ConfigStore {
  constructor({ dataDir, overrides = {}, logger } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.logger = logger;
    this.overrides = overrides;
    this.config = structuredClone(DEFAULT_CONFIG);
  }

  async load() {
    await ensureDir(this.dataDir);
    let onDisk = {};
    if (await pathExists(this.file)) {
      try {
        onDisk = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      } catch (err) {
        this.logger?.warn('config', `配置文件损坏，将使用默认值：${err.message}`);
        try {
          await fsp.writeFile(`${this.file}.broken-${Date.now()}`, await fsp.readFile(this.file, 'utf8'));
        } catch { /* 尽力而为 */ }
      }
    } else {
      await this.save(structuredClone(DEFAULT_CONFIG));
    }

    let merged = deepMerge(structuredClone(DEFAULT_CONFIG), onDisk);
    // 命令行覆盖优先级最高
    merged = deepMerge(merged, this.overrides);
    this.config = merged;
    this.logger?.info('config', `已加载配置：${this.file}`);
    return this.config;
  }

  async save(next = this.config) {
    await ensureDir(this.dataDir);
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
    return next;
  }

  get() {
    return this.config;
  }

  /** 局部更新并落盘。 */
  async patch(patch) {
    this.config = deepMerge(this.config, patch);
    await this.save(this.config);
    return this.config;
  }

  /** 返回可安全发给前端的副本（去掉密码等）。 */
  redacted() {
    const copy = structuredClone(this.config);
    if (copy.vm?.vnc) {
      const has = Boolean(copy.vm.vnc.password);
      copy.vm.vnc.password = has ? '********' : '';
      copy.vm.vnc.passwordSet = has;
    }
    Object.defineProperty(copy, '__sensitivePaths', {
      value: SENSITIVE_CONFIG_PATHS,
      enumerable: true,
    });
    return copy;
  }

  /**
   * 从请求体里挑出允许修改的字段。
   * 注意：`password` 若收到 `********` 占位符则保持原值。
   */
  static sanitizePatch(input = {}) {
    const out = {};
    const takeNumber = (v, min, max, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    };

    if (input.agent && typeof input.agent === 'object') {
      const a = {};
      if (typeof input.agent.name === 'string') a.name = input.agent.name.slice(0, 80);
      if (typeof input.agent.logLevel === 'string' && ['debug', 'info', 'warn', 'error'].includes(input.agent.logLevel)) {
        a.logLevel = input.agent.logLevel;
      }
      if (Array.isArray(input.agent.allowedOrigins)) {
        a.allowedOrigins = input.agent.allowedOrigins
          .filter((v) => typeof v === 'string' && v.length <= 200)
          .slice(0, 50);
      }
      if (Object.keys(a).length) out.agent = a;
    }

    if (input.vm && typeof input.vm === 'object') {
      const v = {};
      for (const key of ['enabled']) {
        if (typeof input.vm[key] === 'boolean') v[key] = input.vm[key];
      }
      for (const key of ['qemuPath', 'qemuImgPath', 'imagePath', 'installerIso', 'vga', 'shareDir']) {
        if (typeof input.vm[key] === 'string') v[key] = input.vm[key].slice(0, 500);
      }
      if (typeof input.vm.accel === 'string' && ['auto', 'kvm', 'whpx', 'hvf', 'tcg'].includes(input.vm.accel)) {
        v.accel = input.vm.accel;
      }
      v.memoryMb = takeNumber(input.vm.memoryMb, 512, 262144, undefined);
      v.cpus = takeNumber(input.vm.cpus, 1, 64, undefined);
      v.sshPort = takeNumber(input.vm.sshPort, 1, 65535, undefined);
      v.qmpPort = takeNumber(input.vm.qmpPort, 1, 65535, undefined);
      v.bootTimeoutMs = takeNumber(input.vm.bootTimeoutMs, 5000, 900000, undefined);
      for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];

      if (Array.isArray(input.vm.extraArgs)) {
        v.extraArgs = input.vm.extraArgs
          .filter((x) => typeof x === 'string' && x.length <= 300)
          .slice(0, 40);
      }

      if (input.vm.vnc && typeof input.vm.vnc === 'object') {
        const n = {};
        if (typeof input.vm.vnc.enabled === 'boolean') n.enabled = input.vm.vnc.enabled;
        n.display = takeNumber(input.vm.vnc.display, 0, 99, undefined);
        n.port = takeNumber(input.vm.vnc.port, 1, 65535, undefined);
        n.websocketPort = takeNumber(input.vm.vnc.websocketPort, 0, 65535, undefined);
        if (typeof input.vm.vnc.password === 'string' && input.vm.vnc.password !== '********') {
          n.password = input.vm.vnc.password.slice(0, 8);
        }
        for (const k of Object.keys(n)) if (n[k] === undefined) delete n[k];
        if (Object.keys(n).length) v.vnc = n;
      }
      if (Object.keys(v).length) out.vm = v;
    }

    if (input.images && typeof input.images === 'object') {
      const im = {};
      if (typeof input.images.downloadDir === 'string') {
        im.downloadDir = input.images.downloadDir.slice(0, 500);
      }
      im.diskSizeGb = takeNumber(input.images.diskSizeGb, 4, 4096, undefined);
      im.preferredMirror = takeNumber(input.images.preferredMirror, 0, 10, undefined);
      for (const k of Object.keys(im)) if (im[k] === undefined) delete im[k];
      if (Object.keys(im).length) out.images = im;
    }

    return out;
  }
}
