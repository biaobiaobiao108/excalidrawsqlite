import * as z from "zod/v4";

/** Shared safe CSS color subset used by drawing tools and folder metadata. */
const colorNames = "transparent black white red green blue yellow orange purple pink gray grey brown cyan magenta lime navy teal olive maroon silver aqua fuchsia".split(" ");
export const COLOR_PATTERN = new RegExp(`^(?:#[\\da-f]{3}|#[\\da-f]{4}|#[\\da-f]{6}|#[\\da-f]{8}|${colorNames.join("|")})$`, "i");
export const COLOR_DESCRIPTION = "颜色须为 #RGB/#RGBA/#RRGGBB/#RRGGBBAA、transparent 或常见 CSS 颜色名";
export const isValidColor = (value: unknown): value is string => typeof value === "string" && value.trim().length <= 64 && COLOR_PATTERN.test(value.trim());

// Keep format validation at the Standard Schema boundary before any handler runs.
// Advertising a large pattern makes clients echo that pattern on every invalid color;
// the wire schema advertises type/length and guidance, and the server checks the format.
export const colorSchema = z.string().trim().toLowerCase().max(64)
  .refine(isValidColor, COLOR_DESCRIPTION).describe(COLOR_DESCRIPTION);
