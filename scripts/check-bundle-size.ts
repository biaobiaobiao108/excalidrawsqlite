#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const projectRoot = path.resolve(__dirname, "..");
const defaultBuildDirectory = path.join(
  projectRoot,
  "excalidraw-app",
  "build",
);

// Initial assets are budgeted as an aggregate because browsers download them
// together. Lazy assets are budgeted per file because they load on demand.
export const BUNDLE_SIZE_BUDGETS = {
  initial: {
    js: { gzip: 512 * 1024, brotli: 512 * 1024 },
    css: { gzip: 220 * 1024, brotli: 220 * 1024 },
  },
  lazy: {
    js: { gzip: 1024 * 1024, brotli: 1024 * 1024 },
    css: { gzip: 220 * 1024, brotli: 220 * 1024 },
  },
} as const;

type LoadingMode = keyof typeof BUNDLE_SIZE_BUDGETS;
type AssetKind = keyof (typeof BUNDLE_SIZE_BUDGETS)[LoadingMode];
type CompressionKind = keyof (typeof BUNDLE_SIZE_BUDGETS)["initial"]["js"];

type BundleAsset = {
  kind: AssetKind;
  loadingMode: LoadingMode;
  relativePath: string;
  rawBytes: number;
  compressedBytes: Record<CompressionKind, number>;
};

type AssetSummary = {
  assets: BundleAsset[];
  rawBytes: number;
  compressedBytes: Record<CompressionKind, number>;
  largest?: BundleAsset;
};

const normalizeRelativePath = (value: string) =>
  path.posix.normalize(value).replace(/^\.\//, "");

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

const getInitialAssetPaths = (buildDirectory: string) => {
  const indexPath = path.join(buildDirectory, "index.html");
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  const html = fs.readFileSync(indexPath, "utf8");
  const initialAssetPaths = new Set<string>();
  const assetReferencePattern = /(?:src|href)="\/([^"]+\.(?:js|css))"/gi;

  for (const match of html.matchAll(assetReferencePattern)) {
    initialAssetPaths.add(normalizeRelativePath(match[1]));
  }

  return initialAssetPaths;
};

