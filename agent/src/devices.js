/**
 * 外设枚举：串口 / USB / 剪贴板占位。
 *
 * 说明：真正的"把本机 USB 设备挂进虚拟机"需要 usbip 或 QEMU 的 usb-host 直通，
 * 第一版只做**枚举与展示**，为你手动在 QEMU 参数里加 `-device usb-host,...` 提供依据。
 * 实现要点：
 *  - Windows 上 Get-PnpDevice / Get-CimInstance 冷启动可能耗时 5s+，超时要给足，
 *    并且**失败必须上报**，不能静默返回空数组（否则 UI 会误报"未发现设备"）。
 *  - 枚举结果做短 TTL 缓存，避免前端每次刷新都触发一次几秒的开销。
 */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ENUMERATE_TIMEOUT_MS = 30000;
const CACHE_TTL_MS = 15000;

function run(command, args, { timeoutMs = ENUMERATE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          error: error?.message ?? null,
        });
      });
  });
}

function parseJsonLenient(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  // PowerShell 写 UTF-8 时可能带 BOM
  const cleaned = trimmed.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** 只有一项时 PowerShell 不会返回数组，统一成数组方便处理。 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

async function ps(command) {
  // 中文版 Windows 上 PowerShell 5.1 默认用 GBK 写 stdout，Node 按 UTF-8 解码会乱码。
  // 强制把控制台输出编码改成 UTF-8（BOM 由 parseJsonLenient 处理）。
  return run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
  ]);
}

export class DeviceManager {
  constructor({ config, logger } = {}) {
    this.config = config;
    this.logger = logger;
    this.cache = new Map();
    this.clipboard = {
      text: '',
      updatedAt: null,
      note: '第一版仅保存助手进程内的剪贴板文本，不读取系统剪贴板',
    };
  }

  /** 带 TTL 的缓存包装：force=true 时强制重算。 */
  async _cached(key, force, produce) {
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const value = await produce();
    this.cache.set(key, { at: Date.now(), value });
    if (value.error) this.logger?.warn('devices', `${key} 枚举失败：${value.error}`);
    return value;
  }

  async listSerial({ force = false } = {}) {
    return this._cached('serial', force, () => this._enumerateSerial());
  }

  async listUsb({ force = false } = {}) {
    return this._cached('usb', force, () => this._enumerateUsb());
  }

  /* ------------------------- 串口 ------------------------- */

  async _enumerateSerial() {
    if (process.platform === 'win32') {
      const res = await ps(
        "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | " +
        "Select-Object @{n='name';e={$_.Name}}, @{n='id';e={$_.DeviceID}}, @{n='status';e={$_.Status}} | ConvertTo-Json -Compress",
      );
      if (!res.ok) return { items: [], error: res.stderr.trim() || res.error || 'PowerShell 调用失败' };
      const data = parseJsonLenient(res.stdout);
      if (data === null && res.stdout.trim()) return { items: [], error: '无法解析 PowerShell 返回的 JSON' };
      return {
        items: asArray(data).map((item) => ({
          path: (String(item.name || '').match(/\((COM\d+)\)/) || [])[1] || item.name || 'unknown',
          description: item.name || '',
          id: item.id || '',
          status: item.status || '',
        })),
        error: null,
      };
    }

    // Linux: 优先读 by-id 符号链接，失败再退到常见设备节点
    const dir = '/dev/serial/by-id';
    try {
      const entries = await fsp.readdir(dir);
      return {
        items: entries.map((name) => ({ path: name, description: name, id: path.join(dir, name), status: 'present' })),
        error: null,
      };
    } catch {
      const candidates = ['/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyACM1'];
      const items = [];
      for (const candidate of candidates) {
        try {
          await fsp.access(candidate);
          items.push({ path: candidate, description: candidate, id: candidate, status: 'present' });
        } catch { /* 不存在，跳过 */ }
      }
      return { items, error: null };
    }
  }

  /* ------------------------- USB ------------------------- */

