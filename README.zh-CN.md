# VaultBridge

VaultBridge 是一个以 Obsidian 插件为主客户端的同步系统。本仓库采用 monorepo：桌面端插件默认使用本地 Git，移动端插件通过 Cloudflare Worker Protocol v2 安全地读写 GitHub 仓库。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lishoulong/obsidian-sync/tree/main/apps/worker)

第一次使用请从[从零到一指南](docs/onboarding.zh-CN.md)开始。DeepSeek API Key 仅用于可选的 AI 冲突合并，不是正常同步的必需条件。

## 架构

```text
Obsidian Desktop → VaultBridge Sync → local git ─────────→ GitHub

Obsidian Mobile  → VaultBridge Sync → HTTPS Worker API → GitHub API → GitHub
```

Worker 隔离 GitHub 凭证，并负责三方比较、同步 Session、Git blob/tree/commit/ref 操作和 `.vaultbridge/manifest.json`。第一台管理设备可以使用 `SYNC_TOKEN`，后续设备通过短期配对码获得独立、可撤销的设备 Token；插件只保存 Worker URL、Worker 访问凭证和设备同步状态。

## 目录

```text
apps/
  obsidian-plugin/   Obsidian 插件、测试和发布资产
  worker/            Cloudflare Worker、Wrangler 配置和运维工具
docs/
  protocol-v2.md     插件与 Worker 的接口契约
  onboarding.zh-CN.md 从零到一安装、迁移和配对
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

开源自托管版采用“一名用户一个 Worker”的模型。每位用户部署自己的 Worker，并连接自己的 GitHub 私有笔记仓库；不要让互不信任的用户共享同一个 Worker 和 `SYNC_TOKEN`。

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
