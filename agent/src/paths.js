/**
 * 便携目录解析。
 *
 * 设计目标：所有数据（配置、密钥、镜像、磁盘、备份、自装的 QEMU、日志）
 * 都放在**同一个目录**里，整个文件夹可以直接拷到 U 盘或另一台电脑上继续用。
 *
 * 目录选择优先级：
 *   1. `--home <dir>` 命令行
 *   2. `CLOUDLINUX_HOME` 环境变量
 *   3. **默认**：打包成 EXE 时用「EXE 同级 / data」；从源码运行时用「agent/data」
 *
 * 判定是否打包：Node 的 `node:sea` 模块（Node 21+ 的 Single Executable Application）。
 */
import path from 'node:path';

// 打包成 CJS（单文件 EXE）后 import.meta.url 会是 undefined，这里做容错。
const HERE = (() => {
  try {
    return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch {
    return process.cwd();
  }
})();

/** 源码根目录（即 agent/）；打包后无意义，仅作为兜底。 */
export const SOURCE_ROOT = path.resolve(HERE, '..');

/** 是否运行在打包好的单文件 EXE 里。 */
export async function detectPackaged() {
  try {
    const sea = await import('node:sea');
    if (typeof sea.isSea === 'function') return Boolean(sea.isSea());
    if (typeof sea.default?.isSea === 'function') return Boolean(sea.default.isSea());
    return false;
  } catch {
    // Node < 21 没有 node:sea，一律当作源码运行
    return false;
  }
}

/**
 * 程序所在目录：打包后是 EXE 所在目录，源码运行时是 agent/。
 * 便携模式就以它为基准，保证「EXE 放哪、数据就在哪」。
 */
export async function resolveBaseDir() {
  return (await detectPackaged()) ? path.dirname(process.execPath) : SOURCE_ROOT;
}

/**
 * 解析出数据根目录（home）。
 * @param {{ argvHome?: string, envHome?: string, baseDir: string }} options
 */
export function resolveHome({ argvHome, envHome, baseDir }) {
  if (argvHome) return { home: path.resolve(argvHome), source: 'argv' };
  if (envHome) return { home: path.resolve(envHome), source: 'env' };
  return { home: path.join(baseDir, 'data'), source: 'portable' };
}

/** 由 home 派生出完整目录布局。 */
export function buildLayout(home) {
  return {
    home,
    config: path.join(home, 'config.json'),
    security: path.join(home, 'security.json'),
    logs: path.join(home, 'logs'),
    logFile: path.join(home, 'logs', 'agent.log'),
    // 下载来的系统镜像（ISO / qcow2 / img）
    images: path.join(home, 'images'),
    // 虚拟机磁盘
    disks: path.join(home, 'disks'),
    // 同步任务的备份点
    backups: path.join(home, 'backups'),
    // 自带运行时（自装的 QEMU 等）
    runtime: path.join(home, 'runtime'),
    qemu: path.join(home, 'runtime', 'qemu'),
  };
}

/** 一次搞定：判定打包 → 定基准目录 → 定 home → 建布局。 */
export async function resolveLayout({ argvHome, envHome } = {}) {
  const packaged = await detectPackaged();
  const baseDir = packaged ? path.dirname(process.execPath) : SOURCE_ROOT;
  const { home, source } = resolveHome({ argvHome, envHome, baseDir });
  return { packaged, baseDir, home, homeSource: source, layout: buildLayout(home) };
}
