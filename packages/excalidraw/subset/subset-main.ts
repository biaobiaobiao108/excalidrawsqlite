/**
 * Tries to subset glyphs in a font based on the used codepoints, returning the font as dataurl.
 * Lazy-loads the shared subsetting chunk and runs on the main thread.
 *
 * @param arrayBuffer font data buffer in the woff2 format
 * @param codePoints codepoints used to subset the glyphs
 *
 * @returns font with subsetted glyphs (all glyphs in case of errors) converted into a dataurl
 */
export const subsetWoff2GlyphsByCodepoints = async (
  arrayBuffer: ArrayBuffer,
  codePoints: Array<number>,
): Promise<string> => {
  const { subsetToBase64 } = await lazyLoadSharedSubsetChunk();
  return subsetToBase64(arrayBuffer, codePoints);
};

// lazy-loaded and cached chunk
let subsetShared: Promise<typeof import("./subset-shared.chunk")> | null = null;

const lazyLoadSharedSubsetChunk = async () => {
  if (!subsetShared) {
    subsetShared = import("./subset-shared.chunk");
  }

  return subsetShared;
};
