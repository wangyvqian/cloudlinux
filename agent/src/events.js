/**
 * SSE 事件中心：把日志、虚拟机状态、同步进度实时推给浏览器。
 */
export class EventHub {
  constructor({ logger, heartbeatMs = 20000 } = {}) {
    this.logger = logger;
    this.clients = new Set();
    this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  get size() {
    return this.clients.size;
  }

  /** 挂载一个 SSE 客户端（调用方已完成鉴权）。 */
  add(req, res, { tokenId = null } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const client = { res, tokenId, id: Math.random().toString(36).slice(2, 10) };
    this.clients.add(client);
    this.send(client, 'hello', { clientId: client.id, serverTime: new Date().toISOString() });

    const drop = () => {
      this.clients.delete(client);
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);
    return client;
  }

  /**
   * 切断某个令牌对应的所有事件流。
   * 撤销配对后必须调用，否则被撤销的设备仍能继续接收日志和状态推送。
   * @returns {number} 被切断的连接数
   */
  closeByTokenId(tokenId) {
    let closed = 0;
    for (const client of [...this.clients]) {
      if (client.tokenId !== tokenId) continue;
      this.clients.delete(client);
      try { client.res.end(); } catch { /* ignore */ }
      closed += 1;
    }
    return closed;
  }

  send(client, type, data) {
    try {
      client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(type, data) {
    if (!this.clients.size) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.res.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  ping() {
    for (const client of [...this.clients]) {
      try {
        client.res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  closeAll() {
    clearInterval(this.heartbeat);
    for (const client of [...this.clients]) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}
