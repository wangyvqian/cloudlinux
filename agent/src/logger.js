/**
 * 日志器：把日志同时写到控制台、内存环形缓冲区和 SSE 事件流。
 */
import { EventEmitter } from 'node:events';
import { nowIso } from './util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger extends EventEmitter {
  constructor({ level = 'info', capacity = 800 } = {}) {
    super();
    this.level = LEVELS[level] ? level : 'info';
    this.capacity = capacity;
    this.buffer = [];
    this.seq = 0;
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
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
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
