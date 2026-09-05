import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build, type BuildOptions } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";

import { parseEnvVariables } from "../packages/excalidraw/env";

// Resolve a relative path from the source file's directory
const resolveRelativePath = (
  importPath: string,
  sourceFile: string,
): string | null => {
  const sourceDir = path.dirname(sourceFile);
  const extensions = [".scss", ".css", ""];

  for (const ext of extensions) {
    const fullPath = path.resolve(sourceDir, importPath + ext);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
    // Try with underscore prefix for partials
    const partialPath = path.join(
      path.dirname(fullPath),
      `_${path.basename(fullPath)}`,
    );
    if (fs.existsSync(partialPath)) {
      return partialPath;
    }
  }
  return null;
};

// Precompile function to convert relative paths to absolute paths
const precompile = (source: string, sourcePath: string): string => {
  // Match @use and @forward statements with relative paths
  const importRegex = /(@use|@forward)\s+["'](\.[^"']+)["']/g;

  return source.replace(importRegex, (match, directive, importPath) => {
    const resolvedPath = resolveRelativePath(importPath, sourcePath);
    if (resolvedPath) {
      // Convert to file:// URL format for sass
      const fileUrl = pathToFileURL(resolvedPath).href;
      return `${directive} "${fileUrl}"`;
    }
    return match;
  });
};

// excludes all external dependencies and bundles only the source code
const getConfig = (outdir: string): BuildOptions => ({
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  packages: "external",
  plugins: [
    sassPlugin({
      precompile,
    }),
  ],
  target: "es2020",
  assetNames: "[dir]/[name]",
  chunkNames: "[dir]/[name]-[hash]",
  alias: {
    "@excalidraw/utils": path.resolve(__dirname, "../packages/utils/src"),
  },
  external: [
    "@excalidraw/common",
    "@excalidraw/element",
    "@excalidraw/math",
    "@excalidraw/fractional-indexing",
  ],
  loader: {
    ".woff2": "file",
  },
});

function buildDev(config: BuildOptions, envVars: Record<string, any>) {
  return build({
    ...config,
    sourcemap: true,
    define: {
      "import.meta.env": JSON.stringify(envVars),
    },
  });
}

function buildProd(config: BuildOptions, envVars: Record<string, any>) {
  return build({
    ...config,
    minify: true,
    define: {
      "import.meta.env": JSON.stringify(envVars),
    },
  });
}

const createESMRawBuild = async () => {
  const envVars = {
    development: {
      ...(await parseEnvVariables(`${__dirname}/../.env.development`)),
      MODE: "development",
      NODE_ENV: "development",
      DEV: true,
      PROD: false,
    },
    production: {
      ...(await parseEnvVariables(`${__dirname}/../.env.production`)),
      MODE: "production",
      NODE_ENV: "production",
      DEV: false,
      PROD: true,
    },
  };

  const chunksConfig: BuildOptions = {
    entryPoints: ["index.tsx", "**/*.chunk.ts"],
    entryNames: "[name]",
  };

  // development unminified build with source maps
  await buildDev(
    {
      ...getConfig("dist/dev"),
      ...chunksConfig,
    },
    envVars.development,
  );

  // production minified buld without sourcemaps
  await buildProd(
    {
      ...getConfig("dist/prod"),
      ...chunksConfig,
    },
    envVars.production,
  );
};

await createESMRawBuild();

