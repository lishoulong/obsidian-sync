# VaultBridge 自部署通用版

这份文档面向 fork/clone 本仓库后自行部署的人。目标是把 VaultBridge Worker 连接到你自己的 GitHub 仓库，再让 Obsidian 插件使用这个 Worker。

## 1. 准备 GitHub 仓库

1. 创建或选择一个用于保存 Obsidian 文件的仓库。
2. 确认同步分支，例如 `main`。
3. 决定 Obsidian 文件在仓库里的位置：
   - 放在仓库根目录：远端前缀留空。
   - 放在 `vault/` 子目录：远端前缀填 `vault/`。
4. 创建 GitHub Personal Access Token。

推荐使用 Fine-grained token，并只授权目标仓库：

- Repository access：只选你的 Vault 仓库。
- Permissions：`Contents` 选择 `Read and write`。
- `Metadata` 保持默认只读。

不要把 GitHub token 填进 Obsidian 插件或仓库文件。它只应该存在于 Cloudflare Worker secret `GITHUB_TOKEN` 中。

## 2. 配置 Cloudflare Worker

安装依赖并登录 Cloudflare：

```bash
corepack enable
pnpm install
cd apps/worker
pnpm exec wrangler login
```

复制示例配置：

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

编辑 `wrangler.jsonc`：

```jsonc
{
  "name": "vaultbridge",
  "main": "src/index.js",
  "compatibility_date": "2026-07-01",
  "vars": {
    "GITHUB_OWNER": "your-github-user-or-org",
    "GITHUB_REPO": "your-vault-repo",
    "GITHUB_BRANCH": "main",
    "MAX_FILE_BYTES": "20971520"
  }
}
```

也可以使用单个变量：

```jsonc
{
  "vars": {
    "GITHUB_REPOSITORY": "your-github-user-or-org/your-vault-repo",
    "GITHUB_BRANCH": "main",
    "MAX_FILE_BYTES": "20971520"
  }
}
```

`GITHUB_REPOSITORY` 与 `GITHUB_OWNER` + `GITHUB_REPO` 二选一即可。仓库里同时提供了两个示例：

- `apps/worker/wrangler.example.jsonc`：拆分写法。
- `apps/worker/wrangler.self-host.example.jsonc`：`owner/repo` 写法。

写入 Worker secrets：

```bash
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm exec wrangler secret put SYNC_TOKEN
```

`SYNC_TOKEN` 是客户端访问 Worker 的共享密钥。建议生成一个随机值：

```bash
openssl rand -base64 32
```

部署：

```bash
pnpm deploy
```

部署后访问：

```text
GET https://<your-worker>.<your-subdomain>.workers.dev/health
```

成功时应看到 `service: "vaultbridge"`、`version: "0.3.3"`、`protocol: 2`。

进一步验证 Worker secrets、GitHub token、仓库和分支配置：

```bash
curl -H "Authorization: Bearer <SYNC_TOKEN>" \
  https://<your-worker>.<your-subdomain>.workers.dev/v2/setup/check
```

成功时会返回绑定的 GitHub 仓库、分支、当前 HEAD commit、manifest 路径和文件大小上限。

## 3. 本地调试配置

本地 `wrangler dev` 可以使用 `.dev.vars`。不要提交 `.dev.vars`，仓库里只保留 `.dev.vars.example`。

```bash
cd apps/worker
cp .dev.vars.example .dev.vars
pnpm dev
```

`.dev.vars` 里可以放本地调试用的 `GITHUB_TOKEN` 和 `SYNC_TOKEN`。线上部署仍以 Cloudflare Worker secrets 为准。

## 4. Obsidian 插件设置

插件设置页名称为 `VaultBridge Sync`。关键字段如下：

- `Worker URL`：你的 Worker 地址，例如 `https://vaultbridge.example.workers.dev`，末尾不要带 `/`。
- `SYNC_TOKEN`：与 Worker secret `SYNC_TOKEN` 完全一致。
- `Device ID`：每台设备稳定且唯一，例如 `alice-iphone`、`alice-macbook`。允许字母、数字、点、下划线、连字符，长度 2-64。
- `Maximum file size`：客户端侧单文件上限，建议与 Worker 的 `MAX_FILE_BYTES` 保持一致。
- `Remote path prefix`：仓库内 Vault 文件所在目录。
- `Local path prefix`：当前 Obsidian vault 内需要同步的子目录。

常见路径配置：

| 使用方式 | Remote path prefix | Local path prefix |
| --- | --- | --- |
| GitHub 仓库根目录就是笔记 | 留空 | 留空 |
| GitHub 仓库用 `vault/` 保存笔记，Obsidian 打开的是笔记目录 | `vault/` | 留空 |
| Obsidian 桌面端打开的是 Git 仓库根目录，笔记在本地 `vault/` | `vault/` | `vault/` |

插件会把设备状态保存在 Obsidian 插件数据中，不需要你手动提交 `device-state.json`。桌面端可选开启 Git commit/push；移动端不会直接操作本地 Git。

## 5. 首次同步建议

首次同步没有共同基准，VaultBridge 会保守处理：

- 本地有、远端没有：计划上传。
- 远端有、本地没有：计划下载。
- 本地和远端同路径但内容不同：标记冲突，不自动覆盖。

建议流程：

1. 先备份本地 Vault 和 GitHub 仓库。
2. 先点插件里的 `Test connection` 或请求 `/health`。
3. 第一次只做手动同步，不要先开自动化。
4. 检查 `.remote-conflict-...` 文件，确认冲突处理符合预期。
5. 确认 Pull、Push、删除、冲突副本都正常后，再开启插件自动同步或桌面自动 Git push。

## 6. 安全和排错

- `GITHUB_TOKEN` 权限越小越好，只给目标仓库 Contents 读写。
- `SYNC_TOKEN` 泄露后，任何人都可能通过你的 Worker 改写目标仓库；泄露时应立即重置 Worker secret。
- `.vaultbridge/` 是 Worker 内部目录，客户端不应上传或编辑。
- 如果同步提示 `missing_config`，检查 Worker vars/secrets 是否已设置。
- 如果提示 `unauthorized`，检查客户端 `SYNC_TOKEN` 是否与 Worker secret 完全一致。
- 如果提示 `sync_session_stale`，说明生成同步计划后远端分支又变化了，重新同步即可。
- 如果第一次大型仓库较慢，通常是 Worker 需要从 GitHub tree 重建 `.vaultbridge/manifest.json`。
