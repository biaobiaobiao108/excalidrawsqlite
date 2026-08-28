const { gzipSync } = require("node:zlib");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const assetsDir = join(
  import.meta.dir,
  "..",
  "excalidraw-app",
  "build",
  "assets",
);
const entryBudget = { raw: 1_700_000, gzip: 550_000 };
const chunkBudgets = {
  "firebase.chunk": { raw: 600_000, gzip: 180_000 },
  "mermaid-to-excalidraw": { raw: 700_000, gzip: 200_000 },
  "codemirror.chunk": { raw: 600_000, gzip: 110_000 },
  "pako.esm": { raw: 70_000, gzip: 25_000 },
  "subset-shared.chunk": { raw: 2_000_000, gzip: 800_000 },
  "xiaolai-fonts": { raw: 140_000, gzip: 55_000 },
};

if (!statSync(assetsDir, { throwIfNoEntry: false })) {
  process.stderr.write(`Build assets directory not found: ${assetsDir}\n`);
  process.exit(1);
}

const assets = readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => {
    const bytes = statSync(join(assetsDir, name)).size;
    return {
      name,
      bytes,
      gzipBytes: gzipSync(readFileSync(join(assetsDir, name))).length,
    };
  })
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
    `${asset.name}: ${formatBytes(asset.bytes)} raw, ${formatBytes(
      asset.gzipBytes,
    )} gzip${
      effectiveBudget
        ? ` / ${formatBytes(effectiveBudget.raw)} raw, ${formatBytes(
            effectiveBudget.gzip,
          )} gzip`
        : ""
    }\n`,
  );

  if (effectiveBudget) {
    if (asset.bytes > effectiveBudget.raw) {
      violations.push(
        `${asset.name} exceeds ${formatBytes(effectiveBudget.raw)} raw budget`,
      );
    }
    if (asset.gzipBytes > effectiveBudget.gzip) {
      violations.push(
        `${asset.name} exceeds ${formatBytes(effectiveBudget.gzip)} gzip budget`,
      );
    }
  }
}

if (violations.length) {
  process.stderr.write("\nBundle size budget exceeded:\n");
  for (const violation of violations) {
    process.stderr.write(`- ${violation}\n`);
  }
  process.exit(1);
}
