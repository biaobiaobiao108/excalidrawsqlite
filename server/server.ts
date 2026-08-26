import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";

const PORT = Number(process.env.PORT) || 8080;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || "./data";
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "excalidraw.db");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize SQLite database
const db = new Database(DB_PATH, { create: true });

// Enable WAL mode for high performance
db.run("PRAGMA journal_mode = WAL;");

// Create tables
db.run(`
  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    elements TEXT NOT NULL,
    app_state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    data_url TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

console.log(`[Database] SQLite initialized at: ${DB_PATH}`);

// Helper: check auth
function isAuthorized(req: Request): boolean {
  if (!AUTH_PASSWORD) {
    return true;
  }
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const customHeader = req.headers.get("x-auth-password") || "";
  return token === AUTH_PASSWORD || customHeader === AUTH_PASSWORD;
}

// Static files directory paths to check
const staticCandidates = [
  path.resolve("./excalidraw-app/build"),
  path.resolve("./excalidraw-app/dist"),
  path.resolve("./dist"),
  path.resolve("./build"),
];

function getStaticDir(): string {
  for (const candidate of staticCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.resolve("./excalidraw-app/build");
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // CORS headers for local dev flexibility
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-auth-password",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    // --- API ROUTES ---

    // 1. Auth check / status
    if (pathname === "/api/auth/status" && req.method === "GET") {
      return Response.json(
        {
          authRequired: Boolean(AUTH_PASSWORD),
        },
        { headers: corsHeaders },
      );
    }

    // 2. Auth verify
    if (pathname === "/api/auth/verify" && req.method === "POST") {
      try {
        const body = (await req.json()) as { password?: string };
        if (!AUTH_PASSWORD || body.password === AUTH_PASSWORD) {
          return Response.json(
            { success: true, token: AUTH_PASSWORD },
            { headers: corsHeaders },
          );
        }
        return Response.json(
          { error: "密码错误，请重新输入" },
          { status: 401, headers: corsHeaders },
        );
      } catch (err: any) {
        return Response.json(
          { error: "无效的请求格式" },
          { status: 400, headers: corsHeaders },
        );
      }
    }

    // Guard all remaining /api routes with auth
    if (pathname.startsWith("/api/")) {
      if (!isAuthorized(req)) {
        return Response.json(
          { error: "Unauthorized. Password required." },
          { status: 401, headers: corsHeaders },
        );
      }
    }

    // 3. Whiteboard (Scenes) List
    if (pathname === "/api/scenes" && req.method === "GET") {
      const rows = db
        .query(
          "SELECT id, name, created_at, updated_at, length(elements) as size FROM scenes ORDER BY updated_at DESC",
        )
        .all() as any[];
      return Response.json(rows, { headers: corsHeaders });
    }

    // 4. Create new Whiteboard
    if (pathname === "/api/scenes" && req.method === "POST") {
      try {
        const body = (await req.json()) as any;
        const now = Date.now();
        const id =
          body.id ||
          `scene_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const name = body.name || "未命名白板";
        const elements = JSON.stringify(body.elements || []);
        const appState = JSON.stringify(body.appState || {});

        db.run(
          `INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             elements = excluded.elements,
             app_state = excluded.app_state,
             updated_at = excluded.updated_at`,
          [id, name, elements, appState, now, now],
        );

        return Response.json(
          { id, name, created_at: now, updated_at: now },
          { headers: corsHeaders },
        );
      } catch (err: any) {
        return Response.json(
          { error: err.message },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // 5. Get Whiteboard by ID
    if (pathname.startsWith("/api/scenes/") && req.method === "GET") {
      const id = pathname.replace("/api/scenes/", "").trim();
      const row = db
        .query("SELECT * FROM scenes WHERE id = ?")
        .get(id) as any;

      if (!row) {
        return Response.json(
          { error: "Scene not found" },
          { status: 404, headers: corsHeaders },
        );
      }

      return Response.json(
        {
          id: row.id,
          name: row.name,
          elements: JSON.parse(row.elements || "[]"),
          appState: JSON.parse(row.app_state || "{}"),
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
        { headers: corsHeaders },
      );
    }

    // 6. Update / Auto-save Whiteboard by ID
    if (pathname.startsWith("/api/scenes/") && req.method === "PUT") {
      const id = pathname.replace("/api/scenes/", "").trim();
      try {
        const body = (await req.json()) as any;
        const now = Date.now();
        const existing = db
          .query("SELECT id, created_at FROM scenes WHERE id = ?")
          .get(id) as any;

        const name = body.name || (existing ? existing.name : "未命名白板");
        const elements = JSON.stringify(body.elements || []);
        const appState = JSON.stringify(body.appState || {});
        const createdAt = existing ? existing.created_at : now;

        db.run(
          `INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = COALESCE(?, name),
             elements = excluded.elements,
             app_state = excluded.app_state,
             updated_at = excluded.updated_at`,
          [id, name, elements, appState, createdAt, now, body.name || null],
        );

        return Response.json(
          { success: true, id, updated_at: now },
          { headers: corsHeaders },
        );
      } catch (err: any) {
        return Response.json(
          { error: err.message },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // 7. Delete Whiteboard by ID
    if (pathname.startsWith("/api/scenes/") && req.method === "DELETE") {
      const id = pathname.replace("/api/scenes/", "").trim();
      db.run("DELETE FROM scenes WHERE id = ?", [id]);
      return Response.json({ success: true, id }, { headers: corsHeaders });
    }

    // 8. Files / Attachments
    if (pathname === "/api/files" && req.method === "POST") {
      try {
        const body = (await req.json()) as any;
        const now = Date.now();

        // Handle single file or map of files
        if (body.id && body.dataURL) {
          db.run(
            `INSERT OR REPLACE INTO files (id, data_url, mime_type, created_at) VALUES (?, ?, ?, ?)`,
            [body.id, body.dataURL, body.mimeType || "image/png", now],
          );
        } else if (typeof body === "object") {
          for (const [fileId, fileData] of Object.entries(body) as any[]) {
            if (fileData?.dataURL) {
              db.run(
                `INSERT OR REPLACE INTO files (id, data_url, mime_type, created_at) VALUES (?, ?, ?, ?)`,
                [
                  fileId,
                  fileData.dataURL,
                  fileData.mimeType || "image/png",
                  now,
                ],
              );
            }
          }
        }

        return Response.json({ success: true }, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json(
          { error: err.message },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    if (pathname.startsWith("/api/files/") && req.method === "GET") {
      const fileId = pathname.replace("/api/files/", "").trim();
      const row = db
        .query("SELECT * FROM files WHERE id = ?")
        .get(fileId) as any;

      if (!row) {
        return Response.json(
          { error: "File not found" },
          { status: 404, headers: corsHeaders },
        );
      }

      return Response.json(
        {
          id: row.id,
          dataURL: row.data_url,
          mimeType: row.mime_type,
          created_at: row.created_at,
        },
        { headers: corsHeaders },
      );
    }

    // --- STATIC FILES HOSTING & SPA FALLBACK ---
    const staticDir = getStaticDir();
    let sanitizedPath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
    if (sanitizedPath === "/" || sanitizedPath === "\\") {
      sanitizedPath = "/index.html";
    }

    let filePath = path.join(staticDir, sanitizedPath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return new Response(Bun.file(filePath));
    }

    // SPA fallback
    const indexPath = path.join(staticDir, "index.html");
    if (fs.existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response(
      "Excalidraw Bun Server is running. Please build the frontend first (bun run build).",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
});

console.log(`🚀 Excalidraw server is running at http://localhost:${PORT}`);
