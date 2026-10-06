# CloudLinux — 浏览器里的 Linux（本地算力版）

用 **GitHub Pages 上的静态网页** 当遥控器 + **本机的桌面助手程序** 当真正的"服务端"，
在浏览器里管理一台本机的 Zorin OS 虚拟机、同步文件、转发外设。

```
┌─────────────────────────────┐        ┌──────────────────────────────────────┐
│  GitHub Pages（静态，零算力） │        │  桌面助手 Agent（本机，真正的服务端）    │
│                             │        │                                      │
│  · 控制台 UI                 │  HTTP  │  · 本地 API（127.0.0.1）              │
│  · 虚拟机面板                │ ─────▶ │  · QEMU / KVM 虚拟机生命周期           │
│  · 文件同步面板              │   SSE  │  · 磁盘快照与回滚                      │
│  · 外设面板                  │ ◀───── │  · 文件同步 / 备份                     │
│  · 实时日志                  │        │  · USB / 串口 / 剪贴板                 │
└─────────────────────────────┘        └──────────────────────────────────────┘
```

**为什么这样设计**：GitHub Pages 只能放静态文件、没有后端算力，所以"云端"只能承担 UI。
真正的计算、虚拟化和数据全部留在用户自己机器上 —— 零服务器成本、数据不出本机。

---

## 目录结构

```
cloudlinux/
├── agent/                 桌面助手程序（Node.js，零第三方依赖）
│   ├── src/
│   │   ├── index.js       入口 / CLI / 优雅退出
│   │   ├── config.js      配置读写（data/config.json）
│   │   ├── util.js        工具函数
│   │   ├── logger.js      日志 + 环形缓冲（推给前端）
│   │   ├── security.js    配对 PIN / Token / Origin 白名单
│   │   ├── events.js      SSE 事件中心
│   │   ├── vm.js          QEMU 生命周期 + QMP 客户端 + 快照
│   │   ├── images.js      系统镜像下载（多镜像源/断点续传/SHA256）+ 建盘 + 一键准备
│   │   ├── sync.js        目录同步 / 备份引擎
│   │   ├── devices.js     USB / 串口 / 剪贴板枚举
│   │   ├── api.js         业务路由
│   │   └── server.js      HTTP / CORS / 路由 / 鉴权
│   ├── scripts/
│   │   ├── smoke-test.mjs    安全策略与核心接口的冒烟测试（30 项）
│   │   └── test-images.mjs   镜像链路测试（下载/取消/续传/SHA256，36 项）
│   └── data/              运行时数据（配置、密钥、备份、ISO）—— 已 gitignore
└── web/                   静态前端（直接丢到 GitHub Pages）
    ├── index.html
    ├── styles.css
    ├── agent-client.js    与本地助手通信的封装（含配对流）
    └── app.js             控制台逻辑
```

---

## 快速开始

### 1. 启动桌面助手

需要 **Node.js ≥ 18**（无需 `npm install`，零依赖）。

```bash
cd cloudlinux/agent
node src/index.js
```

首次运行会在控制台打印一个 **6 位配对码**，例如：

```
============================================================
  首次启动，请记下配对码（在网页控制台里输入）：
       配对码：  K7M2QX
  配对码只显示这一次；如需重置： node src/index.js --new-pin
============================================================
```

助手默认监听 `http://127.0.0.1:8765`，**只绑定本机回环地址，不对局域网暴露**。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--port 8765` | 修改监听端口 |
| `--host 127.0.0.1` | 修改监听地址（不建议改成 0.0.0.0） |
| `--data <dir>` | 自定义数据目录 |
| `--new-pin` | 生成新的配对码并打印（会清空已配对设备） |
| `--reset-pairing` | 撤销所有已配对设备 |
| `--help` | 帮助 |

### 2. 打开浏览器控制台

**本地调试**（推荐，因为 `file://` 打开时 `type=module` 会被 CORS 拦）：

```bash
cd cloudlinux/web
python -m http.server 5173
# 或： npx serve -l 5173
```

然后访问 <http://localhost:5173>，点右上角「配对」，输入配对码。

**部署到 GitHub Pages**：把 `web/` 目录内容推到一个仓库（或 `docs/` 目录），
在仓库 Settings → Pages 里选择分支/目录即可。见下方「部署」章节。

### 3. 一键装好 Zorin OS

助手**不会**静默下载系统镜像，但提供了一键流程（在控制台「虚拟机 → 系统镜像」里）：

