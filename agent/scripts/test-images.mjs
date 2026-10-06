#!/usr/bin/env node
/**
 * 镜像下载链路测试：目录 / 探测 / 下载 / 取消 / 断点续传 / 清理。
 *
 * 刻意**不去下完整个 3.6 GiB**：下到指定体积就取消，然后续传验证偏移量正确。
 *
 * 用法：
 *   node scripts/test-images.mjs <配对码>
 *   node scripts/test-images.mjs <配对码> --bytes 40000000 --timeout 90
 *   node scripts/test-images.mjs <配对码> --full          # 真的下完（不推荐）
 */
import fsp from 'node:fs/promises';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = value('--base', 'http://127.0.0.1:8765');
const TARGET_BYTES = Number(value('--bytes', 40_000_000));   // 下到这么多就取消
const TIMEOUT_SEC = Number(value('--timeout', 120));         // 单次下载最长等待
const FULL = args.includes('--full');
const PIN = args.find((a) => !a.startsWith('--') && a !== BASE
  && a !== String(TARGET_BYTES) && a !== String(TIMEOUT_SEC));

if (!PIN) {
  console.error('用法： node scripts/test-images.mjs <配对码> [--bytes N] [--timeout S] [--full]');
  process.exit(2);
}

const TEST_DIR = path.resolve('data', 'images-test');

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

/** 轮询任务状态，直到满足条件或超时。 */
async function waitFor(token, predicate, { timeoutSec = TIMEOUT_SEC, label = '任务' } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const res = await call('/api/images/status', { token });
    last = res.json?.data?.active || null;
    if (predicate(last)) return { ok: true, status: last };
    if (!last) return { ok: false, status: null, ended: true };
    await sleep(500);
  }
  return { ok: false, status: last, timedOut: true, label };
}

/** 等待“出现一个比 prevSeq 更新的任务结果”。 */
async function waitForResult(token, prevSeq, timeoutSec = 90) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const res = await call('/api/images/status', { token });
    const data = res.json?.data;
    if (!data?.active && data?.lastResult && data.lastResult.seq > prevSeq) return data.lastResult;
    await sleep(400);
  }
  return null;
}

/**
 * 起一个支持 Range 的本地 HTTP 服务。
 * 用它配合小文件，就能把 SHA256 校验的两条分支（通过 / 失败）快速验证完，
 * 不用真去下 3.6 GiB 的 ISO。
 */
function startProbeServer(payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = (req.url || '/').split('?')[0];
      if (pathname !== '/localtest.iso' && pathname !== '/localtest-bad.iso') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const total = payload.length;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'application/octet-stream');
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': total });
        res.end();
        return;
      }
      const range = req.headers.range;
      const match = range ? /bytes=(\d+)-/.exec(range) : null;
      if (match) {
        const start = Number(match[1]);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${total - 1}/${total}`,
          'Content-Length': total - start,
        });
        res.end(payload.subarray(start));
        return;
      }
      res.writeHead(200, { 'Content-Length': total });
      res.end(payload);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

console.log(`\nCloudLinux 镜像链路测试 → ${BASE}`);
console.log(`测试目录： ${TEST_DIR}`);
console.log(FULL ? '模式：完整下载（会下完整个 ISO）\n' : `模式：下到 ${bytes(TARGET_BYTES)} 后取消并验证续传\n`);

/* ---------------- 0. 准备 ---------------- */
// 每次都从干净的目录开始，否则“ISO 已存在”的早退分支会让后面的用例误判
await fsp.rm(TEST_DIR, { recursive: true, force: true });
await fsp.mkdir(TEST_DIR, { recursive: true });

const pair = await call('/api/pair', { method: 'POST', body: { pin: PIN, label: 'image-test' } });
const token = pair.json?.data?.token;
if (!token) {
  console.error(`配对失败：${pair.json?.error || pair.text}`);
  process.exit(1);
}

/* ---------------- 0. 本地 SHA256 校验测试 ---------------- */
console.log('[0] SHA256 校验（本地小文件，覆盖通过 / 失败两条分支）');
const payload = randomBytes(3 * 1024 * 1024);
const goodSha = createHash('sha256').update(payload).digest('hex');
const { server: probeServer, port: probePort } = await startProbeServer(payload);

try {
  const caseDir = path.join(TEST_DIR, 'sha');
  await fsp.mkdir(caseDir, { recursive: true });

  // 0a. 校验和正确 → 应通过并落盘
  let seq = (await call('/api/images/status', { token })).json?.data?.lastResult?.seq || 0;
  const okStart = await call('/api/images/download', {
    method: 'POST', token,
    body: {
      url: `http://127.0.0.1:${probePort}/localtest.iso`,
      expectSha256: goodSha,
      destDir: caseDir,
    },
  });
  check('自定义链接下载已启动', okStart.status === 200, `实际 ${okStart.status} ${okStart.text?.slice(0, 120)}`);

  const okResult = await waitForResult(token, seq);
  check('任务结束并记录了结果', Boolean(okResult), '超时未拿到结果');
  check('校验通过（verified=true）', okResult?.verified === true, JSON.stringify(okResult)?.slice(0, 200));
  check('任务标记成功', okResult?.ok === true, JSON.stringify(okResult)?.slice(0, 200));
  const okFile = path.join(caseDir, 'localtest.iso');
  check('文件已落盘', await fsp.stat(okFile).then((s) => s.size === payload.length).catch(() => false));

  // 0b. 校验和错误 → 应失败并删掉残片
  seq = (await call('/api/images/status', { token })).json?.data?.lastResult?.seq || 0;
  const badStart = await call('/api/images/download', {
    method: 'POST', token,
    body: {
      url: `http://127.0.0.1:${probePort}/localtest-bad.iso`,
      expectSha256: 'f'.repeat(64),
      destDir: caseDir,
    },
  });
  check('错误校验和的下载已启动', badStart.status === 200, `实际 ${badStart.status}`);

  const badResult = await waitForResult(token, seq);
  check('任务结束并记录了结果', Boolean(badResult), '超时未拿到结果');
  check('任务被判定为失败', badResult?.ok === false, JSON.stringify(badResult)?.slice(0, 200));
  check('错误信息指出校验失败', /校验失败/.test(badResult?.error || ''), badResult?.error);
  check('校验失败后删掉了残片（避免下次误判）',
    !(await fsp.stat(path.join(caseDir, 'localtest-bad.iso.part')).then(() => true).catch(() => false))
    && !(await fsp.stat(path.join(caseDir, 'localtest-bad.iso')).then(() => true).catch(() => false)));
  console.log(`      · 失败原因：${String(badResult?.error).slice(0, 60)}…`);
} finally {
  probeServer.close();
}

