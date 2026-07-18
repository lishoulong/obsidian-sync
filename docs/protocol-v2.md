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

All requests except `/health` and `POST /v2/pairing/exchange` require:

```http
Authorization: Bearer <SYNC_TOKEN_OR_DEVICE_TOKEN>
Content-Type: application/json
```

`SYNC_TOKEN` remains the self-hosted administrator and legacy credential. A
paired client receives an independent random device token. Device tokens are
stored only as SHA-256 hashes in D1, can be revoked independently, and are
accepted by the same sync endpoints as `SYNC_TOKEN`.

## Health and readiness

`GET /health` is public. `coreConfigured` and `readiness.coreSync.ready`
describe the GitHub synchronization configuration. `features.devicePairing`
and `readiness.devicePairing.ready` are true only when the `DB` D1 binding is
available. `configured` is true only when both capabilities are ready.

## Device pairing

The administrator creates a short-lived, single-use code. This endpoint only
accepts the deployment's `SYNC_TOKEN`; a paired device token receives
`403 administrator_required`:

```http
POST /v2/pairing/codes
Authorization: Bearer <SYNC_TOKEN>
Content-Type: application/json

{
  "expiresInSeconds": 300
}
```

Response (`201 Created`):

```json
{
  "code": "high-entropy-one-time-code",
  "expiresAt": "2026-07-13T06:00:00.000Z"
}
```

The new client exchanges the code without an Authorization header:

```http
POST /v2/pairing/exchange
Content-Type: application/json

{
  "code": "high-entropy-one-time-code",
  "deviceName": "Alice iPhone"
}
```

The exchange request body is limited to 4 KiB.

Response (`201 Created`) contains the device token exactly once:

```json
{
  "token": "device-token",
  "device": {
    "id": "device-uuid",
    "name": "Alice iPhone",
    "createdAt": "2026-07-13T05:55:00.000Z"
  }
}
```

Codes expire after 5 minutes by default, accept at most 10 minutes, and cannot
be replayed. The setup link may contain the Worker endpoint and pairing code,
but must never contain `SYNC_TOKEN` or `GITHUB_TOKEN`.

Device management endpoints:

- `GET /v2/devices` lists paired devices and revocation state without token
  hashes. It requires the administrator `SYNC_TOKEN`.
- `DELETE /v2/devices/:id` revokes one active device and returns `204`. The
  administrator may revoke any device; a device token may only revoke its own
  device ID.

## Setup check

Self-hosted deployments can verify Worker configuration and GitHub access with:

```http
GET /v2/setup/check
```

The response includes the bound GitHub repository, branch, current branch head,
manifest path, and file-size limit. This endpoint accepts either the legacy
`SYNC_TOKEN` or an active device token.

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
