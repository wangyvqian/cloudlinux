#!/usr/bin/env node
/**
 * CloudLinux 桌面助手 —— 入口。
 *
 *   node src/index.js                   启动助手
 *   node src/index.js --new-pin         重新生成配对码（会解绑所有设备）
 *   node src/index.js --reset-pairing   解绑所有设备
 *   node src/index.js --print-routes    打印 API 路由表
 *   node src/index.js --home D:\mydata  指定便携目录
 *
 * 打包成 EXE 后数据默认放在「EXE 同级 / data」。
 */
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createRouter } from './api.js';
import { AGENT_ROOT, AGENT_VERSION, ConfigStore } from './config.js';
import { DeviceManager } from './devices.js';
import { FileDownloader } from './download.js';
import { EventHub } from './events.js';
import { ImageManager } from './images.js';
import { Logger } from './logger.js';
import { resolveLayout } from './paths.js';
import { resolveProxy } from './proxy.js';
import { QemuManager } from './qemu.js';
import { SecurityManager } from './security.js';
import { createAgentServer } from './server.js';
import { SyncManager } from './sync.js';
import { VmManager } from './vm.js';
import { ensureDir, pathExists } from './util.js';

const HELP = `
CloudLinux 桌面助手 v${AGENT_VERSION}

用法： node src/index.js [选项]

选项：
  --host <addr>       监听地址（默认 127.0.0.1，强烈建议不要改成 0.0.0.0）
  --port <n>          监听端口（默认 8765）
  --home <dir>        便携目录（默认「EXE 同级/data」，源码运行时为 agent/data）
  --parent-pid <n>    监视该进程，它退出时助手也会优雅停机（供启动器使用）
  --log-level <lvl>   debug | info | warn | error
  --new-pin           重新生成配对码并解绑所有设备，然后退出
  --reset-pairing     解绑所有已配对设备，然后退出
  --print-routes      打印 API 路由表，然后退出
  -h, --help          显示帮助
  -v, --version       显示版本

环境变量：
  CLOUDLINUX_HOME     等同于 --home
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

  // 便携目录：默认「EXE 同级 / data」（源码运行时为 agent/data）
  const { home, homeSource, layout, packaged } = await resolveLayout({
    argvHome: argv.values.home,
    envHome: process.env.CLOUDLINUX_HOME,
  });
  await ensureDir(home);
  // 便携目录下的子目录一次性建好，后面各模块直接用
  await Promise.all([
    ensureDir(layout.images),
    ensureDir(layout.disks),
    ensureDir(layout.logs),
  ]);

  const overrides = {};
  if (argv.values.host) overrides.agent = { ...(overrides.agent || {}), host: argv.values.host };
  if (argv.values.port) overrides.agent = { ...(overrides.agent || {}), port: Number(argv.values.port) };
  if (argv.values['log-level']) overrides.agent = { ...(overrides.agent || {}), logLevel: argv.values['log-level'] };

  const bootstrapLogger = new Logger({
    level: argv.values['log-level'] || 'info',
    // 始终写 stdout/stderr：
    //  · 被启动器启动时，它正是靠重定向 stdout 来显示助手日志的；
    //  · 双击运行时没有控制台，写了也没人看，但不会有副作用（真日志在文件里）。
    toConsole: true,
  });
  const logFile = bootstrapLogger.openFile(layout.logFile);
  const config = new ConfigStore({ home, layout, overrides, logger: bootstrapLogger });
  await config.load();

  const logger = bootstrapLogger;
  logger.setLevel(config.get().agent.logLevel || 'info');
  if (logFile) logger.info('agent', `日志文件：${logFile}`);
  logger.info('agent', `便携目录：${home}（来源：${homeSource}）`);
  logger.info('agent', packaged ? '运行方式：打包的 EXE' : '运行方式：源码（node）');

  const dataDir = home;

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
  const downloader = new FileDownloader({ logger });

  // Node 不会自动使用系统代理。开加速器时如果不显式探测，下载会走直连而慢到不可用。
  const proxyInfo = await resolveProxy({ setting: config.get().network?.proxy, logger });
  downloader.setProxy(proxyInfo.url);
  // 每次下载前重新解析：用户可能在助手运行期间才打开加速器
  downloader.setProxyResolver(async () => {
    const r = await resolveProxy({ setting: config.get().network?.proxy });
    return r.url;
  });
  if (proxyInfo.url) {
    logger.info('proxy', `已启用代理 ${proxyInfo.url}（${proxyInfo.detail}）`);
  } else {
    logger.info('proxy', `未使用代理（${proxyInfo.detail}）`);
  }

  const qemu = new QemuManager({ config, logger, events, downloader }).setVm(vm);
  const images = new ImageManager({ config, logger, events, vm, downloader, qemu });

  const router = createRouter({
    config, security, logger, events, vm, sync, devices, images, qemu,
    downloader,
    proxyInfo,
    layout,
    packaged,
    home,
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
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (err) {
    // 端口被占用是最常见的启动失败：多半是另一个助手实例还在跑。
    // 这里给出可操作的提示，而不是甩一段 EADDRINUSE 堆栈。
    if (err && err.code === 'EADDRINUSE') {
      logger.error('agent', `端口 ${port} 已被占用，助手无法启动。`);
      logger.error('agent', '通常是因为已经有一个助手在运行（比如开发时用 node 直接跑的那个）。');
      logger.error('agent', '处理办法（任选其一）：');
      logger.error('agent', `  · 关掉正在占用 ${port} 端口的那个助手进程`);
      logger.error('agent', '  · 或者在「设置 → 监听端口」里换一个端口');
      logger.error('agent', `  · 想查出是谁占着： netstat -ano | findstr :${port}`);
      process.exitCode = 3;
      logger.closeFile();
      return;
    }
    throw err;
  }

  const baseUrl = `http://${host}:${port}`;
  const vmDetection = await vm.detect();

  banner([
    `CloudLinux 桌面助手 v${AGENT_VERSION} 已启动`,
    `监听地址：  ${baseUrl}`,
    `便携目录：  ${home}`,
    `已配对设备：${security.listTokens().length} 台`,
    `QEMU：      ${vmDetection.qemuPath || '未检测到（可在控制台里一键安装）'}`,
  ]);

  if (newPin) {
    banner([
      '首次启动，请记下配对码（在网页控制台里输入它）',
      `配对码：  ${newPin}`,
      '此配对码只显示这一次；如需重置： node src/index.js --new-pin',
    ]);
    // 同时写进日志，方便 GUI 启动器（无控制台）展示
    logger.info('security', `配对码：${newPin}（也写在 ${layout.home}\\pairing-code.txt）`);
  } else if (!security.isPaired) {
    // 之前生成过配对码但还没配对；文件丢了就只能重置
    const pending = await security.pendingPin();
    if (pending) {
      logger.info('security', `尚未配对。配对码见 ${layout.home}\\pairing-code.txt：${pending}`);
    } else {
      logger.warn('security', '尚未配对，且找不到配对码文件。请用 --new-pin 重新生成。');
    }
  }
  if (security.isLockedOut()) {
    logger.warn('security', '配对功能当前处于锁定状态（失败次数过多），5 分钟后自动解锁');
  }
  if (!vmDetection.qemuPath) {
    logger.warn('vm', vmDetection.error || '未检测到 QEMU');
    if (process.platform === 'win32') {
      logger.info('vm', '可在控制台「QEMU」卡片里点「一键安装」，助手会自动下载并装到便携目录');
    } else {
      logger.info('vm', process.platform === 'darwin'
        ? 'macOS: brew install qemu'
        : 'Linux: sudo apt install qemu-system-x86 qemu-utils');
    }
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
    logger.closeFile();
    setTimeout(() => process.exit(0), 150).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  /**
   * Windows 上 Process.Kill() 是硬终止，不会触发 SIGTERM，
   * 虚拟机就会被直接掐掉（有数据损坏风险）。所以额外提供两种优雅停机通道：
   *
   *  1. --parent-pid：监视父进程（启动器）是否还活着，父进程退出就跟着收工
   *  2. 停机请求文件：启动器写一个文件，助手看到后自己优雅退出
   */
  const parentPid = Number(argv.values['parent-pid']) || 0;
  let watchTimer = null;
  if (parentPid > 0) {
    logger.info('agent', `将监视父进程 ${parentPid}，它退出时助手会优雅停机`);
    watchTimer = setInterval(() => {
      try {
        process.kill(parentPid, 0); // 只探测存活，不真的发信号
      } catch {
        shutdown('父进程已退出');
      }
    }, 2000);
    watchTimer.unref?.();
  }

  const shutdownRequestFile = path.join(home, 'shutdown.request');
  const requestTimer = setInterval(async () => {
    try {
      if (await pathExists(shutdownRequestFile)) {
        await fsp.rm(shutdownRequestFile, { force: true });
        shutdown('停机请求');
      }
    } catch { /* 读不到就下次再看 */ }
  }, 1000);
  requestTimer.unref?.();
  // 启动时清理掉上次遗留的请求文件，避免刚起来就退出
  try { await fsp.rm(shutdownRequestFile, { force: true }); } catch { /* ignore */ }

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
