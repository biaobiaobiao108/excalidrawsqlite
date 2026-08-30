/* global Bun */

const authPassword = process.env.AUTH_PASSWORD || "admin";

const serverProcess = Bun.spawn([process.execPath, "run", "server/server.ts"], {
  env: {
    ...process.env,
    AUTH_PASSWORD: authPassword,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await serverProcess.exited);
