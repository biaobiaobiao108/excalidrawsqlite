import * as z from "zod/v4";

/** CSS Color 4 named colors, shared by drawing tools and folder metadata.
 * https://www.w3.org/TR/css-color-4/#named-colors
 * Context-dependent keywords (currentColor and system colors) are intentionally excluded.
 */
export const CSS_NAMED_COLORS =
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black
blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen
darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo
ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
yellowgreen`.split(/\s+/);
const colorNames = [...CSS_NAMED_COLORS, "transparent"];
export const COLOR_PATTERN = new RegExp(
  `^(?:#[\\da-f]{3}|#[\\da-f]{4}|#[\\da-f]{6}|#[\\da-f]{8}|${colorNames.join("|")})$`,
  "i",
);
export const COLOR_DESCRIPTION =
  "颜色须为 #RGB/#RGBA/#RRGGBB/#RRGGBBAA、transparent 或标准 CSS 命名色（含 rebeccapurple），不区分大小写";
export const isValidColor = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length <= 64 &&
  COLOR_PATTERN.test(value.trim());

// Keep format validation at the Standard Schema boundary before any handler runs.
// Advertising a large pattern makes clients echo that pattern on every invalid color;
// the wire schema advertises type/length and guidance, and the server checks the format.
export const colorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(64)
  .refine(isValidColor, COLOR_DESCRIPTION)
  .describe(COLOR_DESCRIPTION);
