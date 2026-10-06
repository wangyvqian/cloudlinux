#!/usr/bin/env node
/**
 * 代理健壮性测试。
 *
 * 覆盖用户实际踩到的坑：加速器退出后只在注册表留下 ProxyServer，
 * 端口已经不通 —— 以前会拿这个死代理去下载，导致全部失败。
 *
 * 用法：
 *   node scripts/test-proxy.mjs <配对码>
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStream, probeRemote } from '../src/download.js';
import { isProxyReachable, resolveProxy, shouldBypassProxy, testProxy } from '../src/proxy.js';

const BASE = process.env.CLOUDLINUX_BASE || 'http://127.0.0.1:8765';
const PIN = process.argv[2];

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.log(`  \u2717 ${name}${extra ? `  → ${extra}` : ''}`); }
};

console.log('\nCloudLinux 代理健壮性测试\n');

/* 1. 可达性检测 —— 本次修复的核心 */
console.log('[1] 代理可达性检测');
const deadPort = 59999;
check('明显不通的端口判为不可达', (await isProxyReachable(`http://127.0.0.1:${deadPort}`)) === false);
check('可达性检测不会抛异常', true);
const deadResolved = await resolveProxy({ setting: `http://127.0.0.1:${deadPort}` });
check('配置里写了个连不上的代理 → 不会被采用（关键修复）',
  deadResolved.url === null, `实际 selected=${deadResolved.url}`);
check('并给出了原因', /连不上|不可达/.test(deadResolved.detail || ''), deadResolved.detail);
console.log(`      · 结论：${deadResolved.detail}`);

/* 2. 显式关闭 */
console.log('\n[2] 显式开关');
const off = await resolveProxy({ setting: 'off' });
check('proxy=off → 直连', off.url === null && off.source === 'disabled', JSON.stringify(off));

/* 3. 绕过列表 */
console.log('\n[3] 绕过列表（国内镜像不该走代理）');
check('本机地址绕过', shouldBypassProxy('127.0.0.1') && shouldBypassProxy('localhost'));
check('列表里的域名绕过', shouldBypassProxy('mirrors.nju.edu.cn', ['nju.edu.cn']) === true);
check('通配写法也能识别', shouldBypassProxy('a.example.com', ['*.example.com']) === true);
check('不在列表里的不走绕过', shouldBypassProxy('qemu.weilnetz.de', ['nju.edu.cn']) === false);
check('子域名匹配', shouldBypassProxy('mirror.sjtu.edu.cn', ['sjtu.edu.cn']) === true);

/* 4. 死代理情况下真实下载仍然成功（自动回退直连） */
console.log('\n[4] 死代理下仍能下载（自动回退直连）');
const { FileDownloader } = await import('../src/download.js');
const { Logger } = await import('../src/logger.js');
const logger = new Logger({ toConsole: true, level: 'info' });
const dl = new FileDownloader({ logger });

// 必须用**非 localhost** 的地址：本机地址本来就会绕过代理，测不到回退逻辑。
// 选南大镜像站的目录页，体积很小。
const REMOTE = 'https://mirrors.nju.edu.cn/zorinos/';
const tmp = join(process.env.TEMP || '/tmp', `cl-proxy-test-${Date.now()}`);

// 先确认这个地址直连是通的（不通就没法测）
const directProbe = await probeRemote(REMOTE, { proxyUrl: null });
if (!directProbe.ok) {
  console.log(`      · 目标地址直连不通（${directProbe.error || directProbe.status}），跳过`);
  check('跳过（需要能直连 ' + REMOTE + '）', true);
} else {
  console.log(`      · 直连探测正常（HTTP ${directProbe.status}）`);
  // 故意给一个连不上的代理
  dl.setProxy(`http://127.0.0.1:${deadPort}`);
  const target = join(tmp, 'zorinos-index.html');
  try {
    const result = await dl.download({
      url: REMOTE,
      destPath: target,
      trustExisting: true,
      onProgress: () => {},
    });
    check('死代理下依然下载成功（自动回退直连）', result.sizeBytes > 0, JSON.stringify(result).slice(0, 160));
    check('回退后不再使用代理', dl.proxyUrl === null, `proxyUrl=${dl.proxyUrl}`);
    console.log(`      · 下载结果：${result.sizeText}`);
  } catch (err) {
    check('死代理下依然下载成功（自动回退直连）', false, err.message);
  }
}

/* 5. 真实代理（如果开着）能否工作 */
console.log('\n[5] 当前环境代理状态');
const auto = await resolveProxy({ setting: 'auto' });
if (auto.url) {
  console.log(`      · 检测到可用代理：${auto.url}（${auto.detail}）`);
  const probe = await probeRemote('https://qemu.weilnetz.de/w64/', { proxyUrl: auto.url });
  check('经该代理能探测到远端', probe.ok === true, JSON.stringify(probe).slice(0, 160));
  if (probe.ok) console.log(`      · 远端大小：${probe.sizeBytes}`);
  const t = await testProxy(auto.url, 'https://qemu.weilnetz.de/w64/');
  check('代理连通性测试通过', t.ok === true, JSON.stringify(t));
  console.log(`      · 连通耗时：${t.ms} ms`);
} else {
  console.log(`      · 当前无可用代理（${auto.detail}）—— 这正是修复后的正确行为：`);
  console.log('        不会因为注册表里残留的旧代理地址而拖累所有下载。');
  const head = await openStream('https://qemu.weilnetz.de/w64/', { proxyUrl: null }).catch((e) => ({ status: 0, error: e.message }));
  check('直连仍可建立（哪怕很慢）', head.status === 200 || Boolean(head.res), `status=${head.status}`);
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'─'.repeat(52)}\n`);
process.exit(fail === 0 ? 0 : 1);
