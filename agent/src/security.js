/**
 * 安全：配对码(PIN) / 长期令牌(Token) / Origin 与 Host 白名单。
 *
 * 威胁模型：
 *  - 恶意网页从浏览器里尝试连本地助手 → Origin 白名单 + Token 双重拦截
 *  - DNS Rebinding（恶意域名解析到 127.0.0.1）→ Host 头校验
 *  - 暴力猜配对码 → 失败次数限流
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, matchPattern, pathExists, sha256, uuid } from './util.js';

// 去掉容易混淆的 0/O/1/I
const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PAIR_MAX_FAILURES = 5;
const PAIR_LOCK_MS = 5 * 60 * 1000;

export class SecurityManager {
  constructor({ dataDir, config, logger } = {}) {
    this.dataDir = dataDir;
    this.config = config;          // ConfigStore 实例
    this.logger = logger;
    this.file = path.join(dataDir, 'security.json');
    this.salt = '';
    this.pinHash = '';
    this.tokens = [];              // [{ id, label, hash, createdAt, lastUsedAt }]
    this.failures = [];            // 配对失败时间戳
    this._newPin = null;           // 仅在本次进程内可见的新配对码
  }

  get securityConfig() {
    return this.config.get().agent;
  }

  async load() {
    await ensureDir(this.dataDir);
    if (await pathExists(this.file)) {
      try {
        const data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
        this.salt = data.salt || crypto.randomBytes(16).toString('hex');
        this.pinHash = data.pinHash || '';
        this.tokens = Array.isArray(data.tokens) ? data.tokens : [];
      } catch (err) {
        this.logger?.warn('security', `安全文件损坏，将重新初始化：${err.message}`);
        this.salt = crypto.randomBytes(16).toString('hex');
        this.pinHash = '';
        this.tokens = [];
      }
    } else {
      this.salt = crypto.randomBytes(16).toString('hex');
    }

    if (!this.pinHash) {
      this._newPin = this.generatePin();
      this.pinHash = this.hashSecret(this._newPin);
      await this.save();
    }
    return this;
  }

  async save() {
    await ensureDir(this.dataDir);
    const payload = {
      salt: this.salt,
      pinHash: this.pinHash,
      tokens: this.tokens,
    };
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  hashSecret(value) {
    return sha256(`${this.salt}:${value}`);
  }

  generatePin() {
    const bytes = crypto.randomBytes(6);
    let out = '';
    for (let i = 0; i < 6; i += 1) out += PIN_ALPHABET[bytes[i] % PIN_ALPHABET.length];
    return out;
  }

  get isPaired() {
    return this.tokens.length > 0;
  }

  /** 取出本次进程内新生成的配对码（只返回一次）。 */
  consumeNewPin() {
    const pin = this._newPin;
    this._newPin = null;
    return pin;
  }

  /** 重新生成配对码，并清空所有已配对设备。 */
  async rotatePin() {
    const pin = this.generatePin();
    this.pinHash = this.hashSecret(pin);
    this.tokens = [];
    this.failures = [];
    await this.save();
    this._newPin = pin;
    return pin;
  }

  async unpairAll() {
    const count = this.tokens.length;
    this.tokens = [];
    await this.save();
    return count;
  }

  isLockedOut() {
    const cutoff = Date.now() - PAIR_LOCK_MS;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= PAIR_MAX_FAILURES;
  }

  lockRemainingMs() {
    if (!this.failures.length) return 0;
    const oldest = Math.min(...this.failures);
    return Math.max(0, oldest + PAIR_LOCK_MS - Date.now());
  }

  /**
   * 用配对码换取长期令牌。
   * @returns {Promise<{token:string,id:string}>}
   */
  async pair(pin, label = 'browser') {
    if (this.isLockedOut()) {
      const seconds = Math.ceil(this.lockRemainingMs() / 1000);
      const err = new Error(`配对尝试过多，请 ${seconds} 秒后重试`);
      err.statusCode = 429;
      throw err;
    }
    const normalized = String(pin || '').trim().toUpperCase().replace(/[\s-]/g, '');
    if (!normalized) {
      const err = new Error('请提供配对码');
      err.statusCode = 400;
      throw err;
    }
    if (this.hashSecret(normalized) !== this.pinHash) {
      this.failures.push(Date.now());
      const left = PAIR_MAX_FAILURES - this.failures.length;
      const err = new Error(left > 0 ? `配对码不正确，还可尝试 ${left} 次` : '配对码不正确，已锁定 5 分钟');
      err.statusCode = 401;
      throw err;
    }

    this.failures = [];
    const token = crypto.randomBytes(32).toString('hex');
    const record = {
      id: uuid(),
      label: String(label || 'browser').slice(0, 60),
      hash: this.hashSecret(token),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.tokens.push(record);
    await this.save();
    this.logger?.info('security', `新设备已配对：${record.label}`);
    return { token, id: record.id };
  }

  /**
   * 校验令牌。命中则刷新 lastUsedAt 并返回令牌记录，否则返回 null。
   * @returns {{id:string,label:string,createdAt:string,lastUsedAt:string|null}|null}
   */
  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const hash = this.hashSecret(token);
    const record = this.tokens.find((t) => {
      // 定长比较，避免时序侧信道
      const a = Buffer.from(t.hash, 'utf8');
      const b = Buffer.from(hash, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (!record) return null;
    record.lastUsedAt = new Date().toISOString();
    return record;
  }

  async revokeToken(id) {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length !== before) await this.save();
    return this.tokens.length !== before;
  }

  listTokens() {
    return this.tokens.map(({ id, label, createdAt, lastUsedAt }) => ({
      id, label, createdAt, lastUsedAt,
    }));
  }

  /** Origin 白名单校验。注意：同源请求可能没有 Origin 头，交给 Host 校验兜底。 */
  isOriginAllowed(origin) {
    if (!origin) return true; // 非浏览器 / 同源请求
    return (this.securityConfig.allowedOrigins || []).some((pattern) => matchPattern(origin, pattern));
  }

  /** Host 头校验，防 DNS Rebinding。 */
  isHostAllowed(hostHeader) {
    if (!hostHeader) return false;
    const host = String(hostHeader).replace(/:\d+$/, '').toLowerCase();
    return (this.securityConfig.allowedHosts || []).some((pattern) => matchPattern(host, pattern));
  }
}
