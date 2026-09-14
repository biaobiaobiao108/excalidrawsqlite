import path from "node:path";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { woff2ServerPlugin } from "./woff2/woff2-esbuild-plugins";

// contains all dependencies bundled inside
const getConfig = (outdir) => ({
  outdir,
  bundle: true,
  format: "esm",
  entryPoints: ["src/index.ts"],
  entryNames: "[name]",
  assetNames: "[dir]/[name]",
  alias: {
    "@excalidraw/common": path.resolve(import.meta.dir, "../packages/common/src"),
    "@excalidraw/element": path.resolve(import.meta.dir, "../packages/element/src"),
    "@excalidraw/excalidraw": path.resolve(import.meta.dir, "../packages/excalidraw"),
    "@excalidraw/math": path.resolve(import.meta.dir, "../packages/math/src"),
    "@excalidraw/fractional-indexing": path.resolve(
      import.meta.dir,
      "../packages/fractional-indexing/src",
    ),
    "@excalidraw/utils": path.resolve(import.meta.dir, "../packages/utils/src"),
  },
});

function buildDev(config) {
  return build({
    ...config,
    sourcemap: true,
    plugins: [sassPlugin(), woff2ServerPlugin()],
    define: {
      "import.meta.env": JSON.stringify({
        MODE: "development",
        NODE_ENV: "development",
        DEV: true,
        PROD: false,
      }),
    },
  });
}

function buildProd(config) {
  return build({
    ...config,
    minify: true,
    plugins: [
      sassPlugin(),
      woff2ServerPlugin({
        outdir: `${config.outdir}/assets`,
      }),
    ],
    define: {
      "import.meta.env": JSON.stringify({
        MODE: "production",
        NODE_ENV: "production",
        DEV: false,
        PROD: true,
      }),
    },
  });
}

const createESMRawBuild = async () => {
  // development unminified build with source maps
  await buildDev(getConfig("dist/dev"));

  // production minified build without sourcemaps
  await buildProd(getConfig("dist/prod"));
};

await createESMRawBuild();
