/* global Bun */

process.env.AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin";

const { startServer } = await import("../server/server.ts");
startServer();
