/**
 * 日志器：同时写到控制台、内存环形缓冲区、SSE 事件流，
 * 以及（可选）便携目录下的日志文件 —— 打包成 EXE 后没有控制台，
 * 文件日志就是唯一的现场记录。
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// 单文件超过这个大小就轮转，避免无限制增长
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export class Logger extends EventEmitter {
  constructor({ level = 'info', capacity = 800, toConsole = true } = {}) {
    super();
    this.level = LEVELS[level] ? level : 'info';
    this.capacity = capacity;
    this.buffer = [];
    this.seq = 0;
    this.toConsole = toConsole;
    this.stream = null;
    this.logFile = null;
  }

  /**
   * 打开文件日志。写不进去不影响主流程（只打一条警告）。
   * @param {string} filePath
   */
  openFile(filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 超过上限就先把旧的改名保留一份
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_BYTES) {
        const prev = `${filePath}.1`;
        try { fs.rmSync(prev, { force: true }); } catch { /* ignore */ }
        fs.renameSync(filePath, prev);
      }
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
      this.stream.on('error', () => { this.stream = null; });
      this.logFile = filePath;
      return filePath;
    } catch {
      this.stream = null;
      this.logFile = null;
      return null;
    }
  }

  closeFile() {
    try { this.stream?.end(); } catch { /* ignore */ }
    this.stream = null;
  }

  setLevel(level) {
    if (LEVELS[level]) this.level = level;
  }

  isEnabled(level) {
    return LEVELS[level] >= LEVELS[this.level];
  }

  write(level, scope, message) {
    if (!this.isEnabled(level)) return;
    const entry = {
      id: ++this.seq,
      ts: nowIso(),
      level,
      scope: scope || 'agent',
      message: typeof message === 'string' ? message : String(message),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    this.emit('entry', entry);

    const line = `${entry.ts}  ${level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`;
    if (this.toConsole) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    try { this.stream?.write(`${line}\n`); } catch { /* 磁盘满了也不该崩 */ }
  }

  debug(scope, msg) { this.write('debug', scope, msg); }
  info(scope, msg) { this.write('info', scope, msg); }
  warn(scope, msg) { this.write('warn', scope, msg); }
  error(scope, msg) { this.write('error', scope, msg); }

  /** 生成绑定到某个 scope 的子日志器。 */
  child(scope) {
    const parent = this;
    return {
      debug: (m) => parent.debug(scope, m),
      info: (m) => parent.info(scope, m),
      warn: (m) => parent.warn(scope, m),
      error: (m) => parent.error(scope, m),
    };
  }

  tail(limit = 200) {
    const n = Math.max(1, Math.min(Number(limit) || 200, this.capacity));
    return this.buffer.slice(-n);
  }

  /** 把异常转成一行可读文本。 */
  exception(scope, err, context = '') {
    const detail = err && err.stack ? err.stack : String(err);
    this.error(scope, context ? `${context}: ${detail}` : detail);
  }
}