1. **装 QEMU**：<https://www.qemu.org/download/>（Windows 用官方安装包即可）
2. 选镜像（默认 Zorin OS 18.1 Core）→ 点 **「一键准备」**
   助手会自动完成三件事：
   - 下载 ISO 到本地（**多镜像源、支持断点续传、带 SHA256 校验**）
   - 用 `qemu-img` 创建 qcow2 虚拟磁盘
   - 把「安装盘 + 磁盘路径」写进配置并启用虚拟机
3. 点 **「启动」** → 首次会从 ISO 引导，进入 Zorin OS 安装程序
4. 在客户机里装完系统后，回到控制台点 **「安装已完成」**
   助手会自动取消 ISO 引导，以后就从硬盘启动了

> **下载可能持续几十分钟**：助手把下载放到后台任务里跑，网页可以随时关掉；
> 进度、速度、剩余时间会实时推到控制台。中途取消或断网都不会白下——
> 分片会保留，再点一次「一键准备」就从断点继续。

不想用内置镜像列表？在「自定义镜像链接」里贴任意 `.iso` 直链即可，
有官方 SHA256 的话也一并填上，下载完会校验。

内置镜像目录（校验和取自 Zorin 官方公布值，直链为官方镜像站）：

| 镜像 | 体积 | 说明 |
| --- | --- | --- |
| Zorin OS 18.1 Core | 约 3.6 GiB | 免费版，4 种基础桌面布局（推荐） |
| Zorin OS 18.1 Lite | 约 3.7 GiB | 轻量版 XFCE，虚拟机里更流畅 |
| Zorin OS 18.1 Education | 约 7.5 GiB | 教育版，预装教学软件 |

镜像源可选：南大、上交、kernel.org、Kakao（实测均可用且支持断点续传）。

#### 手动配置（不用一键流程）

```bash
qemu-img create -f qcow2 zorin.qcow2 32G
```

然后在控制台「设置」里填好 `qemuPath` 与 `imagePath`，或直接改 `agent/data/config.json`：

```json
{
  "vm": {
    "enabled": true,
    "imagePath": "D:/vms/zorin/zorin.qcow2",
    "installerIso": "D:/iso/Zorin-OS-18.1-Core-64-bit.iso",
    "memoryMb": 4096,
    "cpus": 2,
    "vnc": { "enabled": true, "websocketPort": 5700 }
  }
}
```

> 装完系统后**记得清空 `installerIso`**（或在控制台点「安装已完成」），
> 否则每次都会优先从光盘引导。

助手会用 `-accel whpx`（Windows）/ `-accel kvm`（Linux）/ `-accel hvf`（macOS）拉起虚拟机，
失败会自动回退到 `tcg` 软件模拟。

---

## 安全模型（重要）

助手是一个**能被网页调用的本地守护进程**，所以做了三层防护：

1. **只绑回环地址** —— 默认 `127.0.0.1`，局域网内其他机器连不上。
2. **Host 头校验** —— 拒绝 `Host` 不是 `localhost / 127.0.0.1` 的请求，防 DNS Rebinding
   （恶意域名把自己解析到 127.0.0.1 来绕过浏览器同源策略）。
3. **Origin 白名单 + 配对 Token** —— 只有白名单里的站点（默认 `*.github.io`、`localhost`）
   才允许跨域；且所有敏感接口都要 `Authorization: Bearer <token>`。
   配对码错误 5 次后锁定 5 分钟。

前端把 token 存在 `localStorage`（按 agent 地址分开存）。

> 想把控制台暴露到公网（在外面也能连自己家机器）时，**不要**直接把端口映射出去，
> 用 Cloudflare Tunnel / Tailscale Funnel 这类带合法 TLS 的隧道，并收紧
> `security.allowedOrigins`。

---

## API 一览

