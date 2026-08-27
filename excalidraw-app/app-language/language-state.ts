import { useEffect } from "react";

import { atom, useAtom } from "../app-jotai";

import {
  getPreferredLanguage,
  LANGUAGE_STORAGE_KEY,
  languageDetector,
} from "./language-detector";

export const appLangCodeAtom = atom(getPreferredLanguage());

export const useAppLangCode = () => {
  const [langCode, setLangCode] = useAtom(appLangCodeAtom);

  useEffect(() => {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, langCode);
    } catch {
      languageDetector.cacheUserLanguage(langCode);
    }
  }, [langCode]);

  return [langCode, setLangCode] as const;
};
