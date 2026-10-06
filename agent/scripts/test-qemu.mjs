#!/usr/bin/env node
/**
 * QEMU 一键安装测试。
 *
 * 会真的去官方镜像下载安装包并静默装到便携目录，耗时较长（取决于网速）。
 * 安装是「释放式」的，想清理直接删掉 <便携目录>/runtime/qemu 即可。
 *
 * 用法：
 *   node scripts/test-qemu.mjs <配对码>
 *   node scripts/test-qemu.mjs <配对码> --timeout 900     # 单步最长等待秒数
 *   node scripts/test-qemu.mjs <配对码> --verify-only     # 只检测，不下载
 */
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = value('--base', 'http://127.0.0.1:8765');
const TIMEOUT_SEC = Number(value('--timeout', 900));
const VERIFY_ONLY = args.includes('--verify-only');
const PIN = args.find((a) => !a.startsWith('--') && a !== BASE && a !== String(TIMEOUT_SEC));

if (!PIN) {
  console.error('用法： node scripts/test-qemu.mjs <配对码> [--timeout 900] [--verify-only]');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`  \u2713 ${name}`); }
  else { failed += 1; console.log(`  \u2717 ${name}${extra ? `  → ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
};

async function call(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

console.log(`\nCloudLinux QEMU 一键安装测试 → ${BASE}`);

const pair = await call('/api/pair', { method: 'POST', body: { pin: PIN, label: 'qemu-test' } });
const token = pair.json?.data?.token;
if (!token) {
  console.error(`配对失败：${pair.json?.error || pair.text}`);
  process.exit(1);
}

/* 1. 状态与提示 */
console.log('\n[1] QEMU 状态');
const before = await call('/api/qemu', { token });
check('GET /api/qemu → 200', before.status === 200, `实际 ${before.status}`);
const info = before.json?.data || {};
check('报告了平台与是否支持自动安装', 'platform' in info && 'supported' in info, JSON.stringify(info).slice(0, 160));
check('给出了安装目录', typeof info.installDir === 'string' && info.installDir.length > 0, info.installDir);
check('给出了操作提示', Array.isArray(info.hints) && info.hints.length > 0);
console.log(`      · 平台：${info.platform}（自动安装：${info.supported ? '支持' : '不支持'}）`);
console.log(`      · 安装目录：${info.installDir}`);
console.log(`      · 当前状态：${info.state}，已装：${info.managed ? '是' : '否'}${info.version ? `（${info.version}）` : ''}`);
console.log(`      · 提示：${(info.hints || [])[0] || ''}`);

if (VERIFY_ONLY) {
  const v = await call('/api/qemu/verify', { method: 'POST', token });
  console.log(`\n[2] 仅检测：${v.json?.data?.ok ? `找到 ${v.json.data.version}` : `未找到（${v.json?.data?.error}）`}`);
  console.log(`\n  通过 ${passed} 项，失败 ${failed} 项\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/* 2. 启动安装 */
console.log('\n[2] 一键安装');
const t0 = Date.now();
const start = await call('/api/qemu/install', { method: 'POST', token, body: {} });
check('POST /api/qemu/install 立即返回', start.status === 200, `实际 ${start.status} ${start.text?.slice(0, 140)}`);
check('响应很快（<2s，说明没阻塞在下载上）', Date.now() - t0 < 2000, `实际 ${Date.now() - t0}ms`);
check('返回 started 标记', start.json?.data?.started === true);

if (start.status !== 200) {
  console.log('\n安装未能启动，后续测试跳过。\n');
  process.exit(1);
}

/* 3. 轮询进度 */
console.log('\n[3] 安装进度（轮询 /api/qemu）');
const deadline = Date.now() + TIMEOUT_SEC * 1000;
let last = null;
let sawDownloading = false;
let sawInstalling = false;
let lastNote = '';

while (Date.now() < deadline) {
  const r = await call('/api/qemu', { token });
  const d = r.json?.data || {};
  last = d;
  const p = d.progress || {};
  if (d.state === 'downloading') sawDownloading = true;
  if (d.state === 'installing') sawInstalling = true;

  const note = d.state === 'downloading'
    ? `下载中 ${bytes(p.bytes)}${p.total ? ` / ${bytes(p.total)}` : ''} ${p.speedText || ''}${p.etaSec ? ` 剩余 ${p.etaSec}s` : ''}`
    : `${d.state}${p.note ? ` · ${p.note}` : ''}`;
  if (note !== lastNote) {
    lastNote = note;
    console.log(`      · ${note}`);
  }

  if (d.state === 'idle' && d.lastResult) break;
  if (d.state === 'error') break;
  await sleep(1500);
}

check('观察到「下载中」阶段', sawDownloading, `最终状态 ${last?.state}`);
check('观察到「安装中」阶段', sawInstalling, `最终状态 ${last?.state}`);
check('任务已结束（idle 或 error）', last?.state === 'idle' || last?.state === 'error', `实际 ${last?.state}`);

if (last?.state === 'error') {
  check('安装成功', false, last.error || '未知错误');
  console.log(`\n  失败原因：${last.error}`);
  console.log('  若提示 UAC / 权限，请手动确认后重试。\n');
  console.log(`  通过 ${passed} 项，失败 ${failed} 项\n`);
  process.exit(1);
}

const result = last?.lastResult || {};
console.log(`      · 版本：${result.version}`);
console.log(`      · 安装到：${result.installDir}`);
check('安装结果包含版本号', Boolean(result.version), JSON.stringify(result).slice(0, 200));

/* 4. 独立验证：真的能跑起来 */
console.log('\n[4] 复核（换个接口重新检测）');
const verify = await call('/api/qemu/verify', { method: 'POST', token });
check('POST /api/qemu/verify → 200', verify.status === 200, `实际 ${verify.status}`);
check('检测到可用的 qemu-system', verify.json?.data?.ok === true, JSON.stringify(verify.json?.data));
check('给出了版本号', Boolean(verify.json?.data?.version), verify.json?.data?.version);
check('同时找到了 qemu-img（用于建盘/快照）', Boolean(verify.json?.data?.qemuImgPath),
  verify.json?.data?.qemuImgPath || '未找到');
console.log(`      · ${verify.json?.data?.version}`);

/* 5. 配置是否已写入，虚拟机能否用上 */
console.log('\n[5] 配置已写入');
const cfg = await call('/api/config', { token });
const vmCfg = cfg.json?.data?.vm || {};
check('vm.qemuPath 已写入', Boolean(vmCfg.qemuPath), vmCfg.qemuPath);
check('vm.qemuImgPath 已写入', Boolean(vmCfg.qemuImgPath), vmCfg.qemuImgPath);
const vmStatus = await call('/api/vm/status', { token });
check('虚拟机面板报告 QEMU 可用', vmStatus.json?.data?.qemu?.available === true,
  JSON.stringify(vmStatus.json?.data?.qemu));

console.log(`\n${'─'.repeat(46)}`);
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${'─'.repeat(46)}\n`);
process.exit(failed === 0 ? 0 : 1);
