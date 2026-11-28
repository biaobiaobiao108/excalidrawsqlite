import { Database } from "bun:sqlite";

type SnapshotRequest = {
  dbPath: string;
  destination: string;
  maxBytes: number;
};

type SnapshotResponse =
  | { ok: true }
  | {
      ok: false;
      code: "BACKUP_TOO_LARGE" | "BACKUP_SNAPSHOT_FAILED";
      message: string;
    };

const createSnapshot = ({
  dbPath,
  destination,
  maxBytes,
}: SnapshotRequest): SnapshotResponse => {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 10000;");
    const pageSize = Number(
      (db.query("PRAGMA page_size").get() as { page_size: number }).page_size,
    );
    const content = db
      .query(
        `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
      SELECT length(CAST(id AS BLOB)) + length(CAST(name AS BLOB)) +
             content_bytes + length(CAST(app_state AS BLOB)) +
             length(CAST(tags_json AS BLOB)) AS bytes FROM scenes
      UNION ALL SELECT length(CAST(id AS BLOB)) + length(CAST(name AS BLOB)) +
             length(CAST(icon AS BLOB)) + length(CAST(color AS BLOB)) FROM folders
      UNION ALL SELECT length(CAST(id AS BLOB)) + COALESCE(length(CAST(storage_path AS BLOB)), 0) +
             length(CAST(mime_type AS BLOB)) + length(CAST(sha256 AS BLOB)) FROM files
      UNION ALL SELECT length(CAST(scene_id AS BLOB)) + length(CAST(file_id AS BLOB)) FROM scene_files
      UNION ALL SELECT length(CAST(token AS BLOB)) FROM sessions
      UNION ALL SELECT length(CAST(key_sha256 AS BLOB)) + length(CAST(payload_sha256 AS BLOB)) +
             length(CAST(scene_id AS BLOB)) FROM scene_create_requests
    )`,
      )
      .get() as { bytes: number };
    if (maxBytes < pageSize || Number(content.bytes) > maxBytes) {
      return {
        ok: false,
        code: "BACKUP_TOO_LARGE",
        message: "备份内容超过大小限制",
      };
    }
    db.run(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: "BACKUP_SNAPSHOT_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
};

self.onmessage = (event: MessageEvent<SnapshotRequest>) => {
  self.postMessage(createSnapshot(event.data));
};