const collectBundleAssets = (
  directory: string,
  initialAssetPaths: Set<string>,
  rootDirectory = directory,
): BundleAsset[] => {
  const assets: BundleAsset[] = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      assets.push(
        ...collectBundleAssets(entryPath, initialAssetPaths, rootDirectory),
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const kind = getAssetKind(entry.name);
    if (!kind) {
      continue;
    }

    const relativePath = normalizeRelativePath(
      path.relative(rootDirectory, entryPath).split(path.sep).join("/"),
    );
    const contents = fs.readFileSync(entryPath);

    assets.push({
      kind,
      loadingMode: initialAssetPaths.has(relativePath) ? "initial" : "lazy",
      relativePath,
      rawBytes: contents.byteLength,
      compressedBytes: {
        gzip: gzipSync(contents).byteLength,
        // Quality 5 keeps this check fast and represents a practical server
        // compression setting while remaining stable across environments.
        brotli: brotliCompressSync(contents, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
          },
        }).byteLength,
      },
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

const summarizeAssets = (assets: BundleAsset[]): AssetSummary => {
  const compressedBytes = {
    gzip: 0,
    brotli: 0,
  };

  for (const asset of assets) {
    compressedBytes.gzip += asset.compressedBytes.gzip;
    compressedBytes.brotli += asset.compressedBytes.brotli;
  }

  return {
    assets,
    rawBytes: assets.reduce((total, asset) => total + asset.rawBytes, 0),
    compressedBytes,
    largest: [...assets].sort(
      (a, b) => b.compressedBytes.gzip - a.compressedBytes.gzip,
    )[0],
  };
};

const getSummary = (
  assets: BundleAsset[],
  loadingMode: LoadingMode,
  kind: AssetKind,
) =>
  summarizeAssets(
    assets.filter(
      (asset) =>
        asset.loadingMode === loadingMode && asset.kind === kind,
    ),
  );

const printSummary = (assets: BundleAsset[]) => {
  for (const loadingMode of Object.keys(
    BUNDLE_SIZE_BUDGETS,
  ) as LoadingMode[]) {
    for (const kind of ["js", "css"] as AssetKind[]) {
      const summary = getSummary(assets, loadingMode, kind);
      if (!summary.largest) {
        console.log(
          `${loadingMode.toUpperCase()} ${kind.toUpperCase()}: no files found`,
        );
        continue;
      }

      const budget = BUNDLE_SIZE_BUDGETS[loadingMode][kind];
      const isInitial = loadingMode === "initial";
      const measuredLabel = isInitial
        ? "total"
        : `largest ${summary.largest.relativePath}`;
      const measuredGzip = isInitial
        ? summary.compressedBytes.gzip
        : summary.largest.compressedBytes.gzip;
      const measuredBrotli = isInitial
        ? summary.compressedBytes.brotli
        : summary.largest.compressedBytes.brotli;

      console.log(
        `${loadingMode.toUpperCase()} ${kind.toUpperCase()}: ` +
          `${summary.assets.length} files, ${formatBytes(summary.rawBytes)} raw, ` +
          `${measuredLabel}; gzip ${formatBytes(measuredGzip)}, ` +
          `Brotli ${formatBytes(measuredBrotli)}, ` +
          `limit gzip/Brotli ${formatBytes(budget.gzip)}`,
      );
    }
  }
};

const getViolations = (assets: BundleAsset[]) => {
  const violations: string[] = [];

  for (const loadingMode of Object.keys(
    BUNDLE_SIZE_BUDGETS,
  ) as LoadingMode[]) {
    for (const kind of ["js", "css"] as AssetKind[]) {
      const summary = getSummary(assets, loadingMode, kind);
      if (!summary.largest) {
        continue;
      }

      const budget = BUNDLE_SIZE_BUDGETS[loadingMode][kind];
      if (loadingMode === "initial") {
        const gzipBytes = summary.compressedBytes.gzip;
        const brotliBytes = summary.compressedBytes.brotli;
        if (gzipBytes > budget.gzip || brotliBytes > budget.brotli) {
          violations.push(
            `  ${loadingMode} ${kind} total: gzip ${formatBytes(gzipBytes)}, ` +
              `Brotli ${formatBytes(brotliBytes)} ` +
              `(limit ${formatBytes(budget.gzip)} for each)`,
          );
        }
        continue;
      }

      for (const asset of summary.assets) {
        const gzipBytes = asset.compressedBytes.gzip;
        const brotliBytes = asset.compressedBytes.brotli;
        if (gzipBytes > budget.gzip || brotliBytes > budget.brotli) {
          violations.push(
            `  ${asset.relativePath}: gzip ${formatBytes(gzipBytes)}, ` +
              `Brotli ${formatBytes(brotliBytes)} ` +
              `(limit ${formatBytes(budget.gzip)} for each)`,
          );
        }
      }
    }
  }

  return violations;
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

  const initialAssetPaths = getInitialAssetPaths(buildDirectory);
  if (!initialAssetPaths) {
    console.error(
      `❌ Bundle size check failed: index.html not found in ${buildDirectory}`,
    );
    return false;
  }

  const assets = collectBundleAssets(buildDirectory, initialAssetPaths).sort(
    (a, b) => a.relativePath.localeCompare(b.relativePath),
  );

  if (assets.length === 0) {
    console.error(
      `❌ Bundle size check failed: no JavaScript or CSS files found in ${buildDirectory}`,
    );
    return false;
  }

  console.log(
    "📦 Checking production bundle sizes (gzip/Brotli, raw size is informational)...",
  );
  printSummary(assets);

  const violations = getViolations(assets);
  if (violations.length > 0) {
    console.error("❌ Bundle size check failed:");
    for (const violation of violations) {
      console.error(violation);
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
