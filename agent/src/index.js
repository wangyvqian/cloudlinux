#!/usr/bin/env node
/**
 * CloudLinux 桌面助手 —— 入口。
 *
 *   node src/index.js                   启动助手
 *   node src/index.js --new-pin         重新生成配对码（会解绑所有设备）
 *   node src/index.js --reset-pairing   解绑所有设备
 *   node src/index.js --print-routes    打印 API 路由表
 */
import os from 'node:os';
import path from 'node:path';
import { createRouter } from './api.js';
import { AGENT_ROOT, AGENT_VERSION, ConfigStore } from './config.js';
import { DeviceManager } from './devices.js';
import { EventHub } from './events.js';
import { ImageManager } from './images.js';
import { Logger } from './logger.js';
import { SecurityManager } from './security.js';
import { createAgentServer } from './server.js';
import { SyncManager } from './sync.js';
import { VmManager } from './vm.js';
import { ensureDir } from './util.js';

const HELP = `
CloudLinux 桌面助手 v${AGENT_VERSION}

用法： node src/index.js [选项]

选项：
  --host <addr>       监听地址（默认 127.0.0.1，强烈建议不要改成 0.0.0.0）
  --port <n>          监听端口（默认 8765）
  --data <dir>        数据目录（默认 <agent>/data）
  --log-level <lvl>   debug | info | warn | error
  --new-pin           重新生成配对码并解绑所有设备，然后退出
  --reset-pairing     解绑所有已配对设备，然后退出
  --print-routes      打印 API 路由表，然后退出
  -h, --help          显示帮助
  -v, --version       显示版本

环境变量：
  CLOUDLINUX_DATA     等同于 --data
`.trim();

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const key = token.replace(/^--?/, '');
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) {
      args.values[key] = next;
      i += 1;
    } else {
      args.flags.add(key);
    }
  }
  return args;
}

/** 终端里中日韩字符占两格，需要单独算宽度才能对齐。 */
const displayWidth = (text) =>
  [...text].reduce((sum, ch) => sum + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);

function banner(lines) {
  const inner = Math.max(...lines.map((l) => displayWidth(l))) + 4;
  const border = '═'.repeat(inner);
  console.log(`\n╔${border}╗`);
  for (const line of lines) {
    const pad = inner - displayWidth(line) - 2;
    console.log(`║  ${line}${' '.repeat(Math.max(0, pad))}  ║`);
  }
  console.log(`╚${border}╝\n`);
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));

  if (argv.flags.has('h') || argv.flags.has('help')) {
    console.log(HELP);
    return;
  }
  if (argv.flags.has('v') || argv.flags.has('version')) {
    console.log(AGENT_VERSION);
    return;
  }

  const dataDir = path.resolve(
    argv.values.data || process.env.CLOUDLINUX_DATA || path.join(AGENT_ROOT, 'data'),
  );
  await ensureDir(dataDir);

  const overrides = {};
  if (argv.values.host) overrides.agent = { ...(overrides.agent || {}), host: argv.values.host };
  if (argv.values.port) overrides.agent = { ...(overrides.agent || {}), port: Number(argv.values.port) };
  if (argv.values['log-level']) overrides.agent = { ...(overrides.agent || {}), logLevel: argv.values['log-level'] };

  const bootstrapLogger = new Logger({ level: argv.values['log-level'] || 'info' });
  const config = new ConfigStore({ dataDir, overrides, logger: bootstrapLogger });
  await config.load();

  const logger = bootstrapLogger;
  logger.setLevel(config.get().agent.logLevel || 'info');
  logger.info('agent', `数据目录：${dataDir}`);

  const events = new EventHub({ logger });
  logger.on('entry', (entry) => events.broadcast('log', entry));

  const security = new SecurityManager({ dataDir, config, logger });
  await security.load();

  // 只在控制台输出一次新配对码
  const newPin = security.consumeNewPin();

  /* -------------------- 一次性命令 -------------------- */
  if (argv.flags.has('reset-pairing') || argv.flags.has('new-pin')) {
    if (argv.flags.has('new-pin') || !security.isPaired) {
      const pin = await security.rotatePin();
      banner([
        '已生成新的配对码（旧的配对全部失效）',
        `配对码：  ${pin}`,
        '请在网页控制台里输入它完成配对。',
      ]);
    } else {
      const count = await security.unpairAll();
      banner(['已解绑全部设备', `共撤销 ${count} 个令牌`]);
    }
    return;
  }

  const vm = new VmManager({ config, logger, events });
  const sync = new SyncManager({ config, logger, events });
  const devices = new DeviceManager({ config, logger });
  const images = new ImageManager({ config, logger, events, vm });

  const router = createRouter({
    config, security, logger, events, vm, sync, devices, images,
    startedAt: new Date().toISOString(),
  });

  if (argv.flags.has('print-routes')) {
    for (const route of router.describe()) {
      console.log(`${route.method.padEnd(7)} ${route.path.padEnd(42)} ${route.public ? '[公开]' : ''} ${route.description}`);
    }
    return;
  }

  const server = createAgentServer({
    router, security, logger, events,
    agentName: config.get().agent.name,
    agentVersion: AGENT_VERSION,
  });

  const { host, port } = config.get().agent;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const baseUrl = `http://${host}:${port}`;
  const vmDetection = await vm.detect();

  banner([
    `CloudLinux 桌面助手 v${AGENT_VERSION} 已启动`,
    `监听地址：  ${baseUrl}`,
    `配置名称：  ${config.get().agent.name}`,
    `已配对设备：${security.listTokens().length} 台`,
    `QEMU：      ${vmDetection.qemuPath || '未检测到（虚拟机功能将不可用）'}`,
  ]);

  if (newPin) {
    banner([
      '首次启动，请记下配对码（在网页控制台里输入它）',
      `配对码：  ${newPin}`,
      '此配对码只显示这一次；如需重置： node src/index.js --new-pin',
    ]);
  }
  if (security.isLockedOut()) {
    logger.warn('security', '配对功能当前处于锁定状态（失败次数过多），5 分钟后自动解锁');
  }
  if (!vmDetection.qemuPath) {
    logger.warn('vm', vmDetection.error || '未检测到 QEMU');
    logger.info('vm', '安装后可在控制台「设置」里指定路径，或点「重新探测」');
    logger.info('vm', os.platform() === 'win32'
      ? 'Windows 下载： https://qemu.weilnetz.de/w64/  （或 https://www.qemu.org/download/#windows）'
      : 'Linux: sudo apt install qemu-system-x86 qemu-utils');
  }

  /* -------------------- 优雅退出 -------------------- */
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('agent', `收到 ${signal}，正在退出…`);
    try { server.close(); } catch { /* ignore */ }
    events.closeAll();
    try { await vm.shutdown(); } catch (err) { logger.warn('vm', `关闭虚拟机失败：${err.message}`); }
    logger.info('agent', '再见 👋');
    setTimeout(() => process.exit(0), 150).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.exception('process', reason instanceof Error ? reason : new Error(String(reason)), '未捕获的 Promise 拒绝');
  });
  process.on('uncaughtException', (err) => {
    logger.exception('process', err, '未捕获的异常');
  });
}

main().catch((err) => {
  console.error('\n启动失败：', err?.stack || err);
  process.exit(1);
});