不鉴权：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ping` | 探测助手是否在线（返回名称、版本、是否已配对） |
| POST | `/api/pair` | `{ pin, label }` → `{ token }` |

需要 `Authorization: Bearer <token>`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/overview` | 总览：助手 / 虚拟机 / 同步汇总 |
| GET | `/api/events?token=` | SSE 实时事件流（日志、VM 状态、同步进度） |
| GET | `/api/logs?limit=200` | 历史日志 |
| GET | `/api/config` · POST `/api/config` | 读取 / 局部更新配置 |
| GET | `/api/security/tokens` · DELETE `/api/security/tokens/:id` | 已配对设备 |
| POST | `/api/security/rotate-pin` · `/api/security/unpair` | 重置配对码 / 全部解绑 |
| GET | `/api/vm/status` | 虚拟机状态与运行参数 |
| POST | `/api/vm/start` · `/api/vm/stop` · `/api/vm/restart` | 生命周期 |
| GET | `/api/vm/snapshots` | 快照列表 |
| POST | `/api/vm/snapshots` | `{ name }` 创建快照 |
| POST | `/api/vm/snapshots/:name/restore` · DELETE `/api/vm/snapshots/:name` | 回滚 / 删除 |
| GET | `/api/sync/jobs` | 同步任务列表 |
| POST | `/api/sync/jobs` | 新建任务 |
| DELETE | `/api/sync/jobs/:id` | 删除任务 |
| POST | `/api/sync/jobs/:id/run` · `/backup` | 立即同步 / 备份 |
| GET | `/api/devices` · `/api/devices/serial` · `/api/devices/usb` | 外设枚举 |

### 系统镜像

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/images/catalog` | 内置镜像目录 + 本地 ISO 扫描（含未完成下载） |
| GET | `/api/images/status` | 当前任务进度 + 上次结果 |
| POST | `/api/images/probe` | 探测任意直链（大小 / 是否支持续传） |
| POST | `/api/images/download` | 开始下载 ISO（**后台任务，立即返回**） |
| POST | `/api/images/prepare` | 一键准备：下载 + 建盘 + 写配置（**后台任务**） |
| POST | `/api/images/cancel` | 取消当前任务（保留分片，可续传） |
| DELETE | `/api/images/partial` | 删除未完成的分片（只接受 `.part`） |
| POST | `/api/images/create-disk` | 仅创建 qcow2 磁盘 |
| POST | `/api/images/finish-install` | 安装完成，取消 ISO 引导 |

> 下载/准备是长任务，接口**不会**阻塞等待，而是立刻返回 `{ started: true }`，
> 进度通过 SSE 的 `image-progress` 事件推送，结果通过 `image` 事件推送。

---

## 部署前端到 GitHub Pages

仓库已配好工作流并实测部署成功：

> **控制台在线地址：<https://wangyvqian.github.io/cloudlinux/>**

方式一（最简单）：把 `cloudlinux/web/` 里的文件复制到仓库根目录或 `docs/`，
然后 Settings → Pages → Source 选对应目录。

方式二：`.github/workflows/deploy-web.yml` 会把 `cloudlinux/web` 发布到 Pages。
如果它是仓库根目录的 `.github/workflows/` 下，直接就能用；
若在子目录里，需要把它移到根目录并相应调整 `WEB_DIR`。

首次部署时 Pages 的“站点”需要先创建一次。`actions/configure-pages` 的 `enablement: true`
在部分仓库会报 `Resource not accessible by integration`，改用个人令牌建一次即可：

```bash
gh api -X POST repos/<用户名>/<仓库名>/pages -f build_type=workflow
```

### 混合内容：HTTPS 页面连本机 HTTP 助手

这是本方案能成立的关键，已经实测验证：

- GitHub Pages 是 **HTTPS**，而助手是 **`http://127.0.0.1:8765`**（**HTTP**）。
  按浏览器的混合内容策略，`http://127.0.0.1` 被当作 **potentially trustworthy origin**，
  因此 `fetch` 与 **`EventSource`（SSE）都能正常工作**——实测从 Pages 站点
  配对、加载数据、接收实时日志全部正常。
- 默认白名单里的 `https://*.github.io` 就是为这种情况准备的。
- **例外**：`ws://`（VNC 画面用）在 HTTPS 页面下仍可能被拦。想用画面，
  要么用 http 打开控制台，要么给助手配一个带 TLS 的隧道。

---

## 路线图

- [x] v0.1 打通链路：本地 API + 配对鉴权 + 静态控制台 + VM 生命周期 + 快照 + 同步 + 外设枚举
- [x] v0.2 一键安装镜像：多镜像源下载 + 断点续传 + SHA256 校验 + 自动建盘 + 写配置 + 取消/续传/安装收尾
- [ ] v0.3 WebRTC 串流（Selkies-GStreamer，支持 GPU 编码），替代 VNC 的卡顿体验
- [ ] v0.4 iframe 内嵌 noVNC + 剪贴板走 DataChannel
- [ ] v0.5 WebSerial / USB/IP 真正转发外设
- [ ] v0.6 打包（Tauri 出 Windows 安装包，托盘常驻 + 开机自启）
- [ ] v0.7 多虚拟机 / 多用户隔离

## 许可

MIT。Zorin OS 是独立项目，其商标与再分发条款请参见官方说明。
