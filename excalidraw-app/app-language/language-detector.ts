import { defaultLang, languages } from "@excalidraw/excalidraw";
import LanguageDetector from "i18next-browser-languagedetector";

export const languageDetector = new LanguageDetector();

export const LANGUAGE_STORAGE_KEY = "i18nextLng";

languageDetector.init({
  languageUtils: {},
  order: ["localStorage", "navigator"],
  caches: ["localStorage"],
  lookupLocalStorage: LANGUAGE_STORAGE_KEY,
});

export const getPreferredLanguage = () => {
  let storedLanguage: string | null = null;
  try {
    storedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing or embedded contexts.
  }

  const detectedLanguages = storedLanguage || languageDetector.detect();

  const detectedLanguage = Array.isArray(detectedLanguages)
    ? detectedLanguages[0]
    : detectedLanguages;

  const initialLanguage =
    (detectedLanguage
      ? // region code may not be defined if user uses generic preferred language
        // (e.g. chinese vs instead of chinese-simplified)
        languages.find((lang) => lang.code.startsWith(detectedLanguage))?.code
      : null) || defaultLang.code;

  return initialLanguage;
};
