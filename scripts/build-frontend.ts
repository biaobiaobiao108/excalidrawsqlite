#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import * as sass from "sass";

const { getClientEnvVariables } = require("../packages/excalidraw/env.cjs");

const projectRoot = path.resolve(__dirname, "..");
const appDir = path.join(projectRoot, "excalidraw-app");
const publicDir = path.join(projectRoot, "public");
const outDir = path.join(appDir, "build");

export interface BuildOptions {
  isDev?: boolean;
}

export async function buildFrontend(options: BuildOptions = {}) {
  const isDev = Boolean(options.isDev);
  const modeLabel = isDev ? "development" : "production";
  console.log(`🚀 Starting Bun HTML Bundler (${modeLabel})...`);
  const startTime = performance.now();

  // 1. Clean and prepare build directory. Bundler does not remove stale files
  // from a previous build, which can otherwise leave deleted assets reachable.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 2. Copy static files from public/ directly to build/. The Bundler emits
  // imported font assets itself; only preserve the dynamically hosted font
  // license in the static output instead of copying the whole source tree.
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, outDir, { recursive: true });
  }
  const fontLicense = path.join(
    projectRoot,
    "packages",
    "excalidraw",
    "fonts",
    "LXGWWenKai",
    "OFL.txt",
  );
  if (fs.existsSync(fontLicense)) {
    const licenseDestination = path.join(outDir, "fonts", "LXGWWenKai");
    fs.mkdirSync(licenseDestination, { recursive: true });
    fs.copyFileSync(fontLicense, path.join(licenseDestination, "OFL.txt"));
  }

  // 3. Sass compiler plugin for .scss files
  const sassPlugin = {
    name: "bun-sass-plugin",
    setup(build: any) {
      build.onLoad({ filter: /\.scss$/ }, async (args: any) => {
        const result = sass.compile(args.path, {
          loadPaths: [
            path.dirname(args.path),
            path.join(projectRoot, "packages"),
            projectRoot,
          ],
        });
        return {
          contents: result.css,
          loader: "css",
        };
      });
    },
  };

  // 4. HTML preprocessor plugin
  const htmlPlugin = {
    name: "bun-html-plugin",
    setup(build: any) {
      build.onLoad({ filter: /\.html$/ }, async (args: any) => {
        let content = await Bun.file(args.path).text();

        // Remove EJS tags
        content = content.replace(/<%\s*if[\s\S]*?%>/g, "");
        content = content.replace(/<%\s*}[\s\S]*?%>/g, "");

        // Temporarily remove /theme-init.js from bundling to keep it as a standalone synchronous script
        content = content.replace(
          /<script src="\/theme-init\.js"><\/script>/g,
          "<!-- THEME_INIT_PLACEHOLDER -->",
        );

        // Rewrite public root references so Bun can bundle favicons
        content = content.replace(
          /href="\/apple-touch-icon\.png"/g,
          'href="../public/apple-touch-icon.png"',
        );
        content = content.replace(
          /href="\/favicon-32x32\.png"/g,
          'href="../public/favicon-32x32.png"',
        );
        content = content.replace(
          /href="\/favicon-16x16\.png"/g,
          'href="../public/favicon-16x16.png"',
        );
        content = content.replace(
          /<script src="\/dev-live-reload-guard\.js"><\/script>/g,
          "",
        );

        return {
          contents: content,
          loader: "html",
        };
      });
    },
  };

  // 5. Run Bun.build
  const gitSha =
    (process.env.BUILD_SHA || process.env.VITE_APP_GIT_SHA || "")
      .trim()
      .slice(0, 7) || "local";
  const mode = isDev ? "development" : "production";
  const clientEnv = getClientEnvVariables(projectRoot, mode, {
    VITE_APP_GIT_SHA: gitSha,
  });
  const envDefines = Object.fromEntries(
    Object.entries(clientEnv).map(([key, value]) => [
      `import.meta.env.${key}`,
      JSON.stringify(value),
    ]),
  );

  const buildResult = await Bun.build({
    entrypoints: [path.join(appDir, "index.html")],
    outdir: outDir,
    publicPath: "/",
    // Bun 1.4 accepts "browser" as its modern browser target; unlike
    // esbuild, it does not accept an "esnext" target value here.
    target: "browser",
    minify: !isDev,
    splitting: true,
    plugins: [sassPlugin, htmlPlugin],
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode),
      "process.env.VITE_APP_GIT_SHA": JSON.stringify(gitSha),
      ...envDefines,
      "import.meta.env": JSON.stringify(clientEnv),
    },
  });

  if (!buildResult.success) {
    console.error("❌ Bun build failed with errors:");
    for (const log of buildResult.logs) {
      console.error(log);
    }
    throw new Error("Bun build failed");
  }

  // 6. Post-process generated index.html
  const generatedHtmlPath = path.join(outDir, "index.html");
  if (fs.existsSync(generatedHtmlPath)) {
    let finalHtml = fs.readFileSync(generatedHtmlPath, "utf8");

    // Restore synchronous /theme-init.js script in <head>
    finalHtml = finalHtml.replace(
      "<!-- THEME_INIT_PLACEHOLDER -->",
      '<script src="/theme-init.js"></script>',
    );

    // In dev mode, inject live reload script
    if (isDev) {
      finalHtml = finalHtml.replace(
        '<script src="/theme-init.js"></script>',
        '<script src="/theme-init.js"></script>\n    <script src="/dev-live-reload.js"></script>',
      );
    }

    finalHtml = finalHtml.replace(
      "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
      "",
    );

    // Strip crossorigin attributes from same-origin bundles to avoid unnecessary CORS mode
    finalHtml = finalHtml.replace(/\scrossorigin(="[^"]*")?/g, "");

    fs.writeFileSync(generatedHtmlPath, finalHtml, "utf8");
  }

  const durationMs = (performance.now() - startTime).toFixed(0);
  console.log(`⚡ Bun build completed in ${durationMs}ms -> ${outDir}`);
}

if (import.meta.main) {
  const isDev = process.argv.includes("--dev");
  await buildFrontend({ isDev });
}
