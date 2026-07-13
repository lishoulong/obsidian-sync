# VaultBridge

VaultBridge 是一个以 Obsidian 插件为主客户端的同步系统。本仓库采用 monorepo：桌面端插件默认使用本地 Git，移动端插件通过 Cloudflare Worker Protocol v2 安全地读写 GitHub 仓库。

## 架构

```text
Obsidian Desktop → VaultBridge Sync → local git ─────────→ GitHub

Obsidian Mobile  → VaultBridge Sync → HTTPS Worker API → GitHub API → GitHub
```

Worker 隔离 GitHub 凭证，并负责三方比较、同步 Session、Git blob/tree/commit/ref 操作和 `.vaultbridge/manifest.json`。插件只保存 Worker URL、`SYNC_TOKEN` 和设备同步状态。

## 目录

```text
apps/
  obsidian-plugin/   Obsidian 插件、测试和发布资产
  worker/            Cloudflare Worker、Wrangler 配置和运维工具
docs/
  protocol-v2.md     插件与 Worker 的接口契约
  self-host.zh-CN.md 自部署说明
```

## 开发

要求 Node.js 22 和 Corepack。安装依赖并验证全部应用：

```bash
corepack enable
pnpm install
pnpm verify
```

常用命令：

```bash
pnpm dev:plugin
pnpm dev:worker
pnpm deploy:worker
```

## 自部署

完整步骤见 [自部署说明](docs/self-host.zh-CN.md)。Worker 配置位于 `apps/worker/`：

- `wrangler.example.jsonc`
- `wrangler.self-host.example.jsonc`
- `.dev.vars.example`

不要把真实 token 写进仓库。`GITHUB_TOKEN` 和 `SYNC_TOKEN` 必须使用 Cloudflare Worker secrets。

## Protocol v2

主要接口：

- `GET /v2/setup/check`
- `POST /v2/sync/check`
- `POST /v2/pull/file`
- `POST /v2/blob`
- `POST /v2/commit`

协议格式和冲突策略见 [Protocol v2](docs/protocol-v2.md)。

## 已知限制

- 第一次同步没有共同基准时，同名不同内容会被标记为冲突。
- 大型仓库首次同步可能需要由 Worker 从 GitHub tree 重建 Manifest。
- GitHub recursive tree 返回 truncated 时会拒绝同步，避免处理不完整的数据。
- 单文件默认上限为 20 MiB，可通过 `MAX_FILE_BYTES` 调整。
