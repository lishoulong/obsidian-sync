# VaultBridge 从零到一

本指南面向第一次使用 VaultBridge 的用户。VaultBridge 的开源自托管版本采用“一名用户一个 Worker”的模型：笔记保存在你自己的 GitHub 私有仓库，Cloudflare Worker 部署在你自己的账号中，VaultBridge 项目不接触你的笔记和 GitHub 凭证。

## 开始之前

必须准备：

- 一个 GitHub 账号和一个私有笔记仓库；
- 一个 Cloudflare 账号；
- GitHub Fine-grained personal access token，只授权笔记仓库的 `Contents: Read and write`；
- 一个随机的 `SYNC_TOKEN`，作为管理和兼容凭证。

DeepSeek API Key、自定义域名和 AI 冲突合并都不是首次同步的必要条件。只有主动启用 Auto Merge Conflict 时，插件才会把冲突文件内容发送给配置的模型服务。

## 第一步：确定初始数据源

首次同步前只选择一种情况：

| 模式 | 使用场景 | 安全条件 |
| --- | --- | --- |
| GitHub 是初始版本 | 笔记已经在 GitHub，新手机需要恢复 | 手机使用空 Vault；首次只下载 |
| 这台设备是初始版本 | 笔记只在当前设备，需要首次上传 | 远端同步目录必须为空 |
| 安全合并 | 本地和 GitHub 都有内容 | 同名不同内容生成冲突副本，不自动覆盖 |

如果桌面已经有 Vault、GitHub 还没有笔记：

1. 创建私有仓库；
2. 使用 GitHub Desktop 或 Git 将 Vault 推送到该仓库；
3. 确保 `main` 分支至少有一个 Commit。

当前 Worker 通过 Git branch HEAD 建立同步快照，因此完全空、没有任何 Commit 的仓库无法初始化。新建仓库时可以先创建 README，或者直接从桌面推送 Vault。

建议使用专门的笔记仓库。已有笔记已经位于仓库根目录时，远端路径前缀可以留空。新建仓库并准备从本机首次上传时，建议保留初始化 README，同时把笔记放在 `vault/`，远端路径前缀使用默认的 `vault/`；这样仓库已有 HEAD Commit，但远端笔记目录仍然为空，符合本机优先的安全条件。

## 第二步：创建最小权限的 GitHub Token

在 GitHub 的 Fine-grained personal access token 页面创建 Token：

1. Repository access 选择 `Only select repositories`；
2. 只选择笔记仓库；
3. Repository permissions 中只把 `Contents` 设置为 `Read and write`；
4. 设置合理的过期时间并保存 Token。

这个值是 Worker 使用的 `GITHUB_TOKEN`。它只能写入 Cloudflare Secret，不得写入 Obsidian 插件、二维码、仓库文件或聊天记录。

## 第三步：部署 Worker

优先使用项目首页的 **Deploy to Cloudflare** 按钮。部署页面会从公开的 VaultBridge Worker 模板创建并部署你自己的 Worker。

需要配置的运行时值：

- `GITHUB_OWNER`：GitHub 用户名或组织名；
- `GITHUB_REPO`：私有笔记仓库名；
- `GITHUB_BRANCH`：通常为 `main`；
- `MAX_FILE_BYTES`：默认 `20971520`；
- `GITHUB_TOKEN`：上一步创建的 GitHub Token，类型必须是 Secret；
- `SYNC_TOKEN`：随机管理凭证，类型必须是 Secret。

Deploy to Cloudflare 会根据 `.dev.vars.example` 将这六个值都作为加密的 Worker runtime secrets 收集；`GITHUB_OWNER` 等非敏感值因此也可能在部署后显示为 Secret，这是正常的，不影响 Worker 读取。使用 Wrangler 手动部署时，可以继续把前四项放在 `vars`，只把两个 Token 设为 Secret。

可以在桌面终端生成 `SYNC_TOKEN`：

```bash
openssl rand -base64 32
```

Cloudflare Secret 保存后不可回读。请先把 `SYNC_TOKEN` 保存到密码管理器；丢失时只能轮换，并重新连接设备。

如果 Deploy 按钮不可用，按照[完整自部署指南](self-host.zh-CN.md)使用 Wrangler 部署。

部署完成后访问：

```text
https://<worker-name>.<account-subdomain>.workers.dev/health
```

返回 `service: "vaultbridge"`、`protocol: 2`、`configured: true`，并且
`readiness.coreSync.ready` 与 `readiness.devicePairing.ready` 都为 `true`，
才算完整部署完成。缺少 D1 时核心同步仍可能可用，但二维码配对不可用。

