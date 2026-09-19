import {
  DeviceDesktopIcon,
  FeatherIcon,
  FontFamilyNormalIcon,
  FreedrawIcon,
} from "../icons";

import {
  FONT_FAMILY,
  LXGW_WENKAI_FONT,
  SYSTEM_FONT,
} from "@excalidraw/common";

import type { FontFamilyValues } from "@excalidraw/element/types";

import type { JSX } from "react";

export const getFontFamilyIcon = (
  fontFamily: FontFamilyValues,
): JSX.Element => {
  switch (fontFamily) {
    case FONT_FAMILY.Excalifont:
      return FreedrawIcon;
    case FONT_FAMILY[LXGW_WENKAI_FONT]:
      return FeatherIcon;
    case FONT_FAMILY[SYSTEM_FONT]:
      return DeviceDesktopIcon;
    default:
      return FontFamilyNormalIcon;
  }
};
