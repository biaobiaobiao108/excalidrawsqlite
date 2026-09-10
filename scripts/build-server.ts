import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const outputDirectory = path.join(projectRoot, "server-build");
const outputFile = path.join(outputDirectory, "server.js");

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(projectRoot, "server", "server.ts")],
  outdir: outputDirectory,
  target: "bun",
  format: "esm",
  minify: false,
  sourcemap: "none",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  console.error("❌ Server build failed with errors:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`⚡ Bun server build completed -> ${outputFile}`);
