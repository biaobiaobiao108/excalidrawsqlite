#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import * as sass from "sass";

const projectRoot = path.resolve(__dirname, "..");
const appDir = path.join(projectRoot, "excalidraw-app");
const publicDir = path.join(projectRoot, "public");
const outDir = path.join(appDir, "build");

console.log("🚀 Starting Bun HTML Bundler build...");
console.time("⚡ Build completed in");

// 1. Clean and prepare build directory
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

// 2. Copy all static files from public/ directly to build/
if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, outDir, { recursive: true });
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
      content = content.replace(/<script src="\/theme-init\.js"><\/script>/g, "<!-- THEME_INIT_PLACEHOLDER -->");

      // Rewrite public root references so Bun can bundle favicons
      content = content.replace(/href="\/apple-touch-icon\.png"/g, 'href="../public/apple-touch-icon.png"');
      content = content.replace(/href="\/favicon-32x32\.png"/g, 'href="../public/favicon-32x32.png"');
      content = content.replace(/href="\/favicon-16x16\.png"/g, 'href="../public/favicon-16x16.png"');
      content = content.replace(/<script src="\/dev-live-reload-guard\.js"><\/script>/g, "");

      return {
        contents: content,
        loader: "html",
      };
    });
  },
};

// 5. Run Bun.build
const gitSha = (process.env.BUILD_SHA || process.env.VITE_APP_GIT_SHA || "").trim().slice(0, 7) || "local";

const buildResult = await Bun.build({
  entrypoints: [path.join(appDir, "index.html")],
  outdir: outDir,
  target: "browser",
  minify: true,
  splitting: true,
  plugins: [sassPlugin, htmlPlugin],
  define: {
    "import.meta.env.PROD": "true",
    "import.meta.env.DEV": "false",
    "import.meta.env.VITE_APP_GIT_SHA": JSON.stringify(gitSha),
    "process.env.VITE_APP_GIT_SHA": JSON.stringify(gitSha),
  },
});

if (!buildResult.success) {
  console.error("❌ Bun build failed with errors:");
  for (const log of buildResult.logs) {
    console.error(log);
  }
  process.exit(1);
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

  // Preload UI critical font if available
  const preloadFontTag = `<link rel="preload" href="/fonts/Assistant/Assistant-SemiBold.woff2" as="font" type="font/woff2" crossorigin="anonymous" />`;
  finalHtml = finalHtml.replace(
    "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
    preloadFontTag,
  );

  fs.writeFileSync(generatedHtmlPath, finalHtml, "utf8");
}

console.timeEnd("⚡ Build completed in");
console.log(`📦 Build artifacts written to ${outDir}`);
