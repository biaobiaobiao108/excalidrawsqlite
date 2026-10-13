CREATE TABLE IF NOT EXISTS scene_create_requests (
  key_sha256 TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scene_create_requests_expiry
  ON scene_create_requests(expires_at);
