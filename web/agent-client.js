/**
 * AgentClient —— 浏览器侧与本地桌面助手通信的封装。
 *
 * 关键设计：
 *  - 令牌按「助手地址」分开存在 localStorage，换地址不会串号
 *  - 统一的错误类型 AgentError（带 status / code），方便 UI 区分「没配对」和「真出错」
 *  - EventSource 走 SSE，撤销令牌后服务端断开连接，前端自动回退到未配对状态
 */
(function attachAgentClient(global) {
  'use strict';

  const TOKEN_PREFIX = 'cloudlinux.token.';

  class AgentError extends Error {
    constructor(message, { status = 0, code = 'UNKNOWN', detail = null } = {}) {
      super(message);
      this.name = 'AgentError';
      this.status = status;
      this.code = code;
      this.detail = detail;
    }

    get isUnauthorized() {
      return this.status === 401 || this.code === 'UNAUTHORIZED';
    }

    get isOffline() {
      return this.status === 0;
    }
  }

  class AgentClient {
    constructor({ baseUrl = 'http://127.0.0.1:8765', timeoutMs = 20000 } = {}) {
      this.timeoutMs = timeoutMs;
      this.source = null;
      this.setBaseUrl(baseUrl);
    }

    /* -------------------- 基础 -------------------- */

    setBaseUrl(baseUrl) {
      this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
      return this;
    }

    get tokenKey() {
      return `${TOKEN_PREFIX}${this.baseUrl}`;
    }

    get token() {
      try { return localStorage.getItem(this.tokenKey) || ''; } catch { return ''; }
    }

    get isPaired() {
      return Boolean(this.token);
    }

    saveToken(token) {
      try { localStorage.setItem(this.tokenKey, token); } catch { /* 隐私模式 */ }
    }

    clearToken() {
      try { localStorage.removeItem(this.tokenKey); } catch { /* ignore */ }
      this.disconnectEvents();
    }

    /**
     * 统一的请求方法。返回 payload.data。
     */
    async request(path, { method = 'GET', body, auth = true, timeoutMs } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;

      let response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          mode: 'cors',
        });
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          throw new AgentError('助手响应超时', { code: 'TIMEOUT' });
        }
        throw new AgentError(
          '连不上桌面助手。请确认助手程序已启动，且地址正确（默认 http://127.0.0.1:8765）。',
          { code: 'OFFLINE' },
        );
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

      if (!response.ok || (payload && payload.ok === false)) {
        const message = payload?.error || `请求失败（HTTP ${response.status}）`;
        const code = payload?.code || (response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR');
        if (response.status === 401) this.clearToken();
        throw new AgentError(message, { status: response.status, code, detail: payload?.detail ?? null });
      }
      return payload ? payload.data : null;
    }

    /* -------------------- 接口 -------------------- */

    ping() { return this.request('/api/ping', { auth: false, timeoutMs: 4000 }); }

    pair(pin, label = 'browser') {
      return this.request('/api/pair', { method: 'POST', auth: false, body: { pin, label } });
    }

    overview() { return this.request('/api/overview'); }
    logs(limit = 200) { return this.request(`/api/logs?limit=${encodeURIComponent(limit)}`); }
    setLogLevel(level) { return this.request('/api/logs/level', { method: 'POST', body: { level } }); }

    getConfig() { return this.request('/api/config'); }
    saveConfig(patch) { return this.request('/api/config', { method: 'POST', body: patch }); }

    listTokens() { return this.request('/api/security/tokens'); }
    revokeToken(id) { return this.request(`/api/security/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    unpairAll() { return this.request('/api/security/unpair', { method: 'POST' }); }
    rotatePin() { return this.request('/api/security/rotate-pin', { method: 'POST' }); }

    vmStatus() { return this.request('/api/vm/status'); }
    vmDetect() { return this.request('/api/vm/detect', { method: 'POST' }); }
    vmStart() { return this.request('/api/vm/start', { method: 'POST', timeoutMs: 180000 }); }
    vmStop(force = false) { return this.request('/api/vm/stop', { method: 'POST', body: { force }, timeoutMs: 90000 }); }
    vmRestart() { return this.request('/api/vm/restart', { method: 'POST', timeoutMs: 240000 }); }

    snapshots() { return this.request('/api/vm/snapshots'); }
    createSnapshot(name) { return this.request('/api/vm/snapshots', { method: 'POST', body: { name }, timeoutMs: 180000 }); }
    restoreSnapshot(name) { return this.request(`/api/vm/snapshots/${encodeURIComponent(name)}/restore`, { method: 'POST', timeoutMs: 240000 }); }
    deleteSnapshot(name) { return this.request(`/api/vm/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE', timeoutMs: 60000 }); }

    listJobs() { return this.request('/api/sync/jobs'); }
    addJob(job) { return this.request('/api/sync/jobs', { method: 'POST', body: job }); }
    removeJob(id) { return this.request(`/api/sync/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    runJob(id, dryRun = false) { return this.request(`/api/sync/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: { dryRun }, timeoutMs: 600000 }); }
    backupJob(id) { return this.request(`/api/sync/jobs/${encodeURIComponent(id)}/backup`, { method: 'POST', timeoutMs: 600000 }); }
    listBackups(id) { return this.request(`/api/sync/jobs/${encodeURIComponent(id)}/backups`); }

    devices(refresh = false) { return this.request(`/api/devices${refresh ? '?refresh=1' : ''}`); }

    /* -------------------- 系统镜像 -------------------- */

    imagesCatalog(dir) {
      return this.request(`/api/images/catalog${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
    }

    imageStatus() { return this.request('/api/images/status'); }

    imageProbe(url) { return this.request('/api/images/probe', { method: 'POST', body: { url } }); }

    // 下载与一键准备是后台任务，接口会立刻返回，进度走 SSE
    imageDownload(body) { return this.request('/api/images/download', { method: 'POST', body }); }
    imagePrepare(body) { return this.request('/api/images/prepare', { method: 'POST', body }); }
    imageCancel() { return this.request('/api/images/cancel', { method: 'POST' }); }
    imageDeletePartial(path) { return this.request('/api/images/partial', { method: 'DELETE', body: { path } }); }
    imageCreateDisk(body) { return this.request('/api/images/create-disk', { method: 'POST', body }); }
    imageFinishInstall() { return this.request('/api/images/finish-install', { method: 'POST' }); }

    /* -------------------- 事件流 -------------------- */

    /**
     * 连接 SSE。handlers 形如 { log: fn, vm: fn, notification: fn }。
     * 返回一个 promise，resolve 表示已连上。
     */
    connectEvents(handlers = {}) {
      this.disconnectEvents();
      return new Promise((resolve, reject) => {
        if (!this.token) {
          reject(new AgentError('尚未配对', { code: 'UNAUTHORIZED' }));
          return;
        }
        const url = `${this.baseUrl}/api/events?token=${encodeURIComponent(this.token)}`;
        const source = new EventSource(url);
        this.source = source;
        this.eventRetries = 0;

        source.onopen = () => {
          this.eventRetries = 0;
          handlers.open?.();
          resolve();
        };

        source.onerror = () => {
          if (source.readyState === EventSource.CLOSED) {
            // 服务端拒绝或关闭了连接（多半是令牌已失效），EventSource 不会再自动重试
            this.disconnectEvents();
            handlers.closed?.();
            reject(new AgentError('事件流已关闭', { status: 401, code: 'UNAUTHORIZED' }));
            return;
          }
          // 助手暂时不可达：EventSource 自己会做退避重连，这里只上报状态
          handlers.error?.();
        };

        const known = [
          'hello', 'log', 'vm', 'sync', 'sync-progress', 'security', 'config', 'notification',
          'image', 'image-progress',
        ];
        for (const name of known) {
          source.addEventListener(name, (event) => {
            let data = null;
            try { data = JSON.parse(event.data); } catch { /* ignore */ }
            handlers[name]?.(data);
            handlers.any?.(name, data);
          });
        }
      });
    }

    disconnectEvents() {
      if (this.source) {
        try { this.source.close(); } catch { /* ignore */ }
        this.source = null;
      }
    }
  }

  global.AgentClient = AgentClient;
  global.AgentError = AgentError;
})(window);
