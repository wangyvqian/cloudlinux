/**
 * 文件同步与备份引擎。
 *
 * 设计取舍：第一版只做 **主机侧目录之间** 的同步（纯 Node 实现，无第三方依赖）。
 * 虚拟机内要看到文件，通过 QEMU 的 9p / SMB 共享目录挂载（见 README）。
 *
 * 方向：
 *   push          源 → 目标（单向覆盖）
 *   pull          目标 → 源
 *   bidirectional 双向，按 mtime 取新；冲突时保留两份
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, globMatch, humanBytes, pathExists, timestampSlug, uuid } from './util.js';

const DEFAULT_EXCLUDES = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/~$*',
  '**/*.tmp',
];

const MAX_HASH_BYTES = 64 * 1024 * 1024; // 超过这个大小只比 size+mtime，不读内容

/** 递归扫描目录，返回 relPath -> { size, mtimeMs } */
async function scanTree(root, { excludes = [], followSymlinks = false } = {}) {
  const files = new Map();
  const patterns = [...DEFAULT_EXCLUDES, ...excludes];

  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (patterns.some((p) => globMatch(rel, p))) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink() && !followSymlinks) continue;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full);
          files.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, full });
        } catch { /* 读不到就跳过 */ }
      }
    }
  }

  await walk(root, '');
  return files;
}

async function fileHash(fullPath, size) {
  if (size > MAX_HASH_BYTES) return null;
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const handle = await fsp.open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 256);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function copyFile(sourceFull, targetFull) {
  await ensureDir(path.dirname(targetFull));
  await fsp.copyFile(sourceFull, targetFull);
}

export class SyncManager {
  constructor({ config, logger, events } = {}) {
    this.config = config;
    this.logger = logger;
    this.events = events;
    this.running = new Map(); // jobId -> 进度对象
  }

  get syncConfig() {
    return this.config.get().sync;
  }

  list() {
    return (this.syncConfig.jobs || []).map((job) => ({
      ...job,
      running: this.running.has(job.id),
      progress: this.running.get(job.id) || null,
    }));
  }

  find(id) {
    return (this.syncConfig.jobs || []).find((job) => job.id === id);
  }

  async saveJobs(jobs) {
    await this.config.patch({ sync: { jobs } });
  }

  async add(input = {}) {
    const direction = ['push', 'pull', 'bidirectional'].includes(input.direction) ? input.direction : 'push';
    const source = String(input.source || '').trim();
    const target = String(input.target || '').trim();
    if (!source || !target) {
      throw Object.assign(new Error('必须同时提供 source 和 target 目录'), { statusCode: 400 });
    }
    const resolvedSource = path.resolve(source);
    const resolvedTarget = path.resolve(target);
    if (resolvedSource === resolvedTarget) {
      throw Object.assign(new Error('源目录和目标目录不能相同'), { statusCode: 400 });
    }
    if (resolvedTarget.startsWith(resolvedSource + path.sep) || resolvedSource.startsWith(resolvedTarget + path.sep)) {
      throw Object.assign(new Error('源目录和目标目录不能互相嵌套'), { statusCode: 400 });
    }

    const job = {
      id: uuid(),
      name: String(input.name || path.basename(resolvedSource) || 'sync').slice(0, 60),
      direction,
      source: resolvedSource,
      target: resolvedTarget,
      excludes: Array.isArray(input.excludes)
        ? input.excludes.filter((x) => typeof x === 'string' && x.length <= 200).slice(0, 50)
        : [],
      // 是否删除目标端多余文件
      mirror: Boolean(input.mirror),
      autoBackup: Boolean(input.autoBackup),
      enabled: input.enabled !== false,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastResult: null,
    };

    const jobs = [...(this.syncConfig.jobs || []), job];
    await this.saveJobs(jobs);
    this.logger?.info('sync', `新增同步任务「${job.name}」（${direction}）`);
    this.events?.broadcast('sync', { type: 'created', job });
    return job;
  }

  async remove(id) {
    const job = this.find(id);
    if (!job) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
    await this.saveJobs((this.syncConfig.jobs || []).filter((j) => j.id !== id));
    this.logger?.info('sync', `已删除同步任务「${job.name}」`);
    this.events?.broadcast('sync', { type: 'removed', jobId: id });
    return job;
  }

  async _updateJob(id, patch) {
    const jobs = (this.syncConfig.jobs || []).map((j) => (j.id === id ? { ...j, ...patch } : j));
    await this.saveJobs(jobs);
    return jobs.find((j) => j.id === id);
  }

  _report(jobId, progress) {
    this.running.set(jobId, progress);
    this.events?.broadcast('sync-progress', { jobId, ...progress });
  }

