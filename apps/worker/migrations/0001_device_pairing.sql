CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS devices_active_token_idx
  ON devices(token_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_by_device_id TEXT,
  expires_at INTEGER NOT NULL,
  consumed_nonce TEXT UNIQUE,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pairing_codes_expiry_idx
  ON pairing_codes(expires_at);

CREATE INDEX IF NOT EXISTS pairing_codes_consumed_idx
  ON pairing_codes(consumed_at)
  WHERE consumed_at IS NOT NULL;
