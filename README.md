# Edge Voice Rooms - 基于纯 Cloudflare 服务的实时语音

<p align="center">
  <a href="https://github.com/Zxis233/edgevoice-workers/graphs/contributors">
    <img alt="AI" src="https://img.shields.io/badge/Fully-AI--Generated-black?logo=github-copilot&style=flat" />
  </a>
  <a href="https://github.com/Zxis233/edgevoice-workers/releases">
    <img src="https://img.shields.io/github/release/Zxis233/edgevoice-workers/all.svg?style=flat&color=blue">
  </a>
  <a href="https://github.com/Zxis233/edgevoice-workers/commits">
    <img alt="commit" src="https://img.shields.io/github/last-commit/Zxis233/edgevoice-workers?style=flat" />
  </a>
  <a href="https://github.com/Zxis233/edgevoice-workers?tab=GPL-3.0-1-ov-file#readme">
    <img alt="license" src="https://img.shields.io/github/license/Zxis233/edgevoice-workers?style=flat" />
  </a>
</p>

Edge Voice Rooms 是一个基于 Cloudflare Workers、Durable Objects、D1、R2 和原生 WebRTC 的 4-5 人小房间语音应用示例，可在 Cloudflare 边缘上跑通的语音房基线实现。

## 功能简介

- 创建房间并生成可分享链接
- 4-5 人实时语音通话
- 浏览器端 WebRTC mesh 连接
- Durable Object 房间级 WebSocket 信令
- 成员加入、离开、静音、说话状态同步
- D1 持久化房间与成员会话记录
- 房间结束后自动把结构化归档写入 R2
- 可选接入 Cloudflare Realtime TURN，提升复杂网络下的连通率

## 技术实现

### 整体架构

1. 前端静态页面由 Workers Assets 提供。
2. 用户加入房间时，浏览器先调用 `/api/ice-servers` 获取 ICE 配置。
3. 前端再通过 `/api/rooms/:roomId/ws` 连到对应房间的 Durable Object。
4. Durable Object 只负责房间成员管理和 WebRTC 信令转发，不搬运真实音频流。
5. 各浏览器之间通过 WebRTC 建立音频 mesh 连接。
6. D1 记录房间信息、参与者加入离开时间和最后状态。
7. 当最后一个人离开时，Worker 会把本场会话的结构化摘要写入 R2。

### 后端分工

- `Worker`
  - 房间创建与查询 API
  - ICE Servers 下发
  - 静态资源托管
- `Durable Object`
  - 单房间信令协调
  - WebSocket 连接生命周期管理
  - 广播成员加入/离开/状态变更
- `D1`
  - `rooms`
  - `room_participants`
- `R2`
  - 保存房间结束后的 JSON 归档

### 前端实现

- 无前端框架，直接使用原生 HTML/CSS/JS
- 使用 `RTCPeerConnection` 建立音频 mesh
- 本地麦克风状态、成员状态、连接状态在 UI 中展示
- 对移动端 `getUserMedia` 做了兼容与错误提示处理

### 为什么使用 mesh

这个项目的目标人数是 4-5 人。对于这个规模，mesh 的优势是：

- 架构简单
- 不需要单独的媒体服务器
- 可以直接把 Cloudflare 用在信令与状态层

超过这个人数后，推荐切换到 SFU 方案。

## 项目结构

```tree
├── migrations/
│  └── 0001_init.sql
├── public/
│  ├── app.js
│  ├── index.html
│  └── styles.css
├── src/
│  ├── db.js
│  ├── http.js
│  ├── ice.js
│  ├── index.js
│  ├── room-do.js
│  └── room-utils.js
├── test/
│  ├── api.test.js
│  └── signaling.test.js
├── package-lock.json
├── package.json
├── vitest.config.js
└── wrangler.jsonc
```

## 本地开发

### 环境要求

- Node.js 20+
- npm 10+
- Cloudflare 账号

### 安装依赖

```bash
npm install
```

### 初始化本地 D1

```bash
npm run db:migrate:local
```

### 启动本地开发

```bash
npm run dev
```

默认打开 Wrangler 提供的本地地址即可。

## 局域网 / 移动端测试

如果你想在手机或局域网设备上测试，建议这样启动：

```bash
npm run dev -- --ip 0.0.0.0 --port 8787 --local-protocol https
```

然后在手机上访问：

```text
https://你的局域网IP:8787
```

注意：

- **移动端浏览器通常要求 `HTTPS` 或 `localhost` 才会开放麦克风接口**
- 首次访问可能会遇到自签名证书告警，需要手动信任
- Windows 防火墙需要放行对应端口

## 自动化测试

运行：

```bash
npm test
```

当前测试覆盖：

- 房间创建与查询 API
- Durable Object WebSocket 信令转发
- 成员状态同步
- 最后一位成员离开时的 R2 归档

## 部署方法

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Zxis233/edgevoice-workers)

1. Fork 本仓库。若本项目对你有帮助，欢迎点个 Star。
2. 打开 [Workers](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create) ➜ `Continue with GitHub` ➜ 选择你 Fork 后的仓库（`edgevoice-workers`）➜ 下一步 ➜ 将部署命令改为 `npm run deploy`
3. 也可采用下面的本地验证+部署的方式，可配置选项更多

### 1. 登录 Cloudflare

```bash
npx wrangler login
```

### 2. 检查资源绑定

当前项目使用：

- 1 个 D1 数据库：`DB`
- 1 个 R2 bucket：`ROOM_ARCHIVE`
- 1 个 Durable Object namespace：`VOICE_ROOMS`

这些绑定定义在 `wrangler.jsonc` 中。

如果你把这个仓库作为模板发到 GitHub，建议你二选一：

1. 保留当前绑定结构，但把资源改成你自己账号下的 D1 / R2
2. 移除 D1 的 `database_id` 与 R2 的 `bucket_name`，让 Wrangler 在首次 deploy 时自动 provision

### 3. 配置可选 TURN Secrets

如果你启用了 Cloudflare Realtime TURN，可配置：

```bash
npx wrangler secret put CLOUDFLARE_TURN_KEY_ID
npx wrangler secret put CLOUDFLARE_TURN_TOKEN
```

本地开发可改用 `.dev.vars`：

```dotenv
CLOUDFLARE_TURN_KEY_ID="..."
CLOUDFLARE_TURN_TOKEN="..."
```

### 4. 部署 Worker

```bash
npm run deploy
```

### 5. 执行远端 D1 migration

```bash
npm run db:migrate:remote
```

### 6. 验证部署

可以先检查：

```bash
curl https://你的域名/health
curl https://你的域名/api/ice-servers
```

## 未来可扩展方向

- 切换到 SFU 架构
- 加入登录与房间权限
- 接入录音和转写
- 会后 AI 总结
- 设备切换与音频输入输出选择
- 更完整的移动端调试 UI