## 第四步：安装插件

VaultBridge 进入 Obsidian 社区插件市场前，可以使用 BRAT：

1. 在 Obsidian 安装并启用 BRAT；
2. 选择 **Add a beta plugin**；
3. 输入仓库根地址：

```text
https://github.com/lishoulong/obsidian-sync
```

不要输入 `/tree/main/apps/obsidian-plugin` 子目录地址。BRAT 从 GitHub Release 的 `main.js`、`manifest.json` 和 `styles.css` 安装插件。

## 第五步：连接第一台设备

在插件的 Worker 设置区域：

1. 填写 Worker URL；
2. 填写部署时保存的 `SYNC_TOKEN`；
3. 点击连接测试；
4. 核对返回的私有仓库名、分支和文件大小限制；公开仓库会被拒绝，避免误
   上传私人笔记；
5. 桌面端默认继续使用本地 Git；只有确实要让桌面通过 Worker 迁移或同步时，
   才启用 **Enable Worker sync on desktop**；
6. 移动端或已主动启用桌面 Worker 同步的设备选择首次同步模式；
7. 查看下载、上传、冲突和删除预览，确认后执行首次同步。

首次同步完成前，插件不会自动同步。首次成功后再启用 Automatic sync。

### GitHub 是初始版本

在手机中新建空 Vault，安装插件并选择这个模式。插件要求同步范围内没有本地文件，然后从 GitHub 下载全部远端笔记并建立设备基准。

### 这台设备是初始版本

选择这个模式前确保 GitHub 的目标同步目录为空。插件先展示待上传文件，再创建首次 Commit。远端已有内容时会停止，不会覆盖。

### 安全合并

双方都有内容时使用。仅本地文件上传，仅远端文件下载，相同文件跳过，同路径但内容不同的文件生成 `.remote-conflict-*` 副本并等待人工处理。

## 第六步：添加移动设备

第一台设备连接成功后，可以创建短期配对码：

1. 先在手机创建或打开目标空 Vault，通过 BRAT 安装并启用 VaultBridge Sync，
   然后保持这个 Vault 打开；
2. 在保存了管理员 `SYNC_TOKEN` 的桌面设备点击 **Add mobile device**；
3. Worker 创建短期、单次使用的配对码；
4. 用手机相机扫描二维码，或把配对链接复制到手机后打开；
5. Obsidian 调用已启用插件的 `vaultbridge-connect` 处理器，插件用配对码换取
   独立设备 Token；
6. 核对 Worker、GitHub 仓库和分支，确认后进入首次下载预览。

配对链接不包含 `GITHUB_TOKEN` 或长期 `SYNC_TOKEN`。只有保存管理员
`SYNC_TOKEN` 的设备可以创建配对码、查看完整设备列表和撤销其他设备；
配对设备只能使用自己的独立 Token 同步，并可撤销自身。
配对设备设置页显示 **Disconnect this device**；成功断开后只会撤销该设备
Token 并清除本地 Worker 连接，不会删除本地笔记。

## 恢复与轮换

### 新手机或本地 Vault 损坏

新建空 Vault，重新配对，选择“GitHub 是初始版本”。GitHub 仓库是恢复源。

### 设备丢失

在保存管理员 `SYNC_TOKEN` 的设备上，从设备列表撤销该设备 Token。无需
影响其他已经配对的设备。

### `SYNC_TOKEN` 泄露

在 Cloudflare 中替换 Secret，更新仍使用 legacy Token 的设备，并检查 GitHub Commit 历史。已经使用独立设备 Token 的设备可以继续使用，但建议重新审查设备列表。

### `GITHUB_TOKEN` 失效或泄露

在 GitHub 撤销旧 Token，创建只授权笔记仓库的新 Token，然后更新 Worker 的 `GITHUB_TOKEN` Secret。插件无需保存或更新 GitHub Token。

### Worker 被删除

GitHub 笔记仓库不会丢失。重新部署 Worker、恢复仓库和 Secret 配置，再重新配对设备即可。

## 安全原则

- 笔记仓库保持私有；
- `GITHUB_TOKEN` 只进入 Worker Secret；
- 不把长期 Token 放进二维码和 URL；
- 首次同步不静默覆盖同名不同内容；
- 首次同步和大量删除必须展示预览并由用户确认；
- 未经用户主动启用，不向 DeepSeek 或其他模型服务发送笔记内容。
