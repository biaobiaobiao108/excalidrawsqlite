const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const assetsDir = join(
  import.meta.dir,
  "..",
  "excalidraw-app",
  "build",
  "assets",
);
const entryBudget = 2_150_000;
const chunkBudgets = {
  "firebase.chunk": 600_000,
  "mermaid-to-excalidraw": 700_000,
  "codemirror.chunk": 600_000,
  "subset-shared.chunk": 2_000_000,
};

if (!statSync(assetsDir, { throwIfNoEntry: false })) {
  process.stderr.write(`Build assets directory not found: ${assetsDir}\n`);
  process.exit(1);
}

const assets = readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => ({ name, bytes: statSync(join(assetsDir, name)).size }))
  .sort((a, b) => b.bytes - a.bytes);

const formatBytes = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const violations = [];

for (const asset of assets) {
  const budget = Object.entries(chunkBudgets).find(([prefix]) =>
    asset.name.startsWith(`${prefix}-`),
  )?.[1];
  const isEntry = /^index-[^/]+\.js$/.test(asset.name);
  const effectiveBudget = isEntry ? entryBudget : budget;

  process.stdout.write(
    `${asset.name}: ${formatBytes(asset.bytes)}${
      effectiveBudget ? ` / ${formatBytes(effectiveBudget)}` : ""
    }\n`,
  );

  if (effectiveBudget && asset.bytes > effectiveBudget) {
    violations.push(
      `${asset.name} exceeds ${formatBytes(effectiveBudget)} budget`,
    );
  }
}

if (violations.length) {
  process.stderr.write("\nBundle size budget exceeded:\n");
  for (const violation of violations) {
    process.stderr.write(`- ${violation}\n`);
  }
  process.exit(1);
}
