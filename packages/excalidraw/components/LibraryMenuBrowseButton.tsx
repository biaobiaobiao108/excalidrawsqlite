import { VERSIONS } from "@excalidraw/common";

import { t } from "../i18n";

import type { ExcalidrawProps, UIAppState } from "../types";

const DEFAULT_LIBRARY_URL = "https://libraries.excalidraw.com";

const LibraryMenuBrowseButton = ({
  theme,
  id,
  libraryReturnUrl,
}: {
  libraryReturnUrl: ExcalidrawProps["libraryReturnUrl"];
  theme: UIAppState["theme"];
  id: string;
}) => {
  // Keep the official public library available in clean builds that do not
  // define a custom library URL. An explicit empty value can still disable it.
  const libraryUrl =
    import.meta.env.VITE_APP_LIBRARY_URL === undefined
      ? DEFAULT_LIBRARY_URL
      : import.meta.env.VITE_APP_LIBRARY_URL;
  if (!libraryUrl) {
    return null;
  }

  const referrer =
    libraryReturnUrl || window.location.origin + window.location.pathname;
  return (
    <a
      className="library-menu-browse-button"
      href={`${libraryUrl}?target=${
        window.name || "_blank"
      }&referrer=${referrer}&useHash=true&token=${id}&theme=${theme}&version=${
        VERSIONS.excalidrawLibrary
      }`}
      target="_excalidraw_libraries"
    >
      {t("labels.libraries")}
    </a>
  );
};

export default LibraryMenuBrowseButton;