  /**
   * 执行一次同步。
   * @returns {Promise<object>} 统计结果
   */
  async run(id, { dryRun = false } = {}) {
    const job = this.find(id);
    if (!job) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
    if (this.running.has(id)) {
      throw Object.assign(new Error('该任务正在同步中'), { statusCode: 409 });
    }

    const started = Date.now();
    this.logger?.info('sync', `开始同步「${job.name}」${dryRun ? '（演练）' : ''}…`);
    this._report(id, { phase: 'scanning', done: 0, total: 0, copied: 0, bytes: 0 });

    const stats = { copied: 0, updated: 0, skipped: 0, deleted: 0, conflicts: 0, bytes: 0, errors: [] };

    try {
      const sourceExists = await pathExists(job.source);
      const targetExists = await pathExists(job.target);
      if (!sourceExists && !targetExists) {
        throw Object.assign(new Error('源目录和目标目录都不存在'), { statusCode: 400 });
      }
      if (!sourceExists) await ensureDir(job.source);
      if (!targetExists) await ensureDir(job.target);

      const excludes = job.excludes || [];
      const sourceFiles = job.direction === 'pull' ? null : await scanTree(job.source, { excludes });
      const targetFiles = job.direction === 'push' ? null : await scanTree(job.target, { excludes });

      const total = Math.max(sourceFiles?.size || 0, targetFiles?.size || 0);
      this._report(id, { phase: 'comparing', done: 0, total, copied: 0, bytes: 0 });

      const plan = [];

      const consider = async (fromMap, toMap, fromRoot, toRoot, label) => {
        for (const [rel, fromMeta] of fromMap) {
          const toMeta = toMap.get(rel);
          if (!toMeta) {
            plan.push({ action: 'create', rel, from: fromMeta.full, to: path.join(toRoot, rel), size: fromMeta.size, label });
            continue;
          }
          const sizeDiffers = toMeta.size !== fromMeta.size;
          const timeDiffers = Math.abs(toMeta.mtimeMs - fromMeta.mtimeMs) > 1500;
          if (!sizeDiffers && !timeDiffers) { stats.skipped += 1; continue; }

          if (!timeDiffers) { stats.skipped += 1; continue; }

          if (toMeta.mtimeMs > fromMeta.mtimeMs) {
            if (job.direction === 'bidirectional') continue; // 对面更新，反向那轮会处理
            stats.skipped += 1;
            continue;
          }

          // mtime 接近但大小不同 → 用哈希确认是不是真的不同
          if (Math.abs(toMeta.mtimeMs - fromMeta.mtimeMs) <= 1500 && sizeDiffers) {
            const [h1, h2] = await Promise.all([
              fileHash(fromMeta.full, fromMeta.size),
              fileHash(toMeta.full, toMeta.size),
            ]);
            if (h1 && h2 && h1 === h2) { stats.skipped += 1; continue; }
          }

          plan.push({ action: 'update', rel, from: fromMeta.full, to: path.join(toRoot, rel), size: fromMeta.size, label });
        }
      };

      if (job.direction === 'push') {
        await consider(sourceFiles, await scanTree(job.target, { excludes }), job.source, job.target, 'push');
      } else if (job.direction === 'pull') {
        await consider(targetFiles, await scanTree(job.source, { excludes }), job.target, job.source, 'pull');
      } else {
        const srcMap = sourceFiles || await scanTree(job.source, { excludes });
        const tgtMap = targetFiles || await scanTree(job.target, { excludes });
        await consider(srcMap, tgtMap, job.source, job.target, 'push');
        await consider(tgtMap, srcMap, job.target, job.source, 'pull');

        // 冲突检测：两边都改了（mtime 相差很小但内容不同） → 记录下来
        for (const [rel, a] of srcMap) {
          const b = tgtMap.get(rel);
          if (!b) continue;
          if (Math.abs(a.mtimeMs - b.mtimeMs) <= 1500 && a.size !== b.size) {
            stats.conflicts += 1;
            if (!dryRun) {
              const keep = path.join(job.target, `${rel}.conflict-${timestampSlug()}`);
              try {
                await ensureDir(path.dirname(keep));
                await copyFile(b.full, keep);
                this.logger?.warn('sync', `内容冲突：${rel}，已把目标端另存为 ${path.basename(keep)}`);
              } catch (err) {
                stats.errors.push(`${rel}: ${err.message}`);
              }
            }
          }
        }
      }

      // mirror：删除目标端多余文件（仅单向模式下）
      if (job.mirror && job.direction !== 'bidirectional') {
        const fromMap = job.direction === 'push'
          ? (sourceFiles || await scanTree(job.source, { excludes }))
          : (targetFiles || await scanTree(job.target, { excludes }));
        const toRoot = job.direction === 'push' ? job.target : job.source;
        const toMap = job.direction === 'push'
          ? await scanTree(job.target, { excludes })
          : await scanTree(job.source, { excludes });
        for (const [rel, meta] of toMap) {
          if (!fromMap.has(rel)) {
            plan.push({ action: 'delete', rel, to: meta.full, size: meta.size, label: 'mirror' });
          }
        }
      }

      // 统计计划中的操作数量（演练模式下这就是最终结果）
      const planned = { create: 0, update: 0, delete: 0, bytes: 0 };
      for (const item of plan) {
        planned[item.action] = (planned[item.action] || 0) + 1;
        planned.bytes += item.size || 0;
      }
      if (dryRun) {
        stats.copied = planned.create;
        stats.updated = planned.update;
        stats.deleted = planned.delete;
        stats.bytes = planned.bytes;
      }

      // 执行
      this._report(id, { phase: 'copying', done: 0, total: plan.length, copied: 0, bytes: 0 });
      let done = 0;
      for (const item of plan) {
        try {
          if (dryRun) {
            // 只统计
          } else if (item.action === 'delete') {
            await fsp.rm(item.to, { force: true });
            stats.deleted += 1;
          } else {
            await copyFile(item.from, item.to);
            // 保留源文件的修改时间，方便下次增量比较
            const stat = await fsp.stat(item.from);
            await fsp.utimes(item.to, stat.atime, stat.mtime).catch(() => {});
            if (item.action === 'create') stats.copied += 1; else stats.updated += 1;
            stats.bytes += item.size || 0;
          }
        } catch (err) {
          stats.errors.push(`${item.rel}: ${err.message}`);
        }
        done += 1;
        if (done % 20 === 0 || done === plan.length) {
          this._report(id, {
            phase: 'copying', done, total: plan.length,
            copied: stats.copied + stats.updated, bytes: stats.bytes,
            current: item.rel,
          });
        }
      }

      const result = {
        ok: stats.errors.length === 0,
        dryRun,
        durationMs: Date.now() - started,
        total: plan.length,
        ...stats,
        bytesText: humanBytes(stats.bytes),
        finishedAt: new Date().toISOString(),
      };

      await this._updateJob(id, { lastRunAt: result.finishedAt, lastResult: result });
      this.logger?.info('sync',
        `${dryRun ? '演练' : '同步'}完成「${job.name}」：新增 ${stats.copied}、更新 ${stats.updated}、删除 ${stats.deleted}、` +
        `跳过 ${stats.skipped}、冲突 ${stats.conflicts}、${humanBytes(stats.bytes)}，耗时 ${(result.durationMs / 1000).toFixed(1)}s` +
        (dryRun ? '（未修改任何文件）' : '') +
        (stats.errors.length ? `，${stats.errors.length} 个错误` : ''));

      if (job.autoBackup && !dryRun) {
        await this.backup(id);
      }
      return result;
    } catch (err) {
      const result = {
        ok: false, dryRun, error: err.message,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
        ...stats,
      };
      await this._updateJob(id, { lastRunAt: result.finishedAt, lastResult: result });
      this.logger?.error('sync', `同步失败「${job.name}」：${err.message}`);
      throw err;
    } finally {
      this.running.delete(id);
      this.events?.broadcast('sync-progress', { jobId: id, phase: 'idle', done: 0, total: 0 });
    }
  }

