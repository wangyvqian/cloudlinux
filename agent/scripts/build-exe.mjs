#!/usr/bin/env node
/**
 * 构建单文件 EXE（Windows）。
 *
 * 流程：
 *   1. esbuild 把 ESM 源码打成单个 CJS 文件
 *   2. Node 的 SEA（Single Executable Application）把该文件编成 blob
 *   3. 拷贝 node.exe，用 postject 把 blob 注入进去
 *
 * 产物：dist/cloudlinux-agent.exe（自包含，目标机器无需装 Node）
 *
 * 用法：
 *   node scripts/build-exe.mjs
 *   node scripts/build-exe.mjs --out dist/cloudlinux-agent.exe
 *   node scripts/build-exe.mjs --keep-build      # 保留中间产物，方便排查
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(HERE, '..');
const REPO_DIR = path.resolve(AGENT_DIR, '..');

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const KEEP_BUILD = args.includes('--keep-build');
const OUT = path.resolve(REPO_DIR, value('--out', path.join('dist', 'cloudlinux-agent.exe')));
const BUILD_DIR = path.join(AGENT_DIR, 'build');

// Node SEA 的魔数（官方固定值）
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(n, total, text) {
  console.log(`\n[${n}/${total}] ${text}`);
}

function run(cmd, argv, options = {}) {
  return execFileSync(cmd, argv, { stdio: 'inherit', cwd: AGENT_DIR, ...options });
}

function capture(cmd, argv) {
  return execFileSync(cmd, argv, { encoding: 'utf8', cwd: AGENT_DIR });
}

console.log('CloudLinux 助手 —— 构建单文件 EXE');
console.log(`  源码目录：${AGENT_DIR}`);
console.log(`  输出文件：${OUT}`);

/* ---------------- 前置检查 ---------------- */
if (process.platform !== 'win32') {
  console.warn('\n⚠  当前平台不是 Windows。SEA 产物是平台相关的，');
  console.warn('   在 Linux/macOS 上构建出来的可执行文件不能在 Windows 上运行。');
}

const nodeExe = process.execPath;
if (!fs.existsSync(nodeExe)) {
  console.error(`找不到 node 可执行文件：${nodeExe}`);
  process.exit(1);
}
const nodeMb = (fs.statSync(nodeExe).size / 1024 / 1024).toFixed(1);

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

/* ---------------- 1. esbuild 打包 ---------------- */
step(1, 2, 'esbuild 打包成单个 CJS 文件');
const bundlePath = path.join(BUILD_DIR, 'agent.cjs');
try {
  run('node', [
    path.join(AGENT_DIR, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join('src', 'index.js'),
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=cjs',
    `--outfile=${bundlePath}`,
    // node: 前缀的内置模块保持外部引用；SEA 里没有 node_modules
    '--external:node:*',
    '--log-level=warning',
  ]);
} catch (err) {
  console.error('\n打包失败。请先安装构建依赖： npm install');
  process.exit(1);
}
const bundleKb = (fs.statSync(bundlePath).size / 1024).toFixed(1);
console.log(`  ✓ 生成 ${path.relative(AGENT_DIR, bundlePath)}（${bundleKb} KB）`);

/* ---------------- 2. SEA：blob + 注入 ---------------- */
step(2, 2, 'Node SEA：生成 blob 并注入 node.exe');
const seaConfigPath = path.join(BUILD_DIR, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify({
  main: bundlePath,
  output: path.join(BUILD_DIR, 'agent.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));

try {
  run('node', ['--experimental-sea-config', seaConfigPath]);
  console.log('  ✓ 已生成 SEA blob');
} catch (err) {
  console.error('\n生成 SEA blob 失败。请确认 Node 版本 ≥ 20（当前 '
    + process.version + '）。');
  process.exit(1);
}

fs.copyFileSync(nodeExe, OUT);
console.log(`  ✓ 已拷贝 node 运行时（${nodeMb} MB）→ ${path.basename(OUT)}`);

const postject = path.join(AGENT_DIR, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postject)) {
  console.error('\n找不到 postject。请先安装构建依赖： npm install');
  process.exit(1);
}
try {
  run('node', [
    postject, OUT, 'NODE_SEA_BLOB', path.join(BUILD_DIR, 'agent.blob'),
    '--sentinel-fuse', SEA_FUSE,
  ]);
  console.log('  ✓ 已注入 SEA blob');
} catch (err) {
  console.error('\n注入失败。');
  process.exit(1);
}

/* ---------------- 完成 ---------------- */
const outMb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
if (!KEEP_BUILD) fs.rmSync(BUILD_DIR, { recursive: true, force: true });

console.log(`\n${'─'.repeat(60)}`);
console.log(`  构建完成： ${OUT}`);
console.log(`  体积：     ${outMb} MB（内含 Node 运行时，目标机器无需装 Node）`);
console.log(`${'─'.repeat(60)}`);
console.log(`
使用方式：
  1. 把 cloudlinux-agent.exe 放到任意目录（例如 D:\\CloudLinux\\）
  2. 双击运行 → 数据会自动放在同级的 data\\ 目录里（便携）
  3. 浏览器打开控制台，用终端/日志里的配对码配对

注意：
  · 这是控制台程序，双击会弹出一个命令行窗口；想要 GUI 请用启动器
    cloudlinux-launcher.exe（见 launcher/ 目录），它会负责启停与打开界面。
  · 想验证构建产物： "${path.relative(process.cwd(), OUT)}" --print-routes
`);
