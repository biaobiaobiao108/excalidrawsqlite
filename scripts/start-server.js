/* global Bun */

process.env.NODE_ENV = process.env.NODE_ENV || "production";

const { startServer } = await import("../server/server.ts");
await startServer();
