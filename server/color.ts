/** Shared safe CSS color subset used by drawing tools and folder metadata. */
export const COLOR_PATTERN = /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|transparent|black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|brown|cyan|magenta|lime|navy|teal|olive|maroon|silver|aqua|fuchsia)$/i;
export const COLOR_DESCRIPTION = "颜色须为 #RGB/#RGBA/#RRGGBB/#RRGGBBAA、transparent 或常见 CSS 颜色名";
export const isValidColor = (value: unknown): value is string => typeof value === "string" && value.trim().length <= 64 && COLOR_PATTERN.test(value.trim());
