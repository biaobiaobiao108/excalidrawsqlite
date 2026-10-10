/** Shared safe CSS color subset used by drawing tools and folder metadata. */
const colorNames = "transparent black white red green blue yellow orange purple pink gray grey brown cyan magenta lime navy teal olive maroon silver aqua fuchsia".split(" ");
// JSON Schema patterns have no flags: spell case-insensitivity into the source
// so client validation and the server accept exactly the same color strings.
export const COLOR_PATTERN = new RegExp(`^(?:#[\\da-fA-F]{3}|#[\\da-fA-F]{4}|#[\\da-fA-F]{6}|#[\\da-fA-F]{8}|${colorNames.map((name) => [...name].map((letter) => `[${letter}${letter.toUpperCase()}]`).join("")).join("|")})$`);
export const COLOR_DESCRIPTION = "颜色须为 #RGB/#RGBA/#RRGGBB/#RRGGBBAA、transparent 或常见 CSS 颜色名";
export const isValidColor = (value: unknown): value is string => typeof value === "string" && value.trim().length <= 64 && COLOR_PATTERN.test(value.trim());
