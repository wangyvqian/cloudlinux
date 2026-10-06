#!/usr/bin/env node
/**
 * 冒烟测试：验证助手的安全策略与核心接口。
 *
 * 用法：
 *   node scripts/smoke-test.mjs <配对码>
 *   node scripts/smoke-test.mjs <配对码> --base http://127.0.0.1:8765
 *
 * 退出码 0 表示全部通过。
 */
import net from 'node:net';

const args = process.argv.slice(2);
const baseFlagIndex = args.indexOf('--base');
const BASE = baseFlagIndex >= 0 ? args[baseFlagIndex + 1] : 'http://127.0.0.1:8765';
const PIN = args.find((a, i) => !a.startsWith('--') && (baseFlagIndex < 0 || i !== baseFlagIndex + 1));

if (!PIN) {
  console.error('用法： node scripts/smoke-test.mjs <配对码> [--base http://127.0.0.1:8765]');
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

/**
 * 用原始 TCP 发请求，这样才能真正伪造 Host 头（fetch/undici 会强制覆盖它）。
 */
function rawRequest(pathname, headers = {}) {
  const url = new URL(BASE);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) || 80 }, () => {
      const lines = [`GET ${pathname} HTTP/1.1`, `Host: ${headers.Host || url.host}`, 'Connection: close'];
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== 'host') lines.push(`${key}: ${value}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let raw = '';
    socket.setTimeout(6000);
    socket.on('data', (chunk) => { raw += chunk.toString('utf8'); });
    socket.on('close', () => {
      const match = raw.match(/^HTTP\/1\.1 (\d{3})/);
      resolve({ status: match ? Number(match[1]) : 0, raw });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ status: 0, raw }); });
    socket.on('error', (err) => resolve({ status: 0, raw, error: err.message }));
  });
}

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

console.log(`\nCloudLinux 助手冒烟测试 → ${BASE}\n`);

/* 1. 公开接口 */
console.log('[1] 公开接口');
const ping = await call('/api/ping');
check('GET /api/ping 返回 200', ping.status === 200, `实际 ${ping.status}`);
check('返回 service 标识', ping.json?.data?.service === 'cloudlinux-agent', JSON.stringify(ping.json).slice(0, 120));
check('报告配对状态', typeof ping.json?.data?.paired === 'boolean');

/* 2. 鉴权拦截 */
console.log('\n[2] 鉴权拦截');
const noAuth = await call('/api/overview');
check('无 token 访问 /api/overview → 401', noAuth.status === 401, `实际 ${noAuth.status}`);
const badToken = await call('/api/overview', { token: 'deadbeef' });
check('错误 token → 401', badToken.status === 401, `实际 ${badToken.status}`);

/* 3. 配对 */
console.log('\n[3] 配对流程');
const wrongPin = await call('/api/pair', { method: 'POST', body: { pin: 'WRONG9' } });
check('错误配对码 → 401', wrongPin.status === 401, `实际 ${wrongPin.status}`);

const pair = await call('/api/pair', { method: 'POST', body: { pin: PIN, label: 'smoke-test' } });
check('正确配对码 → 200', pair.status === 200, `实际 ${pair.status} ${pair.text?.slice(0, 120)}`);
const token = pair.json?.data?.token;
check('返回了长期令牌', typeof token === 'string' && token.length === 64, `token=${String(token).slice(0, 12)}…`);
if (!token) {
  console.log('\n配对失败，后续测试无法继续。\n');
  process.exit(1);
}

/* 4. 边界防护 */
console.log('\n[4] 浏览器侧边界防护');
const badOrigin = await call('/api/overview', { token, headers: { Origin: 'https://evil.example.com' } });
check('未授权 Origin → 403', badOrigin.status === 403, `实际 ${badOrigin.status}`);
const goodOrigin = await call('/api/overview', { token, headers: { Origin: 'https://wangyvqian.github.io' } });
check('GitHub Pages Origin → 200', goodOrigin.status === 200, `实际 ${goodOrigin.status}`);
const localOrigin = await call('/api/overview', { token, headers: { Origin: 'http://localhost:5173' } });
check('localhost Origin → 200', localOrigin.status === 200, `实际 ${localOrigin.status}`);

const badHost = await rawRequest('/api/ping', { Host: 'evil.example.com' });
check('伪造 Host 头 → 403', badHost.status === 403, `实际 ${badHost.status}`);
const normalHost = await rawRequest('/api/ping', { Host: '127.0.0.1:' + new URL(BASE).port });
check('正常 Host 头 → 200', normalHost.status === 200, `实际 ${normalHost.status}`);

/* 5. 核心数据接口 */
console.log('\n[5] 核心接口');
const overview = await call('/api/overview', { token });
check('GET /api/overview → 200', overview.status === 200);
check('包含 agent / vm / sync', Boolean(overview.json?.data?.agent && overview.json?.data?.vm && overview.json?.data?.sync));

const config = await call('/api/config', { token });
check('GET /api/config → 200', config.status === 200);
check('VNC 密码已脱敏', config.json?.data?.vm?.vnc?.password === '' || config.json?.data?.vm?.vnc?.password === '********',
  `实际 ${JSON.stringify(config.json?.data?.vm?.vnc?.password)}`);

const vmStatus = await call('/api/vm/status', { token });
check('GET /api/vm/status → 200', vmStatus.status === 200);
check('报告了 QEMU 可用性', typeof vmStatus.json?.data?.qemu?.available === 'boolean');
console.log(`      · 运行状态：${vmStatus.json?.data?.state}`);
console.log(`      · QEMU：${vmStatus.json?.data?.qemu?.path || '未检测到'}`);
console.log(`      · 加速器候选：${(vmStatus.json?.data?.accelCandidates || []).join(' → ')}`);

const logs = await call('/api/logs?limit=5', { token });
check('GET /api/logs → 200', logs.status === 200);
check('日志有内容', Array.isArray(logs.json?.data?.entries));

const devices = await call('/api/devices', { token });
check('GET /api/devices → 200', devices.status === 200);
console.log(`      · 串口：${devices.json?.data?.serial?.length ?? 0} 个`);
console.log(`      · USB ：${devices.json?.data?.usb?.length ?? 0} 个`);

/* 6. 快照在无 QEMU 时应优雅报错 */
console.log('\n[6] 错误处理');
const badSnapshot = await call('/api/vm/snapshots', { method: 'POST', token, body: { name: 'x' } });
check('无 QEMU 时创建快照 → 503/500（不崩溃）', [503, 500].includes(badSnapshot.status), `实际 ${badSnapshot.status}`);
check('错误信息可读', typeof badSnapshot.json?.error === 'string' && badSnapshot.json.error.length > 0);

const notFound = await call('/api/nope', { token });
check('未知路由 → 404', notFound.status === 404, `实际 ${notFound.status}`);

/* 7. 令牌管理 */
console.log('\n[7] 令牌管理');
const tokens = await call('/api/security/tokens', { token });
check('GET /api/security/tokens → 200', tokens.status === 200);
check('至少有一个已配对设备', (tokens.json?.data?.tokens?.length ?? 0) >= 1);

const created = tokens.json?.data?.tokens?.find((t) => t.label === 'smoke-test');
check('找到本次测试的令牌记录', Boolean(created));
if (created) {
  const revoked = await call(`/api/security/tokens/${created.id}`, { method: 'DELETE', token });
  check('撤销令牌 → 200', revoked.status === 200, `实际 ${revoked.status}`);
  const afterRevoke = await call('/api/overview', { token });
  check('被撤销的令牌立即失效 → 401', afterRevoke.status === 401, `实际 ${afterRevoke.status}`);
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${'─'.repeat(46)}\n`);
process.exit(failed === 0 ? 0 : 1);
