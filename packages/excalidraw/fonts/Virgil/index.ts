import { type ExcalidrawFontFaceDescriptor } from "../Fonts";
import { EXCALIDRAW_FONTS_CDN } from "../cdn";

const Virgil = EXCALIDRAW_FONTS_CDN + "/Virgil/Virgil-Regular.woff2";

export const VirgilFontFaces: ExcalidrawFontFaceDescriptor[] = [
  {
    uri: Virgil,
  },
];