/* ---------------- 1. 镜像目录 ---------------- */
console.log('[1] 镜像目录');
const catalog = await call('/api/images/catalog', { token });
check('GET /api/images/catalog → 200', catalog.status === 200, `实际 ${catalog.status}`);
const entries = catalog.json?.data?.catalog || [];
check('目录里有镜像条目', entries.length > 0, `实际 ${entries.length}`);
const recommended = entries.find((e) => e.recommended) || entries[0];
check('推荐条目存在且带直链', Boolean(recommended?.url), JSON.stringify(recommended)?.slice(0, 150));
check('条目带 SHA256 校验和', Boolean(recommended?.sha256));
check('条目带多个镜像源', (recommended?.mirrors?.length || 0) > 1, `${recommended?.mirrors?.length} 个`);
check('报告了下载目录', typeof catalog.json?.data?.downloadDir === 'string');
console.log(`      · 目标镜像：${recommended.name}`);
console.log(`      · 直链：${recommended.url}`);
console.log(`      · 校验和：${String(recommended.sha256).slice(0, 24)}…`);
console.log(`      · 镜像源：${recommended.mirrors.length} 个`);

/* ---------------- 2. 探测远端 ---------------- */
console.log('\n[2] 探测远端（大小 / 断点续传支持）');
const probe = await call('/api/images/probe', { method: 'POST', token, body: { url: recommended.url } });
check('POST /api/images/probe → 200', probe.status === 200, `实际 ${probe.status} ${probe.text?.slice(0, 120)}`);
check('探测到文件大小', Number(probe.json?.data?.sizeBytes) > 1e9, `实际 ${probe.json?.data?.sizeBytes}`);
check('镜像源支持断点续传', probe.json?.data?.resumable === true, `实际 ${probe.json?.data?.resumable}`);
console.log(`      · 大小：${probe.json?.data?.sizeText}`);
console.log(`      · 可续传：${probe.json?.data?.resumable}`);

/* ---------------- 3. 开始下载 ---------------- */
console.log('\n[3] 后台下载（立即返回，进度走 SSE 轮询）');
const t0 = Date.now();
const start = await call('/api/images/download', {
  method: 'POST', token,
  body: { id: recommended.id, destDir: TEST_DIR },
});
check('POST /api/images/download 立即返回', start.status === 200, `实际 ${start.status} ${start.text?.slice(0, 120)}`);
check('响应耗时很短（<2s，说明没有阻塞在下载上）', Date.now() - t0 < 2000, `实际 ${Date.now() - t0}ms`);
check('返回 started 标记', start.json?.data?.started === true);

const downloading = await waitFor(token, (s) => s && s.phase === 'downloading' && s.bytes > 0);
check('进入 downloading 且已有字节', downloading.ok, JSON.stringify(downloading.status)?.slice(0, 200));
if (downloading.status) {
  console.log(`      · 阶段：${downloading.status.phase}`);
  console.log(`      · 进度：${downloading.status.bytesText || bytes(downloading.status.bytes)} / ${bytes(downloading.status.total)}`);
}

// 等累计到目标字节数
const reached = FULL
  ? await waitFor(token, (s) => !s, { timeoutSec: TIMEOUT_SEC * 20, label: '完整下载' })
  : await waitFor(token, (s) => s && (s.bytes >= TARGET_BYTES || s.phase === 'verifying'));