  /** 把源目录整份备份到 data/backups/<jobId>/<时间戳>/。 */
  async backup(id) {
    const job = this.find(id);
    if (!job) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });

    const dataDir = this.config.dataDir;
    const stamp = timestampSlug();
    const dest = path.join(dataDir, 'backups', job.id, stamp);
    await ensureDir(dest);

    this.logger?.info('sync', `开始备份「${job.name}」→ ${dest}`);
    const files = await scanTree(job.source, { excludes: job.excludes || [] });
    let bytes = 0;
    let copied = 0;
    const errors = [];

    for (const [rel, meta] of files) {
      try {
        const target = path.join(dest, rel);
        await copyFile(meta.full, target);
        const stat = await fsp.stat(meta.full);
        await fsp.utimes(target, stat.atime, stat.mtime).catch(() => {});
        bytes += meta.size;
        copied += 1;
      } catch (err) {
        errors.push(`${rel}: ${err.message}`);
      }
    }

    // 清理超量备份
    const keep = Math.max(1, Number(this.syncConfig.keepBackups) || 5);
    const jobBackupDir = path.join(dataDir, 'backups', job.id);
    try {
      const stamps = (await fsp.readdir(jobBackupDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
      for (const old of stamps.slice(keep)) {
        await fsp.rm(path.join(jobBackupDir, old), { recursive: true, force: true });
      }
    } catch { /* 忽略清理失败 */ }

    const result = {
      ok: errors.length === 0,
      dest, copied, bytes, bytesText: humanBytes(bytes), errors,
      finishedAt: new Date().toISOString(),
    };
    this.logger?.info('sync', `备份完成：${copied} 个文件、${humanBytes(bytes)} → ${dest}`);
    this.events?.broadcast('sync', { type: 'backup', jobId: id, result });
    return result;
  }

  /** 列出某个任务的备份点。 */
  async listBackups(id) {
    const dir = path.join(this.config.dataDir, 'backups', id);
    if (!(await pathExists(dir))) return [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const files = await scanTree(full);
      let bytes = 0;
      for (const meta of files.values()) bytes += meta.size;
      const stat = await fsp.stat(full);
      out.push({ stamp: entry.name, path: full, files: files.size, bytes, bytesText: humanBytes(bytes), mtime: stat.mtime.toISOString() });
    }
    return out.sort((a, b) => b.stamp.localeCompare(a.stamp));
  }
}
