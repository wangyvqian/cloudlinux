/**
 * 配置管理：默认值 + <home>/config.json 覆盖。
 *
 * home 就是便携目录（默认「EXE 同级 / data」），
 * 所有路径都从传入的 layout 派生，方便把整个文件夹拷走或放 U 盘。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deepMerge, ensureDir, pathExists } from './util.js';

// 打包成 CJS（单文件 EXE）后 import.meta.url 会是 undefined，这里做容错。
const HERE = (() => {
  try {
    return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch {
    return process.cwd();
  }
})();

export const AGENT_ROOT = path.resolve(HERE, '..');
export const AGENT_VERSION = '0.1.0';
export const IS_WINDOWS = process.platform === 'win32';

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
    // 虚拟机显示名（用于窗口标题 / QEMU -name）
    name: 'Zorin OS',
    qemuPath: '',
    qemuImgPath: '',
    imagePath: '',
    // 磁盘格式：qcow2（默认，支持快照/叠加层）| raw | vmdk | vpc | vdi
    diskFormat: 'qcow2',
    // 首次安装系统时指向 ISO；装完后清空即可。
    installerIso: '',
    memoryMb: 4096,
    cpus: 2,
    // auto | kvm | whpx | hvf | tcg
    accel: 'auto',
    vga: 'std',
    // 磁盘接口：virtio（最快）| ide（兼容性最好）| sata | scsi
    diskInterface: 'virtio',
    // 网卡型号：virtio | e1000 | rtl8139
    netModel: 'virtio',
    sshPort: 2222,
    // 额外端口转发：[{ hostPort, guestPort, protocol }]
    extraHostfwd: [],
    qmpPort: 4444,
    bootTimeoutMs: 120000,
    shutdownTimeoutMs: 25000,
    // 与客户机共享的宿主目录（通过 9p / fat 挂载）
    share: { enabled: false, dir: '', tag: 'hostshare', readOnly: false },
    // 是否给客户机装 USB 平板指针（鼠标在图形界面里更准）
    usbTablet: true,
    // 音频（会占用宿主音频设备；无图形环境建议关掉）
    audio: false,
    extraArgs: [],
    vnc: {
      enabled: true,
      display: 0,
      port: 5900,
      websocketPort: 5700,
      password: '',
    },
  },

  // 便携目录里自装的 QEMU（由 qemu.js 写入，不建议手改）
  qemu: {
    managed: false,
    buildDate: null,
    installedAt: null,
    version: null,
    installerFile: null,
  },

  sync: {
    jobs: [],
    // 备份保留份数
    keepBackups: 5,
  },

  images: {
    // ISO 下载目录，留空则用 <home>/images
    downloadDir: '',
    // 一键准备时默认创建的虚拟磁盘大小（GB）
    diskSizeGb: 32,
    // 优先使用镜像的 mirrors 数组第几项
    preferredMirror: 0,
  },

  // 网络：Node 不会自动走系统代理，开加速器时需要在这里显式指定
  network: {
    // auto = 自动探测（环境变量 → Windows 系统代理 → 常见端口），只采用**确实能连上**的
    // off  = 强制直连
    // 也可以直接填地址，如 http://127.0.0.1:7897
    proxy: 'auto',
    // 这些主机不走代理（内置镜像的国内镜像站会自动加入，不用手写）
    bypass: [],
  },
};

/** 需要屏蔽在前端展示或禁止前端修改的敏感字段。 */
export const SENSITIVE_CONFIG_PATHS = ['vm.vnc.password'];

export class ConfigStore {
  constructor({ home, layout, overrides = {}, logger } = {}) {
    this.home = home;
    this.layout = layout;
    // dataDir 保持为别名，很多模块仍在用它
    this.dataDir = home;
    this.file = layout?.config || path.join(home, 'config.json');
    this.logger = logger;
    this.overrides = overrides;
    this.config = structuredClone(DEFAULT_CONFIG);
  }

  /** 下载来的系统镜像目录（便携目录内）。 */
  get imagesDir() {
    return this.layout?.images || path.join(this.home, 'images');
  }

  /** 虚拟机磁盘目录（便携目录内）。 */
  get disksDir() {
    return this.layout?.disks || path.join(this.home, 'disks');
  }

  async load() {
    await ensureDir(this.home);
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
    // 把便携目录布局一并告诉前端，方便界面显示数据放在哪
    Object.defineProperty(copy, '__layout', {
      value: { home: this.home, ...this.layout },
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
      for (const key of ['usbTablet', 'audio']) {
        if (typeof input.vm[key] === 'boolean') v[key] = input.vm[key];
      }
      for (const key of ['qemuPath', 'qemuImgPath', 'imagePath', 'installerIso', 'vga', 'name']) {
        if (typeof input.vm[key] === 'string') v[key] = input.vm[key].slice(0, 500);
      }
      if (typeof input.vm.name === 'string') v.name = input.vm.name.slice(0, 80);
      if (typeof input.vm.accel === 'string' && ['auto', 'kvm', 'whpx', 'hvf', 'tcg'].includes(input.vm.accel)) {
        v.accel = input.vm.accel;
      }
      if (typeof input.vm.diskInterface === 'string'
        && ['virtio', 'ide', 'sata', 'scsi'].includes(input.vm.diskInterface)) {
        v.diskInterface = input.vm.diskInterface;
      }
      if (typeof input.vm.netModel === 'string'
        && ['virtio', 'e1000', 'rtl8139'].includes(input.vm.netModel)) {
        v.netModel = input.vm.netModel;
      }
      if (typeof input.vm.diskFormat === 'string'
        && ['qcow2', 'raw', 'vmdk', 'vpc', 'vdi', 'qed'].includes(input.vm.diskFormat)) {
        v.diskFormat = input.vm.diskFormat;
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

      // 额外端口转发
      if (Array.isArray(input.vm.extraHostfwd)) {
        v.extraHostfwd = input.vm.extraHostfwd
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => ({
            hostPort: takeNumber(entry.hostPort, 1, 65535, null),
            guestPort: takeNumber(entry.guestPort, 1, 65535, null),
            protocol: ['tcp', 'udp'].includes(entry.protocol) ? entry.protocol : 'tcp',
          }))
          .filter((entry) => entry.hostPort && entry.guestPort)
          .slice(0, 20);
      }

      // 共享目录
      if (input.vm.share && typeof input.vm.share === 'object') {
        const s = {};
        if (typeof input.vm.share.enabled === 'boolean') s.enabled = input.vm.share.enabled;
        if (typeof input.vm.share.readOnly === 'boolean') s.readOnly = input.vm.share.readOnly;
        if (typeof input.vm.share.dir === 'string') s.dir = input.vm.share.dir.slice(0, 500);
        if (typeof input.vm.share.tag === 'string') {
          // 9p 的 mount_tag 不允许空格和特殊字符
          s.tag = input.vm.share.tag.replace(/[^\w.-]/g, '').slice(0, 32) || 'hostshare';
        }
        if (Object.keys(s).length) v.share = s;
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

    if (input.network && typeof input.network === 'object') {
      const n = {};
      if (typeof input.network.proxy === 'string') {
        n.proxy = input.network.proxy.trim().slice(0, 200) || 'auto';
      }
      if (Array.isArray(input.network.bypass)) {
        n.bypass = input.network.bypass
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim().slice(0, 200))
          .slice(0, 50);
      }
      if (Object.keys(n).length) out.network = n;
    }

    return out;
  }
}