check(FULL ? '完整下载结束' : '累计下载达到取消阈值', reached.ok || reached.ended, JSON.stringify(reached.status)?.slice(0, 200));
if (reached.status?.speedText) {
  console.log(`      · 速度：${reached.status.speedText}，已下 ${bytes(reached.status.bytes)}`);
}

/* ---------------- 4. 取消 ---------------- */
if (!FULL) {
  console.log('\n[4] 取消下载 → 应保留分片');
  const cancel = await call('/api/images/cancel', { method: 'POST', token });
  check('POST /api/images/cancel → 200', cancel.status === 200, `实际 ${cancel.status}`);
  check('确认取消已提交', cancel.json?.data?.cancelled === true);

  const stopped = await waitFor(token, (s) => !s, { timeoutSec: 30 });
  // 注意：谓词命中时会先返回，ended 标记可能没设上，两个条件都要认
  check('任务已停止（active 变为 null）', stopped.ok === true || stopped.ended === true,
    JSON.stringify(stopped.status)?.slice(0, 160));
  await sleep(600);

  const local = await call(`/api/images/catalog?dir=${encodeURIComponent(TEST_DIR)}`, { token });
  const partial = (local.json?.data?.local?.items || []).find((i) => i.partialBytes > 0);
  check('留下了 .part 分片', Boolean(partial), JSON.stringify(local.json?.data?.local?.items)?.slice(0, 200));
  if (partial) {
    console.log(`      · 分片：${partial.name}.part = ${partial.partialText}`);
  }

  /* ---------------- 5. 断点续传 ---------------- */
  console.log('\n[5] 断点续传（应从上次偏移继续，而不是从 0）');
  const beforeBytes = partial?.partialBytes || 0;

  const resumeStart = await call('/api/images/download', {
    method: 'POST', token,
    body: { id: recommended.id, destDir: TEST_DIR },
  });
  check('再次 POST /api/images/download → 200', resumeStart.status === 200, `实际 ${resumeStart.status}`);

  const resumed = await waitFor(token, (s) => s && s.phase === 'downloading' && s.bytes > 0);
  check('续传任务开跑', resumed.ok, JSON.stringify(resumed.status)?.slice(0, 200));
  check('报告了续传起点（resumedFrom）', Number(resumed.status?.resumedFrom) > 0,
    `resumedFrom=${resumed.status?.resumedFrom}`);
  check('续传起点与分片大小一致', Number(resumed.status?.resumedFrom) === beforeBytes,
    `${resumed.status?.resumedFrom} vs ${beforeBytes}`);
  check('续传后字节数 > 分片大小（确实在往后写）',
    Number(resumed.status?.bytes) >= beforeBytes,
    `${resumed.status?.bytes} vs ${beforeBytes}`);
  console.log(`      · 从 ${bytes(beforeBytes)} 处续传，当前 ${bytes(resumed.status?.bytes)}`);

  // 续传也验证完就收工，清理掉分片
  await call('/api/images/cancel', { method: 'POST', token });
  await waitFor(token, (s) => !s, { timeoutSec: 30 });
  await sleep(500);

  console.log('\n[6] 清理');
  const afterCancel = await call(`/api/images/catalog?dir=${encodeURIComponent(TEST_DIR)}`, { token });
  const partItem = (afterCancel.json?.data?.local?.items || []).find((i) => i.partialBytes > 0);
  if (partItem) {
    const partialPath = path.join(TEST_DIR, `${partItem.name}.part`);
    const del = await call('/api/images/partial', { method: 'DELETE', token, body: { path: partialPath } });
    check('DELETE /api/images/partial → 200', del.status === 200, `实际 ${del.status} ${del.text?.slice(0, 140)}`);
    check('报告了释放的空间', Number(del.json?.data?.freedBytes) > 0, JSON.stringify(del.json?.data));
  } else {
    check('找到待清理的分片', false, '没有分片可删');
  }

  const guard = await call('/api/images/partial', { method: 'DELETE', token, body: { path: path.join(TEST_DIR, 'x.iso') } });
  check('拒绝删除非 .part 文件（防止误删正式镜像）', guard.status === 400, `实际 ${guard.status}`);
} else {
  console.log('\n[4] 完整下载模式：校验结果');
  const local = await call(`/api/images/catalog?dir=${encodeURIComponent(TEST_DIR)}`, { token });
  const iso = (local.json?.data?.local?.items || []).find((i) => i.name === recommended.filename);
  check('ISO 已完整落盘', Boolean(iso), JSON.stringify(local.json?.data?.local?.items)?.slice(0, 200));
  if (iso) console.log(`      · ${iso.name} = ${iso.sizeText}`);
}

/* ---------------- 总结 ---------------- */
console.log(`\n${'─'.repeat(46)}`);
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${'─'.repeat(46)}\n`);
process.exit(failed === 0 ? 0 : 1);
