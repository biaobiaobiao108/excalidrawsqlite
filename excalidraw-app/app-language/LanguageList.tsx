import { useI18n, languages } from "@excalidraw/excalidraw/i18n";
import React from "react";

import { useSetAtom } from "../app-jotai";
import { CustomSelect } from "../components/CustomSelect";

import { appLangCodeAtom } from "./language-state";

export const LanguageList = ({ style }: { style?: React.CSSProperties }) => {
  const { t, langCode } = useI18n();
  const setLangCode = useSetAtom(appLangCodeAtom);

  return (
    <CustomSelect
      value={langCode}
      onChange={setLangCode}
      ariaLabel={t("buttons.selectLanguage")}
      menuPlacement="top"
      options={languages.map((lang) => ({
        value: lang.code,
        label: lang.label,
      }))}
      size="language"
      style={style}
    />
  );
};
