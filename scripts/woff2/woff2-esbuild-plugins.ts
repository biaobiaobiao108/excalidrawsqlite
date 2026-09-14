import path from "node:path";
import { mkdir, rm } from "node:fs/promises";

import { Font } from "fonteditor-core";
import type { Plugin } from "esbuild";
import wawoff from "wawoff2";

type FontInstance = InstanceType<typeof Font>;

/**
 * Custom esbuild plugin to:
 * 1. inline all woff2 (url and relative imports) as base64 for server-side use cases (no need for additional font fetch; works in both esm and commonjs)
 * 2. convert all the imported fonts (including those from cdn) at build time into .ttf (since Resvg does not support woff2, neither inlined dataurls - https://github.com/RazrFalcon/resvg/issues/541)
 *    - merging multiple woff2 into one ttf (for same families with different unicode ranges)
 *    - deduplicating glyphs due to the merge process
 *    - merging fallback font for each
 *    - printing out font metrics
 */
export const woff2ServerPlugin = (options: { outdir?: string } = {}): Plugin => ({
  name: "woff2ServerPlugin",
  setup(build) {
    const fonts = new Map<string, Partial<Record<string, FontInstance[]>>>();

    build.onResolve({ filter: /\.woff2$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path),
      namespace: "woff2ServerPlugin",
    }));

    build.onLoad(
      { filter: /.*/, namespace: "woff2ServerPlugin" },
      async (args) => {
        if (!path.isAbsolute(args.path)) {
          throw new Error(`Font path has to be absolute! "${args.path}"`);
        }

        const woff2Buffer = await Bun.file(args.path).arrayBuffer();
        const snftBuffer = await wawoff.decompress(woff2Buffer);
        let font: FontInstance;

        try {
          font = Font.create(snftBuffer, {
            type: "ttf",
            hinting: true,
            kerning: true,
          });
        } catch {
          font = Font.create(snftBuffer, {
            type: "otf",
            hinting: true,
            kerning: true,
          });
        }

        const fontFamily = font.data.name.fontFamily;
        const subFamily = font.data.name.fontSubFamily;
        const familyFonts = fonts.get(fontFamily) || {};
        const subFamilyFonts = familyFonts[subFamily] || [];
        subFamilyFonts.push(font);
        familyFonts[subFamily] = subFamilyFonts;
        fonts.set(fontFamily, familyFonts);

        return {
          contents: `data:font/woff2;base64,${new Uint8Array(
            woff2Buffer,
          ).toBase64()}`,
          loader: "text",
        };
      },
    );

    build.onEnd(async () => {
      const { outdir } = options;
      if (!outdir) {
        return;
      }

      const pyftmerge = Bun.which("pyftmerge");
      if (!pyftmerge) {
        console.error(
          'Skipped TTF generation: install "fonttools" first in order to generate TTF fonts!\nhttps://github.com/fonttools/fonttools',
        );
        return;
      }

      const outputDir = path.resolve(outdir);
      await mkdir(outputDir, { recursive: true });
      const xiaolaiPath = path.resolve(
        import.meta.dir,
        "./assets/Xiaolai-Regular.ttf",
      );
      const emojiPath = path.resolve(
        import.meta.dir,
        "./assets/NotoEmoji-Regular.ttf",
      );
      const emojiPath2048 = path.resolve(
        import.meta.dir,
        "./assets/NotoEmoji-Regular-2048.ttf",
      );
      const liberationPath = path.resolve(
        import.meta.dir,
        "./assets/LiberationSans-Regular.ttf",
      );
      const liberationPath2048 = path.resolve(
        import.meta.dir,
        "./assets/LiberationSans-Regular-2048.ttf",
      );

      const xiaolaiFont = Font.create(
        await Bun.file(xiaolaiPath).arrayBuffer(),
        { type: "ttf" },
      );
      const emojiFont = Font.create(
        await Bun.file(emojiPath).arrayBuffer(),
        { type: "ttf" },
      );
      const liberationFont = Font.create(
        await Bun.file(liberationPath).arrayBuffer(),
        { type: "ttf" },
      );

      const sortedFonts = [...fonts.entries()].sort(([family1], [family2]) =>
        family1 > family2 ? 1 : -1,
      );
      for (const [family, familyFonts] of sortedFonts) {
        const regularFonts = familyFonts.Regular;
        if (!regularFonts?.length || family.includes("Xiaolai")) {
          continue;
        }

        const baseFont = regularFonts[0];
        const tempPaths = regularFonts.map((_, index) =>
          path.resolve(outputDir, `temp_${family}_${index}.ttf`),
        );
        for (const [index, font] of regularFonts.entries()) {
          await Bun.write(tempPaths[index], font.write({ type: "ttf" }));
        }

        const mergedFontPath = path.resolve(outputDir, `${family}.ttf`);
        const fallbackFontsPaths = family.includes("Excalifont")
          ? [xiaolaiPath]
          : [];
        if (baseFont.data.head.unitsPerEm === 2048) {
          fallbackFontsPaths.push(emojiPath2048, liberationPath2048);
        } else {
          fallbackFontsPaths.push(emojiPath, liberationPath);
        }

        const mergeResult = Bun.spawnSync({
          cmd: [
            pyftmerge,
            "--drop-tables=vhea,vmtx",
            `--output-file=${mergedFontPath}`,
            ...tempPaths,
            ...fallbackFontsPaths,
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        await Promise.all(
          tempPaths.map((tempPath) => rm(tempPath, { force: true })),
        );
        if (mergeResult.exitCode !== 0) {
          throw new Error(
            new TextDecoder().decode(mergeResult.stderr) ||
              `pyftmerge exited with code ${mergeResult.exitCode}`,
          );
        }

        const mergedFont = Font.create(
          await Bun.file(mergedFontPath).arrayBuffer(),
          { type: "ttf", kerning: true, hinting: true },
        );
        const getNameField = (field: "copyright" | "licence") => {
          const base = baseFont.data.name[field];
          const xiaolai = xiaolaiFont.data.name[field];
          const emoji = emojiFont.data.name[field];
          const liberation = liberationFont.data.name[field];
          return family.includes("Excalifont")
            ? `${base} & ${xiaolai} & ${emoji} & ${liberation}`
            : `${base} & ${emoji} & ${liberation}`;
        };
        mergedFont.set({
          ...mergedFont.data,
          name: {
            ...mergedFont.data.name,
            copyright: getNameField("copyright"),
            licence: getNameField("licence"),
          },
        });
        await rm(mergedFontPath, { force: true });
        await Bun.write(mergedFontPath, mergedFont.write({ type: "ttf" }));

        const { ascent, descent } = baseFont.data.hhea;
        console.info(`Generated "${family}"`);
        if (regularFonts.length > 1) {
          console.info(
            `- by merging ${regularFonts.length} woff2 fonts and related fallback fonts`,
          );
        }
        console.info(
          `- with metrics ${baseFont.data.head.unitsPerEm}, ${ascent}, ${descent}`,
        );
      }
    });
  },
});
