/**
 * CloudLinux 控制台前端逻辑。
 *
 * 无框架、无构建步骤，直接用 <script> 加载，方便丢到 GitHub Pages 或本地静态服务器。
 */
(function main() {
  'use strict';

  // 版本号必须和 index.html 的 data-app-version / 资源查询串保持一致。
  // index.html 与 app.js 是分开缓存的，一旦错配就会出现「按钮在、但点了没反应」。
  const APP_VERSION = '0.2.1';
  const BASE_KEY = 'cloudlinux.base';
  const DEFAULT_BASE = 'http://127.0.0.1:8765';
  const POLL_INTERVAL = 6000;
  const LOG_LIMIT = 400;

  /* ==================== 状态 ==================== */

  const state = {
    connection: 'offline', // offline | unpaired | paired
    agentName: '',
    agent: null,
    vm: null,
    snapshots: [],
    jobs: [],
    devices: null,
    config: null,
    tokens: [],
    logs: [],
    images: { catalog: [], local: { items: [] }, disks: { items: [] }, status: null, dir: '', disksDir: '' },
    qemu: null,
    portable: null,
    activeView: 'overview',
    logLevel: 'info',
  };

  const client = new window.AgentClient({
    baseUrl: localStorage.getItem(BASE_KEY) || DEFAULT_BASE,
  });

  let vncSession = null;
  let pollTimer = null;
  let eventReconnectTimer = null;
  let eventsEverOpened = false;

  /* ==================== 小工具 ==================== */

  const $ = (id) => document.getElementById(id);

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const bytes = (n) => {
    if (!Number.isFinite(n) || n < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  };

  const duration = (seconds) => {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    if (s < 86400) return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
    return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 时`;
  };

  const timeText = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff >= 0 && diff < 60) return `${Math.round(diff)} 秒前`;
    if (diff >= 0 && diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
    return d.toLocaleString('zh-CN', { hour12: false });
  };

  const kvRows = (rows) => `<div class="kv">${rows
    .filter(Boolean)
    .map(([k, v]) => `<div class="kv-row"><span class="kv-key">${esc(k)}</span><span class="kv-val">${v}</span></div>`)
    .join('')}</div>`;

  const emptyBox = (text) => `<div class="empty">${esc(text)}</div>`;

  const errorBox = (message, detail) => `<div class="error-box">${esc(message)}${
    Array.isArray(detail) && detail.length
      ? `<pre>${esc(detail.join('\n'))}</pre>`
      : (detail ? `<pre>${esc(String(detail))}</pre>` : '')
  }</div>`;

  const warnBox = (text) => `<div class="warn-box">${esc(text)}</div>`;

  const VM_STATE = {
    stopped: { label: '已停止', cls: '' },
    starting: { label: '启动中', cls: 'warn' },
    running: { label: '运行中', cls: 'ok' },
    stopping: { label: '关闭中', cls: 'warn' },
    error: { label: '出错', cls: 'err' },
  };

  const IMAGE_PHASE = {
    queued: '准备中',
    probing: '探测镜像源',
    downloading: '下载中',
    verifying: '校验 SHA256',
    creating: '创建/准备磁盘',
    done: '已完成',
  };

  const QEMU_STATE = {
    idle: ['就绪', ''],
    downloading: ['下载中', 'warn'],
    installing: ['安装中', 'warn'],
    verifying: ['验证中', 'warn'],
    error: ['失败', 'err'],
  };

  /** 把秒数变成“3 分 12 秒”这类可读文本。 */
  const etaText = (sec) => {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return `${Math.round(sec)} 秒`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
    return `${Math.floor(sec / 3600)} 时 ${Math.round((sec % 3600) / 60)} 分`;
  };

  /* ==================== Toast ==================== */

  function toast(message, kind = 'info', timeout = 4200) {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = message;
    $('toasts').appendChild(node);
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 260);
    }, timeout);
  }

  /* ==================== 连接状态 ==================== */

  function setConnection(next, detail = {}) {
    state.connection = next;
    const dot = $('conn-dot');
    const label = $('conn-label');
    const url = $('conn-url');
    dot.className = 'conn-dot';

    if (next === 'paired') {
      dot.classList.add('paired');
      label.textContent = detail.name || state.agentName || '已配对';
      url.textContent = client.baseUrl.replace(/^https?:\/\//, '');
    } else if (next === 'unpaired') {
      dot.classList.add('online');
      label.textContent = '助手在线 · 未配对';
      url.textContent = client.baseUrl.replace(/^https?:\/\//, '');
    } else {
      dot.classList.add('offline');
      label.textContent = '助手离线';
      url.textContent = client.baseUrl.replace(/^https?:\/\//, '');
    }
    renderTopbarActions();
  }

  function renderTopbarActions() {
    const box = $('topbar-actions');
    if (state.connection === 'paired') {
      box.innerHTML = `
        <button class="btn btn-sm" data-action="refresh-all">刷新</button>
        <button class="btn btn-sm btn-ghost" data-action="unpair">断开配对</button>`;
    } else if (state.connection === 'unpaired') {
      box.innerHTML = `<button class="btn btn-sm btn-primary" data-action="open-pair">立即配对</button>`;
    } else {
      box.innerHTML = `
        <button class="btn btn-sm" data-action="retry-connect">重试连接</button>
        <button class="btn btn-sm btn-ghost" data-action="open-url">更换地址</button>`;
    }
  }

  /* ==================== 视图切换 ==================== */

  const VIEW_META = {
    overview: ['概览', '桌面助手的运行状态一览'],
    vm: ['虚拟机', 'Zorin OS 的生命周期与快照'],
    sync: ['文件同步', '本机目录与虚拟机共享目录之间的同步'],
    devices: ['外设', '串口与 USB 设备枚举'],
    logs: ['日志', '桌面助手的实时输出'],
    settings: ['设置', '虚拟机参数与安全策略'],
  };

  function showView(name) {
    state.activeView = name;
    for (const item of document.querySelectorAll('.nav-item')) {
      item.classList.toggle('active', item.dataset.view === name);
    }
    for (const view of document.querySelectorAll('.view')) {
      view.classList.toggle('active', view.id === `view-${name}`);
    }
    const [title, subtitle] = VIEW_META[name] || ['', ''];
    $('view-title').textContent = title;
    $('view-subtitle').textContent = subtitle;

    // 日志是增量追加渲染的，进入视图时要整体重绘一次，否则只显示进入之后的日志
    if (name === 'logs') renderLogs();
    // 镜像/QEMU 的进度是按需更新的，切回来时重绘一次保证与最新状态一致
    if (name === 'vm') { renderImages(); renderQemu(); renderDisks(); }
  }

  /* ==================== 渲染：概览 ==================== */

  function renderOverview() {
    const agent = state.agent;
    const vm = state.vm;

    /* 统计卡 */
    const cards = [];
    if (agent) {
      cards.push(['助手状态', state.connection === 'paired' ? '在线' : '未配对',
        `已运行 ${duration(agent.agent.uptimeSec)}`]);
      cards.push(['虚拟机', VM_STATE[vm?.state]?.label || '—',
        vm?.enabled ? (vm.image ? bytes(vm.image.size) : '未配置镜像') : '未启用']);
      cards.push(['同步任务', String(agent.sync.jobs),
        agent.sync.running ? `${agent.sync.running} 个正在运行` : '全部空闲']);
      cards.push(['已配对设备', String(agent.tokens), `${agent.agent.eventsClients} 个实时连接`]);
    }
    $('stat-cards').innerHTML = cards.map(([label, value, hint]) => `
      <div class="stat">
        <span class="stat-label">${esc(label)}</span>
        <span class="stat-value">${esc(value)}</span>
        <span class="stat-hint">${esc(hint)}</span>
      </div>`).join('') || emptyBox('加载中…');

    /* 虚拟机卡 */
    if (vm) {
      const meta = VM_STATE[vm.state] || { label: vm.state, cls: '' };
      $('ov-vm-badge').className = `badge ${meta.cls}`;
      $('ov-vm-badge').textContent = meta.label;
      $('ov-vm-body').innerHTML = kvRows([
        ['镜像', vm.image ? `${esc(vm.image.path)}<br>${esc(vm.image.sizeText)}` : (vm.imagePath ? `<span style="color:var(--err)">未找到：${esc(vm.imagePath)}</span>` : '未配置')],
        ['资源', `${vm.memoryMb} MB / ${vm.cpus} 核`],
        ['加速器', vm.accel ? esc(vm.accel) : '—'],
        ['QEMU', vm.qemu.available ? esc(vm.qemu.version || '已安装') : '<span style="color:var(--err)">未检测到</span>'],
        ['VNC', vm.vnc.enabled ? `显示号 ${vm.vnc.display}，websocket ${vm.vnc.websocketPort || '关闭'}` : '已关闭'],
      ]);
    }

    /* 同步卡 */
    const jobs = state.jobs;
    $('ov-sync-badge').className = `badge ${jobs.length ? 'info' : ''}`;
    $('ov-sync-badge').textContent = `${jobs.length} 个任务`;
    $('ov-sync-body').innerHTML = jobs.length
      ? kvRows(jobs.slice(0, 5).map((job) => [
        job.name,
        `${esc(job.direction)} · ${job.lastRunAt ? esc(timeText(job.lastRunAt)) : '从未运行'}`,
      ]))
      : emptyBox('还没有同步任务，去「文件同步」里加一个吧');

    /* 助手信息 */
    if (agent) {
      $('ov-agent-body').innerHTML = kvRows([
        ['名称', esc(agent.agent.name)],
        ['版本', `v${esc(agent.agent.version)}`],
        ['运行平台', `${esc(agent.agent.platform)} / ${esc(agent.agent.arch)}`],
        ['Node', esc(agent.agent.node)],
        ['进程 PID', String(agent.agent.pid)],
        ['数据目录', `<span>${esc(agent.agent.dataDir)}</span>`],
        ['启动时间', esc(timeText(agent.agent.startedAt))],
      ]);
    }
  }

  /* ==================== 渲染：虚拟机 ==================== */

  function renderVm() {
    const vm = state.vm;
    if (!vm) { $('vm-status-body').innerHTML = emptyBox('加载中…'); return; }

    const meta = VM_STATE[vm.state] || { label: vm.state, cls: '' };
    $('vm-badge').className = `badge ${meta.cls}`;
    $('vm-badge').textContent = meta.label;

    let body = kvRows([
      ['状态', `${esc(meta.label)}${vm.pid ? `（pid ${vm.pid}）` : ''}`],
      ['自', esc(timeText(vm.since))],
      ['磁盘镜像', vm.image
        ? `${esc(vm.image.path)}<br>${esc(vm.image.sizeText)} · 修改于 ${esc(timeText(vm.image.mtime))}`
        : (vm.imagePath ? `<span style="color:var(--err)">未找到 ${esc(vm.imagePath)}</span>` : '未配置')],
      ['安装 ISO', vm.installerIso ? esc(vm.installerIso) : '无'],
      ['内存 / CPU', `${vm.memoryMb} MB / ${vm.cpus} 核`],
      ['加速器', vm.accel ? `${esc(vm.accel)}（候选 ${esc((vm.accelCandidates || []).join(' → '))}）` : '—'],
      ['VNC', vm.vnc.enabled
        ? `显示号 ${vm.vnc.display} · TCP ${vm.vnc.port} · WS ${vm.vnc.websocketPort || '关闭'}${vm.vnc.hasPassword ? ' · 有密码' : ''}`
        : '已关闭'],
      ['QMP', `${vm.qmp.port}${vm.qmp.connected ? ' · 已连接' : ' · 未连接'}`],
      ['SSH 转发', `127.0.0.1:${vm.ssh.port} → 客户机 :22`],
      ['宿主内存', `空闲 ${vm.host.freeMb} MB / 共 ${vm.host.totalMb} MB`],
    ]);

    if (vm.error) body += `<div style="margin-top:12px">${errorBox(vm.error, vm.stderrTail)}</div>`;
    if (!vm.qemu.available) body += `<div style="margin-top:12px">${warnBox(vm.qemu.error || '未检测到 QEMU，虚拟机功能不可用。')}</div>`;
    $('vm-status-body').innerHTML = body;

    /* QEMU 环境卡 */
    $('qemu-body').innerHTML = kvRows([
      ['qemu-system', vm.qemu.path ? esc(vm.qemu.path) : '<span style="color:var(--err)">未找到</span>'],
      ['版本', esc(vm.qemu.version || '—')],
      ['qemu-img', vm.qemu.imgPath ? esc(vm.qemu.imgPath) : '<span style="color:var(--warn)">未找到</span>'],
      ['宿主', `${esc(vm.host.platform)} / ${esc(vm.host.arch)} · ${vm.host.cpuCount} 核`],
    ]) + (vm.qemu.available ? '' : `<p class="hint">安装 QEMU 后点「重新探测」，或在「设置」里手动指定路径。</p>`);

    /* VNC 徽章 */
    const vncBadge = $('vnc-badge');
    if (vm.state === 'running' && vm.vnc.websocketPort) {
      vncBadge.className = 'badge ok';
      vncBadge.textContent = '可连接';
    } else {
      vncBadge.className = 'badge';
      vncBadge.textContent = vm.state === 'running' ? '无 WS 端口' : '等待启动';
    }

    /* VNC 提示 */
    const httpsPage = location.protocol === 'https:';
    const hints = [];
    if (httpsPage) {
      hints.push('当前页面是 HTTPS，浏览器会拦截到本机 ws:// 的连接（混合内容）。想在这里看到画面，请给助手配一个带 TLS 的隧道（如 Cloudflare Tunnel），或改用本机 http 打开本页。');
    }
    if (!vm.vnc.websocketPort) {
      hints.push('未配置 VNC websocket 端口，请在「设置 → VNC websocket 端口」里填 5700。');
    }
    $('vnc-hint').innerHTML = hints.map(esc).join('<br>');

    /* 快照表 */
    renderSnapshots();
  }

  function renderSnapshots() {
    const list = state.snapshots;
    if (!list.length) {
      $('snapshot-body').innerHTML = emptyBox('还没有快照。建议在装完系统后立刻创建一个「clean-install」。');
      return;
    }
    $('snapshot-body').innerHTML = `
      <table class="table">
        <thead><tr><th>名称</th><th>ID</th><th>占用</th><th>时间</th><th></th></tr></thead>
        <tbody>${list.map((snap) => `
          <tr>
            <td><strong>${esc(snap.name)}</strong></td>
            <td class="mono">${esc(snap.id)}</td>
            <td class="mono">${esc(snap.vmSizeText || '—')}</td>
            <td class="mono">${esc(snap.dateText ? timeText(snap.dateText) : '—')}</td>
            <td>
              <div class="actions">
                <button class="btn btn-sm" data-action="snapshot-restore" data-name="${esc(snap.name)}">回滚</button>
                <button class="btn btn-sm btn-danger" data-action="snapshot-delete" data-name="${esc(snap.name)}">删除</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  /* ==================== 渲染：系统镜像 ==================== */

  function applyImagesPayload(res) {
    if (!res) return;
    state.images.catalog = res.catalog || [];
    state.images.local = res.local || { items: [] };
    state.images.disks = res.disks || { items: [] };
    state.images.status = res.status || null;
    state.images.dir = res.downloadDir || '';
    state.images.disksDir = res.disksDir || '';
  }

  async function refreshImages() {
    const dir = $('img-dir')?.value?.trim();
    const res = await client.imagesCatalog(dir || undefined);
    applyImagesPayload(res);
    renderImages();
  }

  function renderImageProgress() {
    const img = state.images;
    const active = img.status?.active;
    const last = img.status?.lastResult;
    const badge = $('image-badge');
    const box = $('image-progress');
    if (!badge || !box) return;

    if (!img.status) { badge.className = 'badge'; badge.textContent = '—'; box.innerHTML = ''; return; }

    if (active) {
      badge.className = 'badge warn';
      badge.textContent = IMAGE_PHASE[active.phase] || '进行中';
    } else if (last?.cancelled) {
      badge.className = 'badge';
      badge.textContent = '已取消';
    } else if (last && last.ok === false) {
      badge.className = 'badge err';
      badge.textContent = '上次失败';
    } else if (last?.ok) {
      badge.className = 'badge ok';
      badge.textContent = '上次成功';
    } else {
      badge.className = 'badge';
      badge.textContent = '就绪';
    }

    if (active) {
      const total = active.total || 0;
      const verifying = active.phase === 'verifying';
      const done = verifying ? (active.hashedBytes || 0) : (active.bytes || 0);
      const pct = active.percent != null
        ? active.percent
        : (total ? (done / total) * 100 : 0);
      const detail = verifying
        ? `已校验 ${bytes(done)} / ${bytes(total)}`
        : [
          active.bytes != null ? `${bytes(active.bytes)}${total ? ` / ${bytes(total)}` : ''}` : '',
          active.speedText || '',
          active.etaSec ? `剩余 ${etaText(active.etaSec)}` : '',
          active.resumedFrom ? `从 ${bytes(active.resumedFrom)} 续传` : '',
        ].filter(Boolean).join(' · ');

      box.innerHTML = `
        <div class="task-panel">
          <div class="task-head">
            <span class="task-title"><span class="spinner"></span>${esc(IMAGE_PHASE[active.phase] || active.phase)}
              <span class="mono">${esc(active.filename || '')}</span></span>
            <span class="task-meta">${esc(detail)}</span>
          </div>
          <div class="progress progress-lg"><div class="progress-bar ${active.phase === 'downloading' ? 'pulse' : ''}"
            style="width:${Math.max(1.5, Math.min(100, pct || 0)).toFixed(1)}%"></div></div>
        </div>`;
      return;
    }

    if (!last) { box.innerHTML = ''; return; }

    if (last.cancelled) {
      box.innerHTML = `<div class="task-panel">
        <div class="task-head"><span class="task-title">已取消</span>
          <span class="task-meta">${esc(last.filename || '')} · 已保留 ${esc(last.partialText || '—')}，可续传</span></div>
        <p class="hint">再点一次「一键准备」或「只下载 ISO」会从断点继续，不会从头下。</p>
      </div>`;
      return;
    }
    if (last.ok) {
      box.innerHTML = `<div class="task-panel done">
        <div class="task-head"><span class="task-title">✓ 下载完成</span>
          <span class="task-meta">${esc(last.filename || '')} · ${esc(last.sizeText || '')}${last.verified ? ' · SHA256 已校验' : ''}</span></div>
      </div>`;
      return;
    }
    box.innerHTML = `<div class="task-panel failed">
      <div class="task-head"><span class="task-title">✗ 任务失败</span>
        <span class="task-meta">${esc(last.filename || '')}</span></div>
      ${errorBox(last.error || '未知错误')}
    </div>`;
  }

  function renderImageCatalog() {
    const img = state.images;
    const select = $('img-catalog');
    const mirrorSelect = $('img-mirror');
    if (!select || !mirrorSelect) return;

    const prevValue = select.value;
    select.innerHTML = img.catalog.length
      ? img.catalog.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.name)} · ${esc(entry.sizeText || '')}${entry.recommended ? '（推荐）' : ''}</option>`).join('')
      : '<option value="">（未能加载镜像目录）</option>';
    if (prevValue && img.catalog.some((e) => e.id === prevValue)) select.value = prevValue;

    // 镜像源下拉跟随所选镜像
    const selected = img.catalog.find((e) => e.id === select.value) || img.catalog[0];
    const prevMirror = mirrorSelect.value;
    mirrorSelect.innerHTML = (selected?.mirrors || [])
      .map((mirror, i) => `<option value="${i}">${esc(mirror.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</option>`)
      .join('');
    if (prevMirror && Number(prevMirror) < (selected?.mirrors?.length || 0)) mirrorSelect.value = prevMirror;

    $('img-local-dir').textContent = img.dir || '—';

    $('img-catalog-body').innerHTML = img.catalog.length ? `
      <table class="table">
        <thead><tr><th>版本</th><th>大小</th><th>SHA256</th><th>说明</th><th></th></tr></thead>
        <tbody>${img.catalog.map((entry) => `
          <tr>
            <td><strong>${esc(entry.name)}</strong>${entry.recommended ? ' <span class="badge info">推荐</span>' : ''}</td>
            <td class="mono">${esc(entry.sizeText || '—')}</td>
            <td class="mono">${esc(String(entry.sha256 || '').slice(0, 16))}…</td>
            <td style="color:var(--text-dim)">${esc(entry.note || '')}</td>
            <td><div class="actions">
              <button class="btn btn-sm" data-action="image-download" data-id="${esc(entry.id)}">下载</button>
            </div></td>
          </tr>`).join('')}</tbody>
      </table>` : emptyBox('未能加载镜像目录');

    const items = img.local?.items || [];
    $('img-local-body').innerHTML = items.length ? `
      <table class="table">
        <thead><tr><th>文件</th><th>类型</th><th>大小 / 进度</th><th>状态</th><th></th></tr></thead>
        <tbody>${items.map((item) => {
          const pct = item.partialPercent;
          const typeBadge = item.kind === 'iso'
            ? '<span class="badge info">安装盘 ISO</span>'
            : item.kind === 'disk'
              ? '<span class="badge ok">云镜像（免安装）</span>'
              : '<span class="badge">未知</span>';
          const complete = item.exists;
          return `<tr>
            <td><strong>${esc(item.name)}</strong></td>
            <td>${typeBadge}${item.format ? ` <span class="mono">${esc(item.format)}</span>` : ''}</td>
            <td class="mono">${complete
              ? esc(item.sizeText || '—')
              : `${esc(item.partialText || '—')}${item.expectedText ? ` / ${esc(item.expectedText)}` : ''}`}</td>
            <td>${complete
              ? '<span class="badge ok">完整</span>'
              : `<span class="badge warn">未完成${pct != null ? ` ${pct.toFixed(0)}%` : ''}</span>`}</td>
            <td><div class="actions">
              ${complete
                ? `<button class="btn btn-sm btn-primary" data-action="image-use-local" data-role="${item.kind === 'iso' ? 'installer' : 'disk'}" data-path="${esc(item.path)}">
                     ${item.kind === 'iso' ? '用作安装盘' : '免安装使用'}
                   </button>`
                : ''}
              ${item.incomplete
                ? `<button class="btn btn-sm" data-action="image-resume" data-catalog="${esc(item.catalogId || '')}">续传</button>
                   <button class="btn btn-sm btn-danger" data-action="image-drop-partial" data-path="${esc(item.partialPath || '')}">删除分片</button>`
                : ''}
            </div></td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : emptyBox('这个目录里还没有镜像。点上面的「一键准备」或「只下载镜像」开始。');
  }

  function renderImages() {
    renderImageProgress();
    renderImageCatalog();
  }

  /* ==================== 渲染：QEMU ==================== */

  function renderQemu() {
    const info = state.qemu;
    const badge = $('qemu-badge');
    const body = $('qemu-body');
    const progress = $('qemu-progress');
    if (!badge || !body) return;
    if (!info) { badge.className = 'badge'; badge.textContent = '—'; return; }

    const [label, cls] = QEMU_STATE[info.state] || [info.state, ''];
    const working = ['downloading', 'installing', 'verifying'].includes(info.state);
    badge.className = `badge ${working ? 'warn' : (info.managed ? 'ok' : (info.state === 'error' ? 'err' : 'err'))}`;
    badge.textContent = info.managed ? `已就绪 · ${label}` : (state.qemu.state === 'error' ? '安装失败' : '未安装');

    // 进度条
    if (working) {
      const p = info.progress || {};
      const pct = p.phase === 'installing' || p.phase === 'verifying'
        ? 100
        : (p.percent != null ? p.percent : 0);
      const detail = p.phase === 'installing' ? '正在静默安装（可能弹出 UAC，请点「是」）'
        : p.phase === 'verifying' ? '正在验证'
        : [p.bytes != null ? `${bytes(p.bytes)}${p.total ? ` / ${bytes(p.total)}` : ''}` : '', p.speedText || '', p.etaSec ? `剩余 ${etaText(p.etaSec)}` : ''].filter(Boolean).join(' · ');
      progress.innerHTML = `
        <div class="task-panel">
          <div class="task-head">
            <span class="task-title"><span class="spinner"></span>${esc(label)} QEMU</span>
            <span class="task-meta">${esc(detail)}</span>
          </div>
          <div class="progress progress-lg"><div class="progress-bar ${p.phase === 'downloading' ? 'pulse' : ''}" style="width:${Math.max(2, Math.min(100, pct || 0)).toFixed(1)}%"></div></div>
        </div>`;
    } else {
      progress.innerHTML = '';
    }

    const rows = [
      ['平台', `${esc(info.platform)}${info.supported ? '（支持自动安装）' : '（需手动安装）'}`],
      ['qemu-system', info.qemuPath ? esc(info.qemuPath) : '<span style="color:var(--muted)">未配置</span>'],
      ['qemu-img', info.qemuImgPath ? esc(info.qemuImgPath) : '<span style="color:var(--muted)">未配置</span>'],
      ['便携目录', esc(info.installDir)],
      ['安装版本', info.version ? `${esc(info.version)}${info.buildDate ? ` · 构建于 ${esc(info.buildDate)}` : ''}` : '—'],
      ['安装时间', info.installedAt ? esc(timeText(info.installedAt)) : '—'],
    ];
    body.innerHTML = kvRows(rows)
      + (info.error ? `<div style="margin-top:10px">${errorBox('上次失败：' + info.error)}</div>` : '')
      + `<p class="hint">${(info.hints || []).map(esc).join('<br>')}</p>`;
  }

  /* ==================== 渲染：磁盘 ==================== */

  function renderDisks() {
    const data = state.images.disks || { items: [] };
    const dirBadge = $('disks-dir');
    if (dirBadge) dirBadge.textContent = state.images.disksDir || data.dir || '—';
    const body = $('disks-body');
    if (!body) return;

    const items = data.items || [];
    if (!items.length) {
      body.innerHTML = emptyBox('便携目录里还没有虚拟机磁盘。用上面的「一键准备」会自动建一个；也可以直接点下面的「新建磁盘」。');
      return;
    }
    body.innerHTML = `
      <table class="table">
        <thead><tr><th>磁盘</th><th>格式</th><th>逻辑大小</th><th>实际占用</th><th>来源镜像</th><th></th></tr></thead>
        <tbody>${items.map((disk) => `
          <tr>
            <td><strong>${esc(disk.name)}</strong>${disk.inUse ? ' <span class="badge ok">使用中</span>' : ''}</td>
            <td class="mono">${esc(disk.format || '—')}</td>
            <td class="mono">${esc(disk.virtualSizeText || '—')}</td>
            <td class="mono">${esc(disk.sizeText || '—')}</td>
            <td class="mono">${disk.backingFile ? esc(disk.backingFile) : '<span style="color:var(--muted)">（独立磁盘）</span>'}</td>
            <td><div class="actions">
              ${disk.inUse ? '' : `<button class="btn btn-sm btn-primary" data-action="disk-use" data-path="${esc(disk.path)}">用作系统盘</button>`}
              <button class="btn btn-sm" data-action="disk-info" data-path="${esc(disk.path)}">详情</button>
            </div></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  /* ==================== 渲染：便携目录 ==================== */

  function renderPortable() {
    const p = state.portable;
    const badge = $('portable-badge');
    const body = $('portable-body');
    if (!badge || !body) return;
    if (!p) { badge.className = 'badge'; badge.textContent = '—'; body.innerHTML = emptyBox('加载中…'); return; }

    badge.className = `badge ${p.packaged ? 'ok' : 'info'}`;
    badge.textContent = p.packaged ? 'EXE 便携模式' : '源码模式';

    const layout = p.layout || {};
    const dirs = [
      ['数据根目录', layout.home],
      ['配置文件', layout.config],
      ['日志', layout.logs],
      ['系统镜像', layout.images],
      ['虚拟机磁盘', layout.disks],
      ['同步备份', layout.backups],
      ['自带运行时', layout.runtime],
      ['便携 QEMU', layout.qemu],
    ].filter(([, v]) => v);

    body.innerHTML = kvRows(dirs.map(([k, v]) => [k, `<code>${esc(v)}</code>`]))
      + `<p class="hint">
        所有数据都在上面这一个目录里：配置、配对密钥、下载的镜像、虚拟机磁盘、同步备份、自装的 QEMU、日志。
        把整个目录拷到 U 盘或另一台电脑，<span class="em">换个位置也能接着用</span>。
        <br>
        想换地方：启动时加 <code>--home D:\\我的数据</code>，或设环境变量 <code>CLOUDLINUX_HOME</code>。
      </p>`;
  }

  /* ==================== 渲染：同步 ==================== */

  function renderJobs() {
    const jobs = state.jobs;
    if (!jobs.length) {
      $('jobs-body').innerHTML = emptyBox('还没有同步任务。填好上面的表单，点「添加任务」。');
      return;
    }
    const DIR = { push: '推送 →', pull: '← 拉取', bidirectional: '⇄ 双向' };
    $('jobs-body').innerHTML = jobs.map((job) => {
      const res = job.lastResult;
      let resultLine = '从未运行';
      if (res) {
        const prefix = res.dryRun ? '上次演练' : '上次同步';
        resultLine = res.ok
          ? `${prefix}成功：新增 ${res.copied || 0} · 更新 ${res.updated || 0} · 删除 ${res.deleted || 0} · 跳过 ${res.skipped || 0} · ${res.bytesText || ''}（${((res.durationMs || 0) / 1000).toFixed(1)}s）${res.dryRun ? '，未修改任何文件' : ''}`
          : `${prefix}失败：${res.error || '未知错误'}`;
      }
      const progress = job.progress && job.progress.phase === 'copying' && job.progress.total
        ? `<div class="progress"><div class="progress-bar" style="width:${Math.round((job.progress.done / job.progress.total) * 100)}%"></div></div>
           <div class="hint">${job.progress.done} / ${job.progress.total} 个文件</div>`
        : '';

      return `
        <div class="card" style="background:var(--panel-2);margin-bottom:12px">
          <div class="card-head">
            <h2>${esc(job.name)} <span class="badge info" style="margin-left:6px">${esc(DIR[job.direction] || job.direction)}</span>
              ${job.running ? '<span class="spinner"></span>' : ''}</h2>
            <div class="row-gap">
              <button class="btn btn-sm btn-primary" data-action="job-run" data-id="${esc(job.id)}" ${job.running ? 'disabled' : ''}>立即同步</button>
              <button class="btn btn-sm" data-action="job-dryrun" data-id="${esc(job.id)}" ${job.running ? 'disabled' : ''}>演练</button>
              <button class="btn btn-sm" data-action="job-backup" data-id="${esc(job.id)}">备份</button>
              <button class="btn btn-sm btn-danger" data-action="job-delete" data-id="${esc(job.id)}">删除</button>
            </div>
          </div>
          <div class="card-body">
            ${kvRows([
              ['源', esc(job.source)],
              ['目标', esc(job.target)],
              ['排除', esc((job.excludes || []).join(', ') || '无')],
              ['模式', job.mirror ? '镜像（删除目标端多余文件）' : '增量（保留多余文件）'],
            ])}
            <p class="hint">${esc(resultLine)}</p>
            ${progress}
          </div>
        </div>`;
    }).join('');
  }

  /* ==================== 渲染：外设 ==================== */

  function renderDevices() {
    const data = state.devices;
    if (!data) { $('serial-body').innerHTML = emptyBox('加载中…'); return; }

    const errorList = data.errors || {};

    $('serial-body').innerHTML = errorList.serial
      ? errorBox(`串口枚举失败：${errorList.serial}`)
      : (data.serial.length
        ? `<table class="table"><thead><tr><th>端口</th><th>描述</th><th>状态</th></tr></thead><tbody>${
          data.serial.map((port) => `<tr>
            <td class="mono">${esc(port.path)}</td>
            <td>${esc(port.description || '—')}</td>
            <td><span class="badge">${esc(port.status || '—')}</span></td>
          </tr>`).join('')}</tbody></table>`
        : emptyBox('未发现串口设备'));

    $('usb-body').innerHTML = errorList.usb
      ? errorBox(`USB 枚举失败：${errorList.usb}`)
      : (data.usb.length
        ? `<table class="table"><thead><tr><th>设备</th><th>VID:PID</th><th>直通参数</th></tr></thead><tbody>${
          data.usb.map((dev) => `<tr>
            <td>${esc(dev.name)}</td>
            <td class="mono">${esc(dev.vendorId || '—')}:${esc(dev.productId || '—')}</td>
            <td class="mono">${dev.qemuArg ? `<code>${esc(dev.qemuArg)}</code>` : '—'}</td>
          </tr>`).join('')}</tbody></table>`
        : emptyBox('未发现 USB 设备'));

    if (data.partial) {
      $('devices-hints').innerHTML = warnBox('部分枚举失败，上方的列表可能不完整。可点「刷新」重试（Windows 上首次枚举可能需要几秒）。');
    } else {
      $('devices-hints').innerHTML = `<ul style="margin:0;padding-left:20px;color:var(--text-dim);font-size:13px;line-height:1.9">${
        (data.hints || []).map((hint) => `<li>${esc(hint)}</li>`).join('')}</ul>`;
    }
  }

  /* ==================== 渲染：日志 ==================== */

  function renderLogs() {
    const box = $('log-body');
    if (!state.logs.length) {
      box.innerHTML = emptyBox('暂无日志');
      return;
    }
    box.innerHTML = state.logs.map((entry) => `
      <div class="log-line log-${esc(entry.level)}">
        <span class="log-ts">${esc(new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false }))}</span>
        <span class="log-level">${esc(entry.level.toUpperCase())}</span>
        <span class="log-scope">${esc(entry.scope)}</span>
        <span class="log-msg">${esc(entry.message)}</span>
      </div>`).join('');

    if ($('log-autoscroll').checked) box.scrollTop = box.scrollHeight;
  }

  function pushLog(entry) {
    state.logs.push(entry);
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);

    // 只更新可见视图，避免后台浪费
    if (state.activeView === 'logs') {
      const box = $('log-body');
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      const node = document.createElement('div');
      node.className = `log-line log-${entry.level}`;
      node.innerHTML = `
        <span class="log-ts">${esc(new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false }))}</span>
        <span class="log-level">${esc(entry.level.toUpperCase())}</span>
        <span class="log-scope">${esc(entry.scope)}</span>
        <span class="log-msg">${esc(entry.message)}</span>`;
      if (box.querySelector('.empty')) box.innerHTML = '';
      box.appendChild(node);
      while (box.childElementCount > LOG_LIMIT) box.removeChild(box.firstElementChild);
      if (atBottom && $('log-autoscroll').checked) box.scrollTop = box.scrollHeight;
    }
  }

  /* ==================== 渲染：设置 ==================== */

  function renderSettings() {
    const cfg = state.config;
    if (cfg) {
      const vm = cfg.vm || {};
      $('cfg-vm-enabled').checked = Boolean(vm.enabled);
      $('cfg-vm-name').value = vm.name || '';
      $('cfg-qemu-path').value = vm.qemuPath || '';
      $('cfg-image-path').value = vm.imagePath || '';
      $('cfg-installer-iso').value = vm.installerIso || '';
      $('cfg-memory').value = vm.memoryMb ?? 4096;
      $('cfg-cpus').value = vm.cpus ?? 2;
      $('cfg-accel').value = vm.accel || 'auto';
      $('cfg-vga').value = vm.vga || 'std';
      $('cfg-disk-format').value = vm.diskFormat || 'qcow2';
      $('cfg-disk-interface').value = vm.diskInterface || 'virtio';
      $('cfg-net-model').value = vm.netModel || 'virtio';
      $('cfg-ssh-port').value = vm.sshPort ?? 2222;
      $('cfg-vnc-ws').value = vm.vnc?.websocketPort ?? 5700;
      $('cfg-vnc-password').value = '';
      $('cfg-vnc-password').placeholder = vm.vnc?.passwordSet ? '已设置（留空则不修改）' : '留空则不设密码';
      $('cfg-usb-tablet').checked = vm.usbTablet !== false;
      $('cfg-audio').checked = Boolean(vm.audio);
      const share = vm.share || {};
      $('cfg-share-enabled').checked = Boolean(share.enabled);
      $('cfg-share-dir').value = share.dir || '';
      $('cfg-share-tag').value = share.tag || 'hostshare';
      $('cfg-share-readonly').checked = share.readOnly !== false;
      $('cfg-extra-hostfwd').value = (vm.extraHostfwd || [])
        .map((e) => `${e.hostPort}:${e.guestPort}${e.protocol && e.protocol !== 'tcp' ? `:${e.protocol}` : ''}`)
        .join('\n');
      $('cfg-extra-args').value = (vm.extraArgs || []).join('\n');
      $('log-level').value = cfg.agent?.logLevel || 'info';
    }
    renderPortable();

    if (state.tokens.length) {
      $('tokens-body').innerHTML = `
        <table class="table">
          <thead><tr><th>设备</th><th>配对时间</th><th>最近使用</th><th></th></tr></thead>
          <tbody>${state.tokens.map((token) => `
            <tr>
              <td>${esc(token.label)}</td>
              <td class="mono">${esc(timeText(token.createdAt))}</td>
              <td class="mono">${esc(token.lastUsedAt ? timeText(token.lastUsedAt) : '—')}</td>
              <td><div class="actions">
                <button class="btn btn-sm btn-danger" data-action="token-revoke" data-id="${esc(token.id)}">撤销</button>
              </div></td>
            </tr>`).join('')}</tbody>
        </table>`;
    } else {
      $('tokens-body').innerHTML = emptyBox('没有已配对的设备');
    }

    if (cfg) {
      $('security-body').innerHTML = kvRows([
        ['监听地址', `<code>${esc(cfg.agent.host)}:${cfg.agent.port}</code>`],
        ['允许的 Origin', (cfg.agent.allowedOrigins || []).map((o) => `<code>${esc(o)}</code>`).join('<br>')],
        ['允许的 Host', (cfg.agent.allowedHosts || []).map((h) => `<code>${esc(h)}</code>`).join(' ')],
        ['日志级别', esc(cfg.agent.logLevel)],
      ]) + `<p class="hint">
        助手只绑定回环地址，并用 <code>Origin</code> 白名单 + <code>Host</code> 头校验 + Bearer 令牌三重防护。
        要修改白名单，请直接编辑助手数据目录下的 <code>config.json</code> 后重启助手。
      </p>`;
    }
  }

  /* ==================== 数据加载 ==================== */

  async function loadAll() {
    if (state.connection !== 'paired') return;
    const results = await Promise.allSettled([
      client.overview(),
      client.vmStatus(),
      client.listJobs(),
      client.getConfig(),
      client.listTokens(),
      client.devices(),
      client.logs(200),
      client.imagesCatalog(),
      client.qemuStatus(),
    ]);

    const [overview, vm, jobs, config, tokens, devices, logsHistory, imagesPayload, qemuPayload] = results;

    if (overview.status === 'fulfilled') state.agent = overview.value;
    if (vm.status === 'fulfilled') {
      state.vm = vm.value;
      // 没有 qemu-img / 未配置镜像时接口会 503，这里直接跳过，避免无谓的报错请求
      if (vm.value?.qemu?.imgPath && vm.value?.imagePath) {
        try {
          const snaps = await client.snapshots();
          state.snapshots = snaps?.snapshots || [];
        } catch {
          state.snapshots = [];
        }
      } else {
        state.snapshots = [];
      }
    }
    if (jobs.status === 'fulfilled') state.jobs = jobs.value?.jobs || [];
    if (config.status === 'fulfilled') state.config = config.value;
    if (tokens.status === 'fulfilled') state.tokens = tokens.value?.tokens || [];
    if (devices.status === 'fulfilled') state.devices = devices.value;
    if (logsHistory.status === 'fulfilled') {
      // 合并历史日志与 SSE 已推送的增量，按 id+时间戳去重（助手重启后 id 会重新计数）
      const key = (entry) => `${entry.id}:${entry.ts}`;
      const seen = new Set(state.logs.map(key));
      const merged = [...(logsHistory.value?.entries || []).filter((entry) => !seen.has(key(entry))), ...state.logs];
      merged.sort((a, b) => (a.ts === b.ts ? a.id - b.id : (a.ts < b.ts ? -1 : 1)));
      state.logs = merged.slice(-LOG_LIMIT);
    }
    if (imagesPayload.status === 'fulfilled') applyImagesPayload(imagesPayload.value);
    if (qemuPayload.status === 'fulfilled') state.qemu = qemuPayload.value;
    if (overview.status === 'fulfilled') state.portable = overview.value?.portable || null;

    // 令牌失效
    for (const result of results) {
      if (result.status === 'rejected' && result.reason?.isUnauthorized) {
        handleUnauthorized();
        return;
      }
    }

    renderAll();
  }

  async function refreshVmOnly() {
    if (state.connection !== 'paired') return;
    try {
      state.vm = await client.vmStatus();
      renderOverview();
      if (state.activeView === 'vm') renderVm();
    } catch (err) {
      if (err.isUnauthorized) handleUnauthorized();
    }
  }

  function renderAll() {
    renderOverview();
    renderVm();
    renderQemu();
    renderDisks();
    renderImages();
    renderJobs();
    renderDevices();
    renderPortable();
    renderSettings();
    if (state.activeView === 'logs') renderLogs();
  }

  /* ==================== 连接与事件 ==================== */

  async function checkConnection({ silent = false } = {}) {
    try {
      const info = await client.ping();
      state.agentName = info.name || state.agentName;
      if (client.isPaired) {
        setConnection('paired', { name: info.name });
        if (!silent) await connectEvents();
      } else {
        setConnection('unpaired');
      }
      return info;
    } catch (err) {
      setConnection('offline');
      if (!silent) toast(err.message, 'error', 6000);
      return null;
    }
  }

  async function connectEvents() {
    try {
      await client.connectEvents({
        open: () => {
          setConnection('paired', { name: state.agent?.agent?.name || state.agentName });
          // 不是首次连接 → 说明是断线重连，补一次数据拉取
          if (eventsEverOpened) {
            toast('已重新连上桌面助手', 'success');
            loadAll();
          }
          eventsEverOpened = true;
        },
        log: (entry) => { if (entry) pushLog(entry); },
        vm: (status) => {
          if (!status) return;
          const previous = state.vm?.state;
          state.vm = status;
          renderOverview();
          if (state.activeView === 'vm') renderVm();
          if (previous && previous !== status.state) {
            const label = VM_STATE[status.state]?.label || status.state;
            const kind = status.state === 'error' ? 'error' : (status.state === 'running' ? 'success' : 'info');
            toast(`虚拟机状态：${label}`, kind);
          }
        },
        'sync-progress': (data) => {
          const job = state.jobs.find((j) => j.id === data.jobId);
          if (!job) return;
          job.running = data.phase !== 'idle';
          job.progress = data.phase === 'idle' ? null : data;
          if (state.activeView === 'sync') renderJobs();
        },
        sync: () => { client.listJobs().then((r) => { state.jobs = r?.jobs || []; renderJobs(); renderOverview(); }).catch(() => {}); },
        qemu: (data) => {
          if (!data) return;
          state.qemu = data;
          renderQemu();
          if (data.failed) toast(`QEMU 安装失败：${data.failed}`, 'error', 12000);
          else if (data.cancelled) toast('QEMU 安装已取消', 'warn');
          else if (data.installed) {
            toast(`QEMU 已装好：${data.installed.version}`, 'success', 8000);
            refreshImages().catch(() => {});
            renderVm();
          }
        },
        security: (data) => {
          if (data?.type === 'unpaired-all') { toast('助手已解绑所有设备', 'warn'); handleUnauthorized(); }
          if (data?.type === 'revoked') client.listTokens().then((r) => { state.tokens = r?.tokens || []; renderSettings(); }).catch(() => {});
        },
        notification: (data) => {
          if (data?.message) toast(data.message, data.level === 'success' ? 'success' : 'info');
        },
        'image-progress': (data) => {
          if (!data) return;
          state.images.status = { ...(state.images.status || {}), active: data };
          renderImageProgress();
        },
        image: (data) => {
          if (!data) return;
          if (data.type === 'finished') {
            toast(`ISO 下载完成：${data.result?.sizeText || ''}${data.result?.verified ? '（SHA256 校验通过）' : ''}`, 'success', 7000);
            state.images.status = { ...(state.images.status || {}), active: null };
            refreshImages().catch(() => {});
          } else if (data.type === 'cancelled') {
            toast(`下载已取消，已保留 ${data.partialBytes ? bytes(data.partialBytes) : ''}，可续传`, 'warn', 8000);
            state.images.status = { ...(state.images.status || {}), active: null };
            refreshImages().catch(() => {});
          } else if (data.type === 'failed') {
            toast(`任务失败：${data.error}`, 'error', 9000);
            state.images.status = { ...(state.images.status || {}), active: null };
            refreshImages().catch(() => {});
          } else if (data.type === 'prepared') {
            toast('一键准备完成，可以点「启动」了', 'success', 9000);
            loadAll().catch(() => {});
          } else if (data.type === 'skipped') {
            toast(`ISO 已存在（${data.result?.sizeText || ''}），无需重复下载`, 'info', 6000);
            state.images.status = { ...(state.images.status || {}), active: null };
            refreshImages().catch(() => {});
          } else if (data.type === 'disk-created' || data.type === 'started') {
            refreshImages().catch(() => {});
          }
        },
        closed: () => { scheduleEventReconnect(); },
      });
    } catch {
      scheduleEventReconnect();
    }
  }

  /**
   * 事件流断了（助手重启 / 网络波动 / 令牌失效）时，退避重连。
   * 用一次需要鉴权的请求来区分「助手还没起来」和「令牌真的失效了」。
   */
  function scheduleEventReconnect() {
    if (eventReconnectTimer) return;
    if (!client.isPaired) { setConnection('unpaired'); return; }
    eventReconnectTimer = setTimeout(async () => {
      eventReconnectTimer = null;
      if (!client.isPaired) { setConnection('unpaired'); return; }
      try {
        state.agent = await client.overview();
      } catch (err) {
        if (err.isUnauthorized) { handleUnauthorized(); return; }
        setConnection('offline');
        scheduleEventReconnect(); // 助手还没起来，继续等
        return;
      }
      setConnection('paired', { name: state.agent?.agent?.name || state.agentName });
      await connectEvents();
      await loadAll();
      if (!pollTimer) startPolling();
    }, 4000);
  }

  /** 配对失效时清空所有敏感数据，避免界面继续展示过期信息。 */
  function clearSensitiveState() {
    state.agent = null;
    state.vm = null;
    state.snapshots = [];
    state.jobs = [];
    state.devices = null;
    state.config = null;
    state.tokens = [];
    state.logs = [];
  }

  const LOCKED_HINT = '请先与桌面助手配对';

  /** 未配对时把所有面板换成提示，而不是留着上一次的数据。 */
  function renderLocked() {
    $('stat-cards').innerHTML = emptyBox(LOCKED_HINT);
    for (const id of ['ov-vm-body', 'ov-sync-body', 'ov-agent-body', 'vm-status-body', 'snapshot-body', 'qemu-body', 'qemu-progress', 'disks-body', 'jobs-body', 'serial-body', 'usb-body', 'tokens-body', 'security-body', 'img-catalog-body', 'img-local-body', 'image-progress', 'img-custom-result', 'portable-body']) {
      const node = $(id);
      if (node) node.innerHTML = emptyBox(LOCKED_HINT);
    }
    for (const id of ['ov-vm-badge', 'ov-sync-badge', 'vm-badge', 'vnc-badge', 'image-badge', 'qemu-badge', 'portable-badge', 'disks-dir']) {
      const node = $(id);
      if (node) { node.className = 'badge'; node.textContent = '—'; }
    }
    renderLogs();
  }

  function handleUnauthorized() {
    client.clearToken();
    stopPolling();
    if (eventReconnectTimer) { clearTimeout(eventReconnectTimer); eventReconnectTimer = null; }
    clearSensitiveState();
    setConnection('unpaired');
    renderLocked();
    toast('配对已失效，请重新输入配对码', 'warn', 6000);
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      refreshVmOnly();
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /* ==================== 动作 ==================== */

  async function withBusy(button, fn) {
    const original = button?.innerHTML;
    if (button) { button.disabled = true; button.innerHTML = '<span class="spinner"></span>'; }
    try {
      return await fn();
    } catch (err) {
      if (err.isUnauthorized) { handleUnauthorized(); return undefined; }
      toast(err.message, 'error', 7000);
      if (err.detail) console.error(err.detail);
      return undefined;
    } finally {
      if (button) { button.disabled = false; button.innerHTML = original; }
    }
  }

  const actions = {
    'open-pair': () => { $('pair-error').textContent = ''; $('pair-pin').value = ''; $('pair-dialog').showModal(); $('pair-pin').focus(); },
    'pair-cancel': () => $('pair-dialog').close(),

    'open-url': () => { $('url-error').textContent = ''; $('url-input').value = client.baseUrl; $('url-dialog').showModal(); $('url-input').focus(); },
    'url-cancel': () => $('url-dialog').close(),

    'retry-connect': async () => {
      toast('正在连接助手…');
      const info = await checkConnection();
      if (info && client.isPaired) { startPolling(); await loadAll(); }
    },

    'refresh-all': async () => { await loadAll(); toast('已刷新'); },

    unpair: async () => {
      if (!confirm('确定要断开配对吗？下次需要重新输入配对码。')) return;
      client.clearToken();
      stopPolling();
      if (eventReconnectTimer) { clearTimeout(eventReconnectTimer); eventReconnectTimer = null; }
      disconnectVnc();
      clearSensitiveState();
      setConnection('unpaired');
      renderLocked();
      toast('已断开配对', 'info');
    },

    'go-view': (button) => showView(button.dataset.target),

    /* -------------------- 系统镜像 -------------------- */

    'image-prepare': (button) => withBusy(button, async () => {
      const id = $('img-catalog').value;
      if (!id) { toast('请先选择镜像', 'warn'); return; }
      const res = await client.imagePrepare({
        id,
        isoDir: $('img-dir').value.trim() || undefined,
        diskPath: $('img-disk').value.trim() || undefined,
        diskSizeGb: Number($('img-disksize').value) || 32,
        verify: $('img-verify').checked,
        mirrorIndex: Number($('img-mirror').value) || 0,
        installQemu: $('img-install-qemu').checked,
        startVm: $('img-start').checked,
      });
      toast(res?.message || '已开始一键准备', 'success', 7000);
      await refreshImages();
    }),

    'image-download': (button) => withBusy(button, async () => {
      const id = button.dataset.id || $('img-catalog').value;
      if (!id) { toast('请先选择镜像', 'warn'); return; }
      const res = await client.imageDownload({
        id,
        destDir: $('img-dir').value.trim() || undefined,
        verify: $('img-verify').checked,
        mirrorIndex: Number($('img-mirror').value) || 0,
      });
      toast(res?.message || '已开始下载', 'success', 7000);
      await refreshImages();
    }),

    'image-cancel': (button) => withBusy(button, async () => {
      const res = await client.imageCancel();
      toast(res?.cancelled ? '已请求取消，正在停止…' : '当前没有进行中的任务',
        res?.cancelled ? 'info' : 'warn');
    }),

    'image-finish': (button) => withBusy(button, async () => {
      const res = await client.imageFinishInstall();
      toast(res?.message || '已处理', res?.changed ? 'success' : 'info', 8000);
      await loadAll();
    }),

    'images-refresh': (button) => withBusy(button, async () => {
      await refreshImages();
      toast('已刷新镜像信息', 'success');
    }),

    'image-use-iso': (button) => withBusy(button, async () => {
      const res = await client.imageUseLocal(button.dataset.path, 'installer');
      toast(res?.message || '已设为安装盘', 'success', 7000);
      await loadAll();
    }),

    'image-use-local': (button) => withBusy(button, async () => {
      const res = await client.imageUseLocal(button.dataset.path, button.dataset.role);
      toast(res?.message || '已完成', 'success', 9000);
      await loadAll();
    }),

    'disk-use': (button) => withBusy(button, async () => {
      const diskPath = button.dataset.path;
      await client.saveConfig({ vm: { enabled: true, imagePath: diskPath, installerIso: '' } });
      toast('已设为系统盘，点「启动」即可使用', 'success', 7000);
      await loadAll();
    }),

    'disk-info': (button) => withBusy(button, async () => {
      const info = await client.diskInfo(button.dataset.path);
      toast(`逻辑 ${info.virtualSizeText} · 实际占用 ${info.onDiskText} · 格式 ${info.format}`
        + (info.backingFile ? ` · 基于 ${info.backingFile}` : ''), 'info', 10000);
    }),

    'qemu-install': (button) => withBusy(button, async () => {
      const res = await client.qemuInstall({ force: false });
      toast(res?.message || '已开始安装 QEMU', 'success', 8000);
      const info = await client.qemuStatus();
      state.qemu = info;
      renderQemu();
    }),

    'qemu-verify': (button) => withBusy(button, async () => {
      const res = await client.qemuVerify();
      toast(res?.ok ? `找到 QEMU：${res.version}` : (res?.error || '未找到 QEMU'), res?.ok ? 'success' : 'warn', 8000);
      state.qemu = await client.qemuStatus();
      renderQemu();
      state.vm = await client.vmStatus();
      renderVm();
    }),

    'qemu-cancel': (button) => withBusy(button, async () => {
      const res = await client.qemuCancel();
      toast(res?.cancelled ? '已请求取消 QEMU 任务' : '当前没有进行中的 QEMU 任务',
        res?.cancelled ? 'info' : 'warn');
    }),

    'image-resume': (button) => withBusy(button, async () => {
      const catalogId = button.dataset.catalog;
      if (!catalogId) {
        toast('这个分片不是来自内置目录，请在下方「自定义镜像链接」里填同一个地址后点下载', 'warn', 9000);
        return;
      }
      const res = await client.imageDownload({
        id: catalogId,
        destDir: $('img-dir').value.trim() || undefined,
        verify: $('img-verify').checked,
      });
      toast(res?.message || '已开始续传', 'success', 7000);
      await refreshImages();
    }),

    'image-drop-partial': (button) => withBusy(button, async () => {
      const partialPath = button.dataset.path;
      if (!partialPath) { toast('找不到分片路径', 'warn'); return; }
      if (!confirm('删除这个未完成的分片？下次会从头下载。')) return;
      const res = await client.imageDeletePartial(partialPath);
      toast(res?.deleted ? `已删除分片，释放 ${res.freedText}` : '分片不存在', 'success');
      await refreshImages();
    }),

    'image-custom-probe': (button) => withBusy(button, async () => {
      const url = $('img-custom-url').value.trim();
      if (!url) { toast('请先填写链接', 'warn'); return; }
      const res = await client.imageProbe(url);
      $('img-custom-result').innerHTML = res?.ok
        ? kvRows([
          ['大小', esc(res.sizeText || '未知')],
          ['断点续传', res.resumable ? '支持' : '不支持'],
          ['状态码', esc(String(res.status))],
        ])
        : errorBox(res?.error || '探测失败');
    }),

    'image-custom-download': (button) => withBusy(button, async () => {
      const url = $('img-custom-url').value.trim();
      if (!url) { toast('请先填写链接', 'warn'); return; }
      const sha = $('img-custom-sha').value.trim();
      if (sha && !/^[0-9a-fA-F]{64}$/.test(sha)) { toast('SHA256 应为 64 位十六进制', 'warn', 6000); return; }
      const res = await client.imageDownload({
        url,
        destDir: $('img-dir').value.trim() || undefined,
        expectSha256: sha || null,
        verify: $('img-verify').checked,
      });
      toast(res?.message || '已开始下载', 'success', 7000);
      await refreshImages();
    }),

    'vm-start': (button) => withBusy(button, async () => {
      toast('正在启动虚拟机，首次启动可能需要一两分钟…', 'info', 6000);
      state.vm = await client.vmStart();
      renderOverview(); renderVm();
    }),

    'vm-stop': (button) => withBusy(button, async () => {
      state.vm = await client.vmStop(false);
      renderOverview(); renderVm();
    }),

    'vm-stop-force': (button) => withBusy(button, async () => {
      if (!confirm('强制关闭相当于直接拔电源，未保存的数据会丢失。继续？')) return;
      state.vm = await client.vmStop(true);
      renderOverview(); renderVm();
    }),

    'vm-restart': (button) => withBusy(button, async () => {
      state.vm = await client.vmRestart();
      renderOverview(); renderVm();
    }),

    'vm-detect': (button) => withBusy(button, async () => {
      const detection = await client.vmDetect();
      toast(detection?.qemuPath ? `找到 QEMU：${detection.qemuPath}` : (detection?.error || '仍未找到 QEMU'), detection?.qemuPath ? 'success' : 'warn', 6000);
    }),

    'snapshot-create': (button) => withBusy(button, async () => {
      const name = $('snapshot-name').value.trim();
      if (!name) { toast('请先填写快照名', 'warn'); return; }
      const result = await client.createSnapshot(name);
      state.snapshots = result?.snapshots || [];
      $('snapshot-name').value = '';
      renderVm();
    }),

    'snapshot-restore': (button) => withBusy(button, async () => {
      const name = button.dataset.name;
      if (!confirm(`回滚到快照「${name}」？快照之后的改动都会丢失。`)) return;
      const result = await client.restoreSnapshot(name);
      state.snapshots = result?.snapshots || [];
      renderVm();
    }),

    'snapshot-delete': (button) => withBusy(button, async () => {
      const name = button.dataset.name;
      if (!confirm(`删除快照「${name}」？`)) return;
      const result = await client.deleteSnapshot(name);
      state.snapshots = result?.snapshots || [];
      renderVm();
    }),

    'job-add': (button) => withBusy(button, async () => {
      const source = $('job-source').value.trim();
      const target = $('job-target').value.trim();
      if (!source || !target) { toast('源目录和目标目录都要填', 'warn'); return; }
      const excludes = $('job-excludes').value.split(',').map((s) => s.trim()).filter(Boolean);
      await client.addJob({
        name: $('job-name').value.trim() || source.split(/[\\/]/).pop(),
        direction: $('job-direction').value,
        source, target, excludes,
        mirror: $('job-mirror').checked,
        autoBackup: $('job-autobackup').checked,
      });
      $('job-name').value = ''; $('job-source').value = ''; $('job-target').value = ''; $('job-excludes').value = '';
      toast('任务已添加', 'success');
      const result = await client.listJobs();
      state.jobs = result?.jobs || [];
      renderJobs(); renderOverview();
    }),

    'job-run': (button) => withBusy(button, async () => {
      const result = await client.runJob(button.dataset.id, false);
      toast(result?.ok
        ? `同步完成：新增 ${result.copied}、更新 ${result.updated}、跳过 ${result.skipped}，${result.bytesText}`
        : `同步完成但有 ${result?.errors?.length || 0} 个错误`, result?.ok ? 'success' : 'warn', 7000);
      const fresh = await client.listJobs();
      state.jobs = fresh?.jobs || [];
      renderJobs();
    }),

    'job-dryrun': (button) => withBusy(button, async () => {
      const result = await client.runJob(button.dataset.id, true);
      toast(`演练：将新增 ${result?.copied || 0}、更新 ${result?.updated || 0}、删除 ${result?.deleted || 0}，共 ${result?.bytesText || '0 B'}（未做任何修改）`, 'info', 7000);
      const fresh = await client.listJobs();
      state.jobs = fresh?.jobs || [];
      renderJobs();
    }),

    'job-backup': (button) => withBusy(button, async () => {
      const result = await client.backupJob(button.dataset.id);
      toast(`备份完成：${result.copied} 个文件，${result.bytesText}`, 'success', 6000);
    }),

    'job-delete': (button) => withBusy(button, async () => {
      if (!confirm('删除这个同步任务？（已备份的文件不会被删除）')) return;
      await client.removeJob(button.dataset.id);
      const fresh = await client.listJobs();
      state.jobs = fresh?.jobs || [];
      renderJobs(); renderOverview();
    }),

    'devices-refresh': async (button) => withBusy(button, async () => {
      state.devices = await client.devices(true);
      renderDevices();
      toast(state.devices?.partial ? '枚举完成，但有部分失败' : '已刷新设备列表', state.devices?.partial ? 'warn' : 'success');
    }),

    'tokens-refresh': async () => {
      const result = await client.listTokens();
      state.tokens = result?.tokens || [];
      renderSettings();
    },

    'token-revoke': (button) => withBusy(button, async () => {
      await client.revokeToken(button.dataset.id);
      const result = await client.listTokens();
      state.tokens = result?.tokens || [];
      renderSettings();
      toast('已撤销该设备', 'success');
    }),

    'unpair-all': (button) => withBusy(button, async () => {
      if (!confirm('解绑所有设备？包括你当前这个浏览器。')) return;
      await client.unpairAll();
      handleUnauthorized();
    }),

    'rotate-pin': (button) => withBusy(button, async () => {
      if (!confirm('重置配对码会让所有已配对设备失效，并生成新配对码。继续？')) return;
      const result = await client.rotatePin();
      // 令牌已被清空，先展示新配对码再断开
      await new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'dialog';
        dialog.innerHTML = `
          <form method="dialog" class="dialog-form">
            <h2>新的配对码</h2>
            <p class="hint">请立即保存，它只会显示这一次。</p>
            <div style="font-family:var(--mono);font-size:30px;letter-spacing:8px;text-align:center;padding:14px;background:var(--bg);border:1px solid var(--border);border-radius:8px">${esc(result.pin)}</div>
            <div class="dialog-actions"><button class="btn btn-primary">我已记下</button></div>
          </form>`;
        document.body.appendChild(dialog);
        dialog.addEventListener('close', () => { dialog.remove(); resolve(); });
        dialog.showModal();
      });
      handleUnauthorized();
    }),

    'config-save': (button) => withBusy(button, async () => {
      const extraArgs = $('cfg-extra-args').value.split('\n').map((s) => s.trim()).filter(Boolean);
      // “宿主端口:客户机端口[:协议]” → 结构化数据
      const extraHostfwd = $('cfg-extra-hostfwd').value.split('\n')
        .map((s) => s.trim()).filter(Boolean)
        .map((line) => {
          const [h, g, p] = line.split(':').map((s) => s.trim());
          return {
            hostPort: Number(h),
            guestPort: Number(g),
            protocol: String(p || 'tcp').toLowerCase() === 'udp' ? 'udp' : 'tcp',
          };
        })
        .filter((e) => Number.isFinite(e.hostPort) && Number.isFinite(e.guestPort));

      const patch = {
        vm: {
          enabled: $('cfg-vm-enabled').checked,
          name: $('cfg-vm-name').value.trim(),
          qemuPath: $('cfg-qemu-path').value.trim(),
          imagePath: $('cfg-image-path').value.trim(),
          installerIso: $('cfg-installer-iso').value.trim(),
          memoryMb: Number($('cfg-memory').value),
          cpus: Number($('cfg-cpus').value),
          accel: $('cfg-accel').value,
          vga: $('cfg-vga').value,
          diskFormat: $('cfg-disk-format').value,
          diskInterface: $('cfg-disk-interface').value,
          netModel: $('cfg-net-model').value,
          sshPort: Number($('cfg-ssh-port').value),
          usbTablet: $('cfg-usb-tablet').checked,
          audio: $('cfg-audio').checked,
          extraHostfwd,
          extraArgs,
          share: {
            enabled: $('cfg-share-enabled').checked,
            dir: $('cfg-share-dir').value.trim(),
            tag: $('cfg-share-tag').value.trim() || 'hostshare',
            readOnly: $('cfg-share-readonly').checked,
          },
          vnc: { websocketPort: Number($('cfg-vnc-ws').value) },
        },
      };
      const password = $('cfg-vnc-password').value;
      if (password) patch.vm.vnc.password = password;

      state.config = await client.saveConfig(patch);
      $('cfg-vnc-password').value = '';
      toast('配置已保存，下次「启动」生效', 'success');
      await loadAll();
    }),

    'logs-clear': () => { state.logs = []; renderLogs(); },

    'vnc-connect': (button) => withBusy(button, connectVnc),
    'vnc-disconnect': () => { disconnectVnc(); toast('已断开画面'); },
  };

  /* ==================== VNC ==================== */

  async function connectVnc() {
    const vm = state.vm;
    const screen = $('vnc-screen');
    if (!vm || vm.state !== 'running') { toast('虚拟机还没运行', 'warn'); return; }
    if (!vm.vnc.websocketPort) { toast('未配置 VNC websocket 端口', 'warn'); return; }
    if (location.protocol === 'https:') {
      throw new Error('HTTPS 页面无法连接本机 ws://（混合内容拦截）。请用 http 打开本页，或给助手配一个 TLS 隧道。');
    }

    let RFB;
    try {
      const module = await import('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/core/rfb.js');
      RFB = module.default;
    } catch (err) {
      throw new Error(`无法从 CDN 加载 noVNC（${err.message}）。离线环境请把 noVNC 放到同目录。`);
    }

    disconnectVnc();
    screen.innerHTML = '';
    vncSession = new RFB(screen, `ws://127.0.0.1:${vm.vnc.websocketPort}`, {
      credentials: { password: '' },
    });
    vncSession.scaleViewport = true;
    vncSession.resizeSession = false;
    vncSession.background = '#05080b';
    vncSession.addEventListener('connect', () => toast('桌面画面已连接', 'success'));
    vncSession.addEventListener('disconnect', (event) => {
      vncSession = null;
      screen.innerHTML = emptyBox(`画面已断开${event?.detail?.reason ? `：${event.detail.reason}` : ''}`);
    });
  }

  function disconnectVnc() {
    if (vncSession) {
      try { vncSession.disconnect(); } catch { /* ignore */ }
      vncSession = null;
    }
  }

  /* ==================== 事件绑定 ==================== */

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    const handler = actions[action];
    if (!handler) {
      // 以前这里是静默 return，结果页面版本不一致（index.html 是新的、app.js 是缓存里的旧版）
      // 时，按钮看上去就是“点不动”且没有任何提示。现在让它说清楚。
      toast(`这个按钮（${action}）没有对应处理逻辑，页面可能不是最新版。`
        + '请按 Ctrl+F5 强制刷新后再试。', 'error', 10000);
      console.warn('[cloudlinux] 未知动作：', action, '已知动作：', Object.keys(actions));
      return;
    }
    event.preventDefault();
    try {
      const result = handler(trigger);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => toast(err.message || String(err), 'error', 7000));
      }
    } catch (err) {
      toast(err.message || String(err), 'error', 7000);
    }
  });

  $('nav').addEventListener('click', (event) => {
    const item = event.target.closest('.nav-item');
    if (item) showView(item.dataset.view);
  });

  $('btn-change-url').addEventListener('click', () => actions['open-url']());

  $('pair-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const pin = $('pair-pin').value.trim();
    const label = $('pair-label').value.trim() || `浏览器 · ${navigator.platform || '未知设备'}`;
    const errorBoxEl = $('pair-error');
    errorBoxEl.textContent = '';
    if (!pin) { errorBoxEl.textContent = '请输入配对码'; return; }

    try {
      const result = await client.pair(pin, label);
      client.saveToken(result.token);
      $('pair-dialog').close();
      setConnection('paired', { name: result.name });
      toast('配对成功 🎉', 'success');
      await connectEvents();
      startPolling();
      await loadAll();
    } catch (err) {
      errorBoxEl.textContent = err.message;
    }
  });

  $('url-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = $('url-input').value.trim().replace(/\/+$/, '');
    const errorEl = $('url-error');
    errorEl.textContent = '';
    if (!/^https?:\/\//i.test(value)) { errorEl.textContent = '地址必须以 http:// 或 https:// 开头'; return; }

    client.setBaseUrl(value);
    localStorage.setItem(BASE_KEY, value);
    $('url-dialog').close();
    stopPolling();
    disconnectVnc();

    const info = await checkConnection({ silent: true });
    if (info) {
      toast('已连接助手', 'success');
      if (client.isPaired) { await connectEvents(); startPolling(); await loadAll(); }
    } else {
      toast('连不上这个地址，请检查助手是否在运行', 'error', 6000);
    }
  });

  $('log-level').addEventListener('change', async (event) => {
    try {
      await client.setLogLevel(event.target.value);
      toast(`日志级别已切换为 ${event.target.value}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.connection === 'paired') refreshVmOnly();
  });

  window.addEventListener('beforeunload', () => disconnectVnc());

  /* ==================== 启动 ==================== */

  (async function boot() {
    renderLogs();
    setConnection('offline');

    // 版本自检：页面与脚本对不上先提醒，免得后缁疑难问题
    const pageVersion = document.body?.dataset?.appVersion;
    if (pageVersion && pageVersion !== APP_VERSION) {
      toast(`页面版本 ${pageVersion} 与脚本版本 ${APP_VERSION} 不一致，`
        + '部分按钮可能不工作。请按 Ctrl+F5 强制刷新。', 'error', 15000);
    }

    const info = await checkConnection({ silent: true });
    if (!info) {
      toast('连不上桌面助手。请先运行 agent（node src/index.js），然后点「重试连接」。', 'warn', 9000);
      return;
    }
    if (!client.isPaired) {
      toast('助手在线，请点右上角「立即配对」', 'info', 7000);
      return;
    }
    await connectEvents();
    startPolling();
    await loadAll();
  })();
})();
