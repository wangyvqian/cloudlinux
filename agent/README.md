# CloudLinux 桌面助手（Agent）

本机常驻进程，也是这套系统**真正的"服务端"**：管理虚拟机、同步文件、枚举外设，
并把能力通过一个受保护的本地 HTTP/SSE 接口暴露给 GitHub Pages 上的静态控制台。

- 运行时：**Node.js ≥ 18**（实测 v24）
- 依赖：**零第三方依赖**，不需要 `npm install`
- 默认监听：`http://127.0.0.1:8765`（只绑回环地址）

## 运行

```bash
node src/index.js
```

首次启动会在终端打印 6 位配对码（只显示一次）。

### 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--host <addr>` | 监听地址，默认 `127.0.0.1` |
| `--port <n>` | 监听端口，默认 `8765` |
| `--data <dir>` | 数据目录，默认 `./data`（也可用环境变量 `CLOUDLINUX_DATA`） |
| `--log-level <lvl>` | `debug` / `info` / `warn` / `error` |
| `--new-pin` | 生成新配对码并解绑所有设备，然后退出 |
| `--reset-pairing` | 解绑所有已配对设备，然后退出 |
| `--print-routes` | 打印全部 API 路由，然后退出 |
| `--help` / `--version` | 帮助 / 版本 |

```bash
npm start           # 等价于 node src/index.js
npm run dev         # node --watch，改代码自动重启
npm run new-pin     # 重置配对码
```

## 冒烟测试

助手跑起来之后（另开一个终端）：

```bash
# 安全策略 + 核心接口（30 项断言）
node scripts/smoke-test.mjs <配对码>

# 镜像链路：目录 / 探测 / 下载 / 取消 / 断点续传 / SHA256 / 清理（36 项断言）
node scripts/test-images.mjs <配对码>
```

`smoke-test.mjs` 覆盖：公开接口、鉴权拦截、配对流程、Origin 白名单、Host 反 DNS-Rebinding、
核心接口、错误处理、令牌撤销即时生效。

`test-images.mjs` 默认**只下到指定体积就取消**（不会真下完 3.6 GiB），
用 `--bytes` 调整阈值。它会在本地起一个支持 Range 的 HTTP 服务，
用小文件把 SHA256 校验的“通过 / 失败”两条分支都验证掉：

```bash
node scripts/test-images.mjs <配对码> --bytes 40000000   # 下到 38MB 后取消并验证续传
node scripts/test-images.mjs <配对码> --full             # 真的下完（会下几 GiB）
```

两个脚本都以退出码非 0 表示有失败。

## 目录说明

```
src/
  index.js     入口：CLI 解析、装配各模块、优雅退出（退出时会顺手关掉虚拟机）
  config.js    配置默认值 + data/config.json 读写 + 前端提交字段的白名单校验
  util.js      工具函数（glob、深合并、端口探测、安全路径拼接等）
  logger.js    日志 + 环形缓冲，同时推给 SSE
  security.js  配对码 / 长期令牌 / Origin 与 Host 白名单
  events.js    SSE 事件中心
  vm.js        QEMU 生命周期 + QMP 客户端 + 快照
  images.js    镜像下载（多源/续传/SHA256）+ 建盘 + 一键准备
  sync.js      目录同步 / 备份引擎
  devices.js   串口 / USB / 剪贴板
  api.js       业务路由表
  server.js    HTTP 服务、CORS、鉴权、错误处理

data/          运行时数据（已 gitignore）
  config.json    配置
  security.json  盐值、配对码哈希、令牌哈希（不存明文）
  backups/       同步任务的备份点
  images/        下载的 ISO（只有真正在用才会创建）
```

## 系统镜像下载

- **内置目录**：Zorin OS 18.1 Core / Lite / Education。校验和取自 Zorin 官方公布值，
  直链指向官方镜像站（南大 / 上交 / kernel.org / Kakao）。
- **断点续传**：写入 `<文件名>.part`，取消/断网后再次下载会自动带 `Range` 头续传。
  镜像源不支持 Range 时会自动从头下。
- **SHA256 校验**：内置条目自带校验和；自定义链接可用 `expectSha256` 传入。
  校验失败会**删掉分片**（否则下次会被误判为可续传的完整文件）。
- **不会阻塞 HTTP**：下载与一键准备都是后台任务，接口立即返回，进度走 SSE。
- **同时只跑一个任务**（`_busy` 同步忙锁），并发请求会得到 409。

### 它做了什么

```
一键准备 = 下载 ISO  →  qemu-img create 建盘  →  写配置(enabled/imagePath/installerIso)
安装已完成 = 清空 installerIso（下次不再从光盘引导）
```

### 为什么用 expectSha256

自定义直链无法预知正确校验和，所以默认跳过校验（只打一条 warn 日志）。
如果你拿到了官方 SHA256，填上就能获得与内置条目一样的保护。

## 状态文件与安全

`data/security.json` 里**只有哈希**，没有明文配对码或令牌：

```json
{ "salt": "...", "pinHash": "...", "tokens": [{ "id": "...", "label": "...", "hash": "..." }] }
```

忘了配对码就 `npm run new-pin`（会解绑所有设备）。

## 设计取舍（第一版）

- **同步是主机侧目录之间的**。要让客户机看到文件，用 QEMU 的共享目录挂载，
  例如在 `vm.extraArgs` 里加：
  `-virtfs local,path=D:\share,mount_tag=hostshare,security_model=none`
  然后在客户机 `mount -t 9p -o trans=virtio hostshare /mnt/host`
  （Windows 宿主不支持 `-virtfs`，改用 SMB 共享或 `-drive file=fat:rw:D:\share`）。
- **USB 只做枚举**，真正直通需要把设备列表里的 `qemuArg` 手动加进 `extraArgs`。
- **剪贴板**只存在助手进程内存里，跨浏览器/客户机的剪贴板要等 WebRTC DataChannel。
- **VNC 画面**在 HTTPS 页面里连不上本机 `ws://`（混合内容拦截）。想用它，
  要么用 http 打开控制台，要么给助手配一个带 TLS 的隧道。

## 环境准备

### QEMU

- Windows：<https://qemu.weilnetz.de/w64/>（内含 `qemu-system-x86_64.exe` 与 `qemu-img.exe`）
- Linux：`sudo apt install qemu-system-x86 qemu-utils`
- macOS：`brew install qemu`

### 创建 Zorin OS 磁盘

```bash
qemu-img create -f qcow2 zorin.qcow2 32G
```

在控制台「设置」里填好镜像路径并勾选「启用虚拟机管理」。首次安装系统时把 ISO
填进「安装 ISO」，装完**记得清空**该字段（否则会一直优先从光盘启动）。

Windows 上加速器会自动选 `whpx`（需启用 Hyper-V / Windows 虚拟机监控程序平台），
失败会自动回退到 `tcg`（纯软件模拟，很慢，只适合验证流程）。
