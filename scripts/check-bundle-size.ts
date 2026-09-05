#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(__dirname, "..");
const defaultBuildDirectory = path.join(
  projectRoot,
  "excalidraw-app",
  "build",
);

export const BUNDLE_SIZE_LIMITS = {
  js: 512 * 1024,
  css: 220 * 1024,
} as const;

type AssetKind = keyof typeof BUNDLE_SIZE_LIMITS;

type BundleAsset = {
  kind: AssetKind;
  path: string;
  relativePath: string;
  bytes: number;
};

const getAssetKind = (fileName: string): AssetKind | null => {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".js") {
    return "js";
  }
  if (extension === ".css") {
    return "css";
  }
  return null;
};

const collectBundleAssets = (
  directory: string,
  rootDirectory = directory,
): BundleAsset[] => {
  const assets: BundleAsset[] = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      assets.push(...collectBundleAssets(entryPath, rootDirectory));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const kind = getAssetKind(entry.name);
    if (!kind) {
      continue;
    }

    assets.push({
      kind,
      path: entryPath,
      relativePath: path
        .relative(rootDirectory, entryPath)
        .split(path.sep)
        .join("/"),
      bytes: fs.statSync(entryPath).size,
    });
  }

  return assets;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

const printSummary = (assets: BundleAsset[]) => {
  for (const kind of Object.keys(BUNDLE_SIZE_LIMITS) as AssetKind[]) {
    const kindAssets = assets.filter((asset) => asset.kind === kind);
    const largest = [...kindAssets].sort((a, b) => b.bytes - a.bytes)[0];
    const totalBytes = kindAssets.reduce((total, asset) => total + asset.bytes, 0);

    if (!largest) {
      console.log(`${kind.toUpperCase()}: no files found`);
      continue;
    }

    console.log(
      `${kind.toUpperCase()}: ${kindAssets.length} files, ` +
        `${formatBytes(totalBytes)} total, largest ${formatBytes(largest.bytes)} ` +
        `(${largest.relativePath}), limit ${formatBytes(BUNDLE_SIZE_LIMITS[kind])}`,
    );
  }
};

export const checkBundleSize = (
  buildDirectory = defaultBuildDirectory,
): boolean => {
  if (!fs.existsSync(buildDirectory)) {
    console.error(
      `❌ Bundle size check failed: build directory not found: ${buildDirectory}`,
    );
    return false;
  }

  const assets = collectBundleAssets(buildDirectory).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );

  if (assets.length === 0) {
    console.error(
      `❌ Bundle size check failed: no JavaScript or CSS files found in ${buildDirectory}`,
    );
    return false;
  }

  console.log("📦 Checking production bundle sizes (uncompressed bytes)...");
  printSummary(assets);

  const violations = assets.filter(
    (asset) => asset.bytes > BUNDLE_SIZE_LIMITS[asset.kind],
  );

  if (violations.length > 0) {
    console.error("❌ Bundle size check failed:");
    for (const asset of violations) {
      console.error(
        `  ${asset.relativePath}: ${formatBytes(asset.bytes)} > ` +
          `${formatBytes(BUNDLE_SIZE_LIMITS[asset.kind])}`,
      );
    }
    return false;
  }

  console.log("✅ Bundle size check passed.");
  return true;
};

if (import.meta.main) {
  if (!checkBundleSize()) {
    process.exitCode = 1;
  }
}
