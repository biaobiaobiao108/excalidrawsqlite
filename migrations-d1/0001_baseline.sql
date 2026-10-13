PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  elements TEXT NOT NULL,
  app_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  tags_json TEXT NOT NULL DEFAULT '[]',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  folder_id TEXT,
  last_opened_at INTEGER,
  thumbnail_file_id TEXT,
  deleted_at INTEGER,
  element_count INTEGER NOT NULL DEFAULT 0,
  content_bytes INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'folder',
  color TEXT NOT NULL DEFAULT '#315f4c',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  storage_path TEXT,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scene_files (
  scene_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (scene_id, file_id),
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (action, key)
);

CREATE INDEX IF NOT EXISTS idx_scenes_updated_at ON scenes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenes_last_opened_at ON scenes(last_opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenes_deleted_at ON scenes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_scenes_folder_id ON scenes(folder_id);
CREATE INDEX IF NOT EXISTS idx_scenes_active_updated_at ON scenes(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_active_updated_id ON scenes(updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_trash_deleted_at ON scenes(deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_trash_deleted_id ON scenes(deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_active_folder_id ON scenes(folder_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_active_folder_updated_id ON scenes(folder_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_thumbnail_file_id ON scenes(thumbnail_file_id);
CREATE INDEX IF NOT EXISTS idx_scene_files_file_id ON scene_files(file_id);
CREATE INDEX IF NOT EXISTS idx_files_updated_at ON files(updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at ON rate_limits(updated_at);