  async _enumerateUsb() {
    if (process.platform === 'win32') {
      const res = await ps(
        "Get-PnpDevice -PresentOnly -Class USB -ErrorAction SilentlyContinue | " +
        "Select-Object @{n='name';e={$_.FriendlyName}}, @{n='id';e={$_.InstanceId}}, @{n='status';e={$_.Status}} | ConvertTo-Json -Compress",
      );
      if (!res.ok) return { items: [], error: res.stderr.trim() || res.error || 'PowerShell 调用失败' };
      const data = parseJsonLenient(res.stdout);
      if (data === null && res.stdout.trim()) return { items: [], error: '无法解析 PowerShell 返回的 JSON' };
      return {
        items: asArray(data).map((item) => {
          const id = String(item.id || '');
          const vid = (id.match(/VID_([0-9A-F]{4})/i) || [])[1] || '';
          const pid = (id.match(/PID_([0-9A-F]{4})/i) || [])[1] || '';
          const vendorId = vid ? `0x${vid.toLowerCase()}` : '';
          const productId = pid ? `0x${pid.toLowerCase()}` : '';
          return {
            name: item.name || '',
            id,
            vendorId,
            productId,
            status: item.status || '',
            // 没有 VID/PID 的（如根集线器、主机控制器）无法直通，留空
            qemuArg: vendorId && productId
              ? `-device usb-host,vendorid=${vendorId},productid=${productId}`
              : '',
          };
        }),
        error: null,
      };
    }

    if (process.platform === 'linux') {
      const base = '/sys/bus/usb/devices';
      let entries = [];
      try {
        entries = await fsp.readdir(base);
      } catch (err) {
        return { items: [], error: `无法读取 ${base}：${err.message}` };
      }
      const items = [];
      for (const name of entries) {
        const dir = path.join(base, name);
        const read = async (file) => {
          try { return (await fsp.readFile(path.join(dir, file), 'utf8')).trim(); } catch { return ''; }
        };
        const product = await read('product');
        if (!product) continue;
        const vendorId = await read('idVendor');
        const productId = await read('idProduct');
        items.push({
          name: product,
          id: `${vendorId}:${productId}`,
          vendorId: `0x${vendorId}`,
          productId: `0x${productId}`,
          status: 'present',
          qemuArg: vendorId && productId
            ? `-device usb-host,vendorid=0x${vendorId},productid=0x${productId}`
            : '',
        });
      }
      return { items, error: null };
    }

    return { items: [], error: `暂不支持在 ${process.platform} 上枚举外设` };
  }

  async overview({ force = false } = {}) {
    const [serial, usb] = await Promise.all([
      this.listSerial({ force }),
      this.listUsb({ force }),
    ]);

    const errors = {};
    if (serial.error) errors.serial = serial.error;
    if (usb.error) errors.usb = usb.error;

    return {
      serial: serial.items,
      usb: usb.items,
      errors,
      // 前端据此区分「真的没有设备」和「枚举失败」
      partial: Object.keys(errors).length > 0,
      clipboard: {
        supported: false,
        bytes: Buffer.byteLength(this.clipboard.text || '', 'utf8'),
        updatedAt: this.clipboard.updatedAt,
        note: this.clipboard.note,
      },
      hints: [
        '串口：把 COM 号透传给虚拟机需要 -serial 或 QEMU 的 chardev + serial 设备。',
        'USB：把上面 qemuArg 加到「设置 → 虚拟机 → 额外参数(extraArgs)」即可直通（需先关闭虚拟机）。',
        '剪贴板：跨浏览器/虚拟机的剪贴板要等 v0.3 用 WebRTC DataChannel 实现。',
      ],
    };
  }

  setClipboardText(text) {
    this.clipboard.text = String(text ?? '').slice(0, 1024 * 1024);
    this.clipboard.updatedAt = new Date().toISOString();
    return { bytes: Buffer.byteLength(this.clipboard.text, 'utf8'), updatedAt: this.clipboard.updatedAt };
  }

  getClipboardText() {
    return this.clipboard.text;
  }
}
