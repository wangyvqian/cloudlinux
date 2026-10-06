#!/usr/bin/env node
/**
 * 直接通过 API 触发一个后台任务并退出（便于在别处轮询）。
 *
 * 用法：
 *   node scripts/trigger.mjs <配对码> qemu-install
 *   node scripts/trigger.mjs <配对码> image-download <catalogId>
 *   node scripts/trigger.mjs <配对码> image-prepare <catalogId> [--qemu]
 *   node scripts/trigger.mjs <配对码> status
 */
const args = process.argv.slice(2);
const BASE = process.env.CLOUDLINUX_BASE || 'http://127.0.0.1:8765';
const PIN = args[0];
const ACTION = args[1];
const ARG = args[2];

if (!PIN || !ACTION) {
  console.error('用法： node scripts/trigger.mjs <配对码> <qemu-install|image-download|image-prepare|status> [参数]');
  process.exit(2);
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
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
  return { status: res.status, json };
}

const pair = await call('/api/pair', { method: 'POST', body: { pin: PIN, label: 'trigger' } });
const token = pair.json?.data?.token;
if (!token) {
  console.error('配对失败：', pair.json?.error || `HTTP ${pair.status}`);
  process.exit(1);
}

let out;
if (ACTION === 'qemu-install') {
  out = await call('/api/qemu/install', { method: 'POST', token, body: {} });
} else if (ACTION === 'image-download') {
  out = await call('/api/images/download', { method: 'POST', token, body: { id: ARG } });
} else if (ACTION === 'image-prepare') {
  out = await call('/api/images/prepare', {
    method: 'POST',
    token,
    body: { id: ARG, installQemu: args.includes('--qemu') },
  });
} else if (ACTION === 'status') {
  const q = await call('/api/qemu', { token });
  const img = await call('/api/images/status', { token });
  console.log('QEMU：', q.json?.data?.state, JSON.stringify(q.json?.data?.progress || {}));
  console.log('镜像：', img.json?.data?.active?.phase || 'idle',
    JSON.stringify(img.json?.data?.active || {}));
  process.exit(0);
} else {
  console.error('未知动作：' + ACTION);
  process.exit(2);
}

console.log(`HTTP ${out.status}  ${out.json?.data?.message || out.json?.error || ''}`);
process.exit(out.status === 200 ? 0 : 1);
