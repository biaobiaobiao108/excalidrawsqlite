// Server-only approximation. No font shaping, kerning or browser font metrics.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cjkContext = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Yi}]/u;
const wideScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Yi}]/u;
const wideForms = /[\u2e80-\ua4cf\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u;
const halfwidth = /[\uff61-\uffdc\uffe8-\uffee]/u;
const ignorable = /[\p{Mark}\p{Default_Ignorable_Code_Point}\u0000-\u001f\u007f\uff9e\uff9f]/u;
const ambiguousPunctuation = /[\u00b7\u2010-\u2015\u2018-\u201f\u2022\u2025\u2026]/u;
const emojiPresentation = /\p{Emoji_Presentation}/u;
const emojiVariation = /\p{Extended_Pictographic}.*\ufe0f/u;
const joinedEmoji = /\p{Extended_Pictographic}.*\u200d.*\p{Extended_Pictographic}/u;
const keycap = /^[#*0-9]\ufe0f?\u20e3$/u;

/** Estimate one rendered line: wide CJK/fullwidth and emoji clusters 1em, other bases 0.58em. */
export const estimateTextLineWidth = (text: string, fontSize: number): number => {
  const contextualPunctuation = cjkContext.test(text);
  let ems = 0;
  for (const { segment } of graphemes.segment(text)) {
    // Emoji sequences (including modifiers, flags and ZWJ families) occupy one
    // approximate em. Text-presentation symbols such as © or → remain narrow.
    if (emojiPresentation.test(segment) || emojiVariation.test(segment) || joinedEmoji.test(segment) || keycap.test(segment)) {
      ems += 1;
      continue;
    }
    const bases = [...segment].filter((character) => !ignorable.test(character));
    if (!bases.length) continue;
    // A decomposed Hangul syllable is one grapheme, just like a precomposed one.
    if (bases.every((character) => !halfwidth.test(character) &&
      (wideScript.test(character) || wideForms.test(character)))) {
      ems += 1;
      continue;
    }
    for (const character of bases) ems += contextualPunctuation && ambiguousPunctuation.test(character) ? 1 : 0.58;
  }
  return ems * fontSize;
};
