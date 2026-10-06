/**
 * 业务路由表。
 */
import { AGENT_VERSION, IS_WINDOWS } from './config.js';
import { probeRemote } from './download.js';
import { resolveProxy, testProxy } from './proxy.js';
import { HANDLED, Router } from './server.js';
import { HttpError, humanBytes } from './util.js';

export function createRouter(ctx) {
  const {
    config, security, logger, events, vm, sync, devices, images, qemu,
    layout, packaged, downloader,
  } = ctx;
  const router = new Router();

  const requireString = (value, field, { min = 1, max = 500 } = {}) => {
    const text = String(value ?? '').trim();
    if (text.length < min) throw new HttpError(400, `参数 ${field} 不能为空`);
    if (text.length > max) throw new HttpError(400, `参数 ${field} 过长`);
    return text;
  };

  /* ------------------------- 公开接口 ------------------------- */

  router.get('/api/ping', () => ({
    service: 'cloudlinux-agent',
    version: AGENT_VERSION,
    name: config.get().agent.name,
    paired: security.isPaired,
    vncWebsocketPort: config.get().vm.vnc?.websocketPort || 0,
    time: new Date().toISOString(),
  }), { public: true, description: '探测助手是否在线' });

  router.post('/api/pair', async ({ body }) => {
    const pin = body.pin ?? body.code;
    const label = body.label;
    const { token, id } = await security.pair(pin, label);
    events.broadcast('security', { type: 'paired', id, label: label || 'browser' });
    return { token, id, name: config.get().agent.name };
  }, { public: true, description: '用配对码换取长期令牌' });

  /* ------------------------- 总览 ------------------------- */

  router.get('/api/overview', async () => ({
    agent: {
      name: config.get().agent.name,
      version: AGENT_VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      dataDir: config.dataDir,
      startedAt: ctx.startedAt,
      eventsClients: events.size,
      packaged: Boolean(packaged),
    },
    // 便携目录：数据都在这一个文件夹里
    portable: {
      home: config.home,
      source: ctx.homeSource || 'portable',
      packaged: Boolean(packaged),
      layout: layout || config.layout,
    },
    vm: await vm.status(),
    qemu: qemu ? qemu.status() : null,
    sync: { jobs: sync.list().length, running: sync.list().filter((j) => j.running).length },
    tokens: security.listTokens().length,
  }), { description: '总览' });

  /* ------------------------- 事件流 ------------------------- */

  router.get('/api/events', ({ req, res }) => {
    events.add(req, res, { tokenId: req.auth?.id || null });
    return HANDLED;
  }, { description: 'SSE 实时事件流' });

  router.get('/api/logs', ({ query }) => ({
    entries: logger.tail(Number(query.get('limit')) || 200),
    level: logger.level,
  }), { description: '历史日志' });

  router.post('/api/logs/level', async ({ body }) => {
    const level = requireString(body.level, 'level', { max: 10 });
    if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new HttpError(400, 'level 必须是 debug/info/warn/error');
    logger.setLevel(level);
    await config.patch({ agent: { logLevel: level } });
    return { level };
  }, { description: '调整日志级别' });

  /* ------------------------- 配置 ------------------------- */

  router.get('/api/config', () => config.redacted(), { description: '读取配置' });

  router.post('/api/config', async ({ body }) => {
    const { ConfigStore } = await import('./config.js');
    const patch = ConfigStore.sanitizePatch(body);
    if (!Object.keys(patch).length) throw new HttpError(400, '没有可更新的字段');
    await config.patch(patch);
    if (patch.agent?.logLevel) logger.setLevel(patch.agent.logLevel);
    const fields = Object.entries(patch)
      .flatMap(([section, values]) => Object.keys(values).map((field) => `${section}.${field}`))
      .join(', ');
    logger.info('config', `配置已更新：${fields}`);
    events.broadcast('config', { updated: patch });
    return config.redacted();
  }, { description: '局部更新配置' });

  /* ------------------------- 安全 ------------------------- */

  router.get('/api/security/tokens', () => ({
    paired: security.isPaired,
    tokens: security.listTokens(),
  }), { description: '已配对设备' });

  router.delete('/api/security/tokens/:id', async ({ params }) => {
    const ok = await security.revokeToken(params.id);
    if (!ok) throw new HttpError(404, '令牌不存在');
    // 必须立刻切断该设备已建立的事件流，否则它仍能继续收到推送
    const closed = events.closeByTokenId(params.id);
    if (closed) logger.info('security', `已切断 ${closed} 条来自被撤销设备的事件流`);
    events.broadcast('security', { type: 'revoked', id: params.id });
    return { revoked: params.id, closedStreams: closed };
  }, { description: '撤销某个设备' });

  router.post('/api/security/unpair', async () => {
    const count = await security.unpairAll();
    events.closeAll();
    return { revokedCount: count };
  }, { description: '解绑全部设备' });

  router.post('/api/security/rotate-pin', async () => {
    const pin = await security.rotatePin();
    logger.warn('security', '已生成新的配对码，旧的配对全部失效');
    events.closeAll();
    return { pin, note: '请立即在控制台重新配对；此配对码只会显示这一次' };
  }, { description: '重置配对码' });

  /* ------------------------- 虚拟机 ------------------------- */

  router.get('/api/vm/status', async () => vm.status(), { description: '虚拟机状态' });

  router.post('/api/vm/detect', async () => vm.detect({ refresh: true }), { description: '重新探测 QEMU' });

  router.post('/api/vm/start', async () => {
    const status = await vm.start();
    events.broadcast('notification', { level: 'success', message: '虚拟机已启动' });
    return status;
  }, { description: '启动虚拟机' });

  router.post('/api/vm/stop', async ({ body }) => {
    const status = await vm.stop({ force: Boolean(body.force) });
    events.broadcast('notification', { level: 'info', message: '虚拟机已停止' });
    return status;
  }, { description: '停止虚拟机' });

  router.post('/api/vm/restart', async () => {
    const status = await vm.restart();
    events.broadcast('notification', { level: 'success', message: '虚拟机已重启' });
    return status;
  }, { description: '重启虚拟机' });

  router.get('/api/vm/snapshots', async () => ({ snapshots: await vm.listSnapshots() }), { description: '快照列表' });

  router.post('/api/vm/snapshots', async ({ body }) => {
    const name = requireString(body.name, 'name', { max: 60 });
    const snapshots = await vm.createSnapshot(name);
    events.broadcast('notification', { level: 'success', message: `快照 ${name} 已创建` });
    return { snapshots };
  }, { description: '创建快照' });

  router.post('/api/vm/snapshots/:name/restore', async ({ params }) => {
    const snapshots = await vm.restoreSnapshot(params.name);
    events.broadcast('notification', { level: 'success', message: `已回滚到 ${params.name}` });
    return { snapshots };
  }, { description: '回滚到快照' });

  router.delete('/api/vm/snapshots/:name', async ({ params }) => {
    const snapshots = await vm.deleteSnapshot(params.name);
    events.broadcast('notification', { level: 'info', message: `快照 ${params.name} 已删除` });
    return { snapshots };
  }, { description: '删除快照' });

  /* ------------------------- 同步 ------------------------- */

  router.get('/api/sync/jobs', () => ({ jobs: sync.list() }), { description: '同步任务列表' });

  router.post('/api/sync/jobs', async ({ body }) => sync.add(body), { description: '新建同步任务' });

  router.delete('/api/sync/jobs/:id', async ({ params }) => sync.remove(params.id), { description: '删除同步任务' });

  router.post('/api/sync/jobs/:id/run', async ({ params, body }) => sync.run(params.id, { dryRun: Boolean(body.dryRun) }), { description: '立即同步' });

  router.post('/api/sync/jobs/:id/backup', async ({ params }) => sync.backup(params.id), { description: '立即备份' });

  router.get('/api/sync/jobs/:id/backups', async ({ params }) => ({ backups: await sync.listBackups(params.id) }), { description: '备份点列表' });

  /* ------------------------- 外设 ------------------------- */

  router.get('/api/devices', async ({ query }) => devices.overview({ force: query.get('refresh') === '1' }), { description: '外设总览' });
  router.get('/api/devices/serial', async ({ query }) => {
    const result = await devices.listSerial({ force: query.get('refresh') === '1' });
    return { serial: result.items, error: result.error };
  }, { description: '串口列表' });
  router.get('/api/devices/usb', async ({ query }) => {
    const result = await devices.listUsb({ force: query.get('refresh') === '1' });
    return { usb: result.items, error: result.error };
  }, { description: 'USB 列表' });

  router.post('/api/devices/clipboard', ({ body }) => devices.setClipboardText(body.text), { description: '写入助手剪贴板' });
  router.get('/api/devices/clipboard', ({ res }) => {
    const text = devices.getClipboardText();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
    return HANDLED;
  }, { description: '读取助手剪贴板' });

  /* ------------------------- 系统镜像 ------------------------- */

  router.get('/api/images/catalog', async ({ query }) => ({
    catalog: images.catalog(),
    local: await images.listLocal({ dir: query.get('dir') || undefined }),
    disks: await images.listDisks(),
    downloadDir: images.downloadDir,
    disksDir: images.disksDir,
    status: images.status(),
  }), { description: '镜像目录、本地文件与磁盘' });

  router.get('/api/images/status', () => images.status(), { description: '镜像任务状态' });

  router.post('/api/images/probe', async ({ body }) => {
    const url = requireString(body.url, 'url', { max: 2000 });
    const result = await probeRemote(url);
    return {
      ...result,
      sizeText: result.sizeBytes ? humanBytes(result.sizeBytes) : null,
    };
  }, { description: '探测远端镜像（大小 / 是否可续传）' });

  // 下载与一键准备都可能耗时很久，这里“启动即返回”，进度走 SSE
  router.post('/api/images/download', ({ body }) => images.startDownload(body), { description: '开始下载 ISO（后台任务）' });
  router.post('/api/images/prepare', ({ body }) => images.startPrepare(body), { description: '一键准备：下载 + 建盘 + 写配置（后台任务）' });
  router.post('/api/images/cancel', () => ({ cancelled: images.cancel() }), { description: '取消当前镜像任务' });
  router.delete('/api/images/partial', async ({ body }) => images.deletePartial(body), { description: '删除未完成的分片' });

  router.post('/api/images/create-disk', async ({ body }) => images.createDisk(body), { description: '创建 qcow2 虚拟磁盘' });
  router.post('/api/images/finish-install', async () => images.finishInstall(), { description: '安装完成，取消 ISO 引导' });

  // 把已下载的镜像投入使用：ISO → 安装盘；qcow2/img → 建叠加层当系统盘（免安装）
  router.post('/api/images/use-local', async ({ body }) => images.useLocal(body), { description: '把已下载的镜像设为安装盘或系统盘' });
  router.post('/api/images/overlay', async ({ body }) => images.createOverlay(body), { description: '基于镜像创建 qcow2 叠加层' });
  router.get('/api/images/disks', async () => images.listDisks(), { description: '虚拟机磁盘列表' });
  router.post('/api/images/disk-info', async ({ body }) => images.diskInfo(requireString(body.path, 'path', { max: 1000 })), { description: '读取磁盘详情' });

  /* ------------------------- QEMU ------------------------- */

  router.get('/api/qemu', () => (qemu ? qemu.status() : { supported: false }), { description: 'QEMU 状态' });
  router.post('/api/qemu/install', ({ body }) => qemu.startInstall({
    keepInstaller: Boolean(body.keepInstaller),
    force: Boolean(body.force),
  }), { description: '下载并静默安装 QEMU 到便携目录（后台任务）' });
  router.post('/api/qemu/cancel', () => ({ cancelled: qemu.cancel() }), { description: '取消 QEMU 安装' });
  router.post('/api/qemu/verify', async () => {
    const result = await qemu.verifyInstall();
    if (result.ok) {
      await config.patch({ vm: { qemuPath: result.qemuPath, qemuImgPath: result.qemuImgPath } });
      await vm.detect({ refresh: true });
    }
    return result;
  }, { description: '重新检测便携目录里的 QEMU' });

  /* ------------------------- 网络 / 代理 ------------------------- */

  router.get('/api/network', async () => {
    const setting = config.get().network?.proxy || 'auto';
    const resolved = await resolveProxy({ setting });
    return {
      setting,
      active: downloader?.proxyUrl || null,
      resolved: { url: resolved.url, source: resolved.source, detail: resolved.detail },
      note: 'Node 不会自动使用系统代理。若开着加速器，把 proxy 设为 auto 或 http://127.0.0.1:端口 可显著提速。',
    };
  }, { description: '代理状态' });

  router.post('/api/network/resolve', async ({ body }) => {
    const setting = typeof body.proxy === 'string' ? body.proxy.trim() : 'auto';
    const resolved = await resolveProxy({ setting, logger });
    // 顺手测一下能不能真的连出去
    let test = null;
    if (resolved.url) {
      test = await testProxy(resolved.url, body.testUrl || undefined);
    }
    return { setting, resolved, test };
  }, { description: '解析并测试代理' });

  router.post('/api/network/proxy', async ({ body }) => {
    const setting = typeof body.proxy === 'string' ? body.proxy.trim() || 'auto' : 'auto';
    await config.patch({ network: { proxy: setting } });
    const resolved = await resolveProxy({ setting, logger });
    downloader?.setProxy(resolved.url);
    logger.info('proxy', `代理设置已更新：${setting} → ${resolved.url || '直连'}`);
    return { setting, active: resolved.url, resolved };
  }, { description: '修改代理设置（立即生效，无需重启）' });

  return router;
}
