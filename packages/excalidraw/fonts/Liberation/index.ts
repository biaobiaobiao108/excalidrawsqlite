import { type ExcalidrawFontFaceDescriptor } from "../Fonts";
import { EXCALIDRAW_FONTS_CDN } from "../cdn";

const LiberationSansRegular =
  EXCALIDRAW_FONTS_CDN + "/Liberation/LiberationSans-Regular.woff2";

export const LiberationFontFaces: ExcalidrawFontFaceDescriptor[] = [
  {
    uri: LiberationSansRegular,
  },
];
