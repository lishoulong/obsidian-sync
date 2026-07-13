# VaultBridge Sync Protocol v2

Protocol v2 replaces the large per-device file snapshot with a compact device state.

## Device state

Store this outside the Obsidian vault, locally on each device:

```json
{
  "version": 2,
  "deviceId": "fred-iphone",
  "lastSyncedCommitSha": "0123456789abcdef0123456789abcdef01234567"
}
```

The Worker reconstructs the common base from the historical Git commit. The device no longer stores every file hash in `device-state.json`.

## Authentication

All requests except `/health` require:

```http
Authorization: Bearer <SYNC_TOKEN>
Content-Type: application/json
```

## Setup check

Self-hosted deployments can verify Worker configuration and GitHub access with:

```http
GET /v2/setup/check
```

The response includes the bound GitHub repository, branch, current branch head,
manifest path, and file-size limit. This endpoint is authenticated with the same
`SYNC_TOKEN` as sync requests.

## 1. Create a synchronization plan

```http
POST /v2/sync/check
```

Request:

```json
{
  "deviceId": "fred-iphone",
  "lastSyncedCommitSha": "0123456789abcdef0123456789abcdef01234567",
  "files": {
    "Daily/2026-07-10.md": {
      "size": 1234,
      "sha256": "64-character-lowercase-sha256"
    }
  }
}
```

For the first run, send `null` as `lastSyncedCommitSha`.

Response includes:

- `download`: download from GitHub and replace/create locally.
- `deleteLocal`: delete locally because the remote side deleted an unchanged file.
- `upload`: upload local content to GitHub.
- `deleteRemote`: delete from GitHub because the local side deleted an unchanged file.
- `conflict`: both sides changed since the common base. Do not overwrite either copy.
- `sessionToken`: signed, short-lived token used by pull and commit operations.
- `remoteCommitSha`: the GitHub snapshot used by this plan.
- `nextDeviceState`: returned only when no local push remains and no conflicts exist.

## 2. Download one file

```http
POST /v2/pull/file
```

```json
{
  "sessionToken": "signed-session",
  "path": "Daily/2026-07-10.md",
  "blobSha": "40-character-git-blob-sha"
}
```

The response contains Base64 file content. If GitHub changed after the plan was generated, the Worker returns `409 sync_session_stale`.

## 3. Upload one changed file as a Git blob

```http
POST /v2/blob
```

```json
{
  "path": "Daily/2026-07-10.md",
  "encoding": "base64",
  "content": "..."
}
```

Response:

```json
{
  "path": "Daily/2026-07-10.md",
  "sha": "40-character-git-blob-sha"
}
```

## 4. Commit local patch

```http
POST /v2/commit
```

```json
{
  "deviceId": "fred-iphone",
  "sessionToken": "signed-session",
  "message": "iPhone sync 2026-07-10 15:00",
  "patch": {
    "upload": {
      "Daily/2026-07-10.md": {
        "size": 1234,
        "sha256": "64-character-lowercase-sha256"
      }
    },
    "delete": [
      "Old/deleted-note.md"
    ]
  },
  "blobs": [
    {
      "path": "Daily/2026-07-10.md",
      "sha": "40-character-git-blob-sha"
    }
  ]
}
```

The Worker reads the manifest at the signed session's `remoteCommitSha`, applies
`patch.upload` and `patch.delete`, writes the new repository-level manifest, and
creates the Git commit. Clients therefore do not need to upload the complete
manifest during commit. For backward compatibility, the Worker may still accept
legacy requests with a complete `files` manifest.

The response contains the new compact device state:

```json
{
  "ok": true,
  "commitSha": "...",
  "deviceState": {
    "version": 2,
    "deviceId": "fred-iphone",
    "lastSyncedCommitSha": "..."
  }
}
```

## Conflict policy

Protocol v2 never silently resolves a true conflict. The Obsidian plugin should:

1. Keep the local file unchanged.
2. Download the remote copy using `/v2/pull/file`.
3. Save it beside the local file with a suffix such as `.remote-conflict-20260710-1500.md`.
4. Stop before Push.

## Repository state

The Worker writes `.vaultbridge/manifest.json` into each successful commit. It is repository-level state and is shared by all devices. `.vaultbridge/` is reserved and cannot be uploaded by clients.
