# VaultBridge Sync Protocol v1.1

## Authentication

所有 `/v1/*` 请求：

```http
Authorization: Bearer <SYNC_TOKEN>
Content-Type: application/json
```

## Push

### `POST /v1/check`

提交当前本地 Manifest，返回需要上传和删除的路径，以及 `baseCommitSha`。

### `POST /v1/blob`

把单个变化文件以 Base64 创建为 Git blob。

### `POST /v1/commit`

基于 `/v1/check` 返回的提交创建一次原子 Commit。若 branch head 已变化，返回 HTTP 409 `remote_changed`。

## Pull

### `POST /v1/pull/check`

请求：

```json
{
  "files": {
    "Daily/2026-07-10.md": {
      "size": 1234,
      "sha256": "64位小写十六进制"
    }
  },
  "base": {
    "commitSha": "上次 Pull 成功时的远端提交，可为空",
    "files": {
      "Daily/2026-07-10.md": {
        "size": 1234,
        "sha256": "上次共同版本的本地 SHA-256",
        "remoteBlobSha": "上次共同版本的 Git blob SHA"
      }
    }
  }
}
```

响应：

```json
{
  "remoteCommitSha": "当前远端 HEAD",
  "download": [
    {
      "path": "Remote.md",
      "remoteBlobSha": "...",
      "size": 100,
      "reason": "remote_added"
    }
  ],
  "deleteLocal": [
    {"path": "Deleted.md", "reason": "remote_deleted"}
  ],
  "keepLocal": [
    {"path": "Local.md", "reason": "local_modified"}
  ],
  "conflict": [
    {
      "path": "Both.md",
      "reason": "both_modified",
      "remoteBlobSha": "..."
    }
  ],
  "unchanged": []
}
```

### `POST /v1/pull/file`

请求：

```json
{
  "path": "Remote.md",
  "commitSha": "pull/check 返回的 remoteCommitSha",
  "blobSha": "download 或 conflict 中的 remoteBlobSha"
}
```

响应：

```json
{
  "path": "Remote.md",
  "commitSha": "...",
  "blobSha": "...",
  "encoding": "base64",
  "content": "SGVsbG8=",
  "size": 5,
  "sha256": "..."
}
```

Worker 会验证这个 blob 确实位于指定 Commit 的该路径，避免在 Pull 过程中远端变化后下载错版本。

## 冲突处理

建议客户端对每个 `conflict`：

1. 保留原本地文件；
2. 若远端文件仍存在，下载并保存为：

```text
原文件名.remote-conflict-YYYYMMDD-HHmm.扩展名
```

3. 不更新该路径的共同基准；
4. 不自动执行 Push。

## LocalState 更新规则

Pull 完成后：

- `download`：用 `/pull/file` 返回的 `sha256`、`size`、`blobSha` 写入状态。
- `unchanged`：写入/更新返回的 `sha256`、`size`、`remoteBlobSha`。
- `deleteLocal`：删除对应状态项。
- `keepLocal`：保留原状态；没有原状态则继续不写入。
- `conflict`：保留原状态，不推进共同基准。
- 顶层 `commitSha` 可以记录最新远端 HEAD，但文件级状态才是冲突判断依据。
