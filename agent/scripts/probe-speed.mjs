#!/usr/bin/env node
/**
 * 对照测试：直连 vs 走代理，下载 QEMU 安装包的速度差异。
 * 每条各采样 10 秒。
 *
 * 用法： node scripts/probe-speed.mjs [代理地址]
 */
import { openStream } from '../src/download.js';

const FILE = 'qemu-w64-setup-20260811.exe';
const URL = `https://qemu.weilnetz.de/w64/${FILE}`;
const PROXY = process.argv[2] || 'http://127.0.0.1:7897';
const SAMPLE_MS = 10000;

function human(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function measure(label, proxyUrl) {
  return new Promise((resolve) => {
    let bytes = 0;
    let settled = false;
    const started = Date.now();
    const finish = (note) => {
      if (settled) return;
      settled = true;
      const sec = (Date.now() - started) / 1000;
      resolve({ label, bytes, sec, speed: sec > 0 ? bytes / sec : 0, note });
    };

    openStream(URL, { timeoutMs: 12000, proxyUrl })
      .then(({ res, status }) => {
        if (status !== 200 && status !== 206) {
          finish(`HTTP ${status}`);
          res.resume();
          return;
        }
        const total = Number(res.headers['content-length']) || 0;
        res.on('data', (c) => { bytes += c.length; });
        res.on('error', (e) => finish(`错误：${e.message}`));
        const timer = setTimeout(() => {
          try { res.destroy(); } catch { /* ignore */ }
          finish(total ? `文件共 ${human(total)}` : '');
        }, SAMPLE_MS);
        res.on('close', () => { clearTimeout(timer); finish('关闭'); });
      })
      .catch((e) => finish(`失败：${e.message}`));
  });
}

console.log('\nQEMU 安装包下载速度对照（各采样 10 秒）');
console.log(`  目标：${URL}\n`);

const direct = await measure('直连', null);
console.log(`  直连            ${human(direct.speed).padStart(10)}/s   ${direct.note || ''}`);

const proxied = await measure(`代理 ${PROXY}`, PROXY);
console.log(`  走代理          ${human(proxied.speed).padStart(10)}/s   ${proxied.note || ''}`);

console.log('');
if (proxied.speed > direct.speed * 1.5) {
  const times = direct.speed > 0 ? (proxied.speed / direct.speed) : 0;
  const minutes = Math.ceil(197 * 1024 * 1024 / proxied.speed / 60);
  console.log(`  → 代理快 ${times.toFixed(1)} 倍，197 MB 大约 ${minutes} 分钟`);
} else if (proxied.speed > 0) {
  console.log('  → 代理没有明显优势，直连即可。');
} else {
  console.log('  → 代理不可用，请检查端口或换一个地址。');
}
console.log('');
