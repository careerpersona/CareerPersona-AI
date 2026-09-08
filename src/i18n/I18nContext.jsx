import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { LOCALES } from "./locales";
import { RTL_LANGUAGES } from "./languages";

export const I18nContext = createContext(null);

const getNested = (obj, path) => path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);

// Owns the actual language state + the t() function. Called directly by the
// top-level App component (so its own JSX can use `t` without needing to be
// a context *consumer* of itself), and the same {language, setLanguage, t}
// value is then passed down via I18nContext.Provider so descendant
// components (UserMenu now; page components as they're translated) can
// reach it with useI18n() instead of prop-drilling.
//
// Translation is being rolled out page-by-page — `t()` falls back to the
// English string (and finally the key itself) for any key a locale or
// namespace hasn't been translated yet, so untranslated areas degrade to
// English instead of breaking.
export function useLanguagePreference(initialLanguage, onLanguageChange) {
  const [language, setLanguageState] = useState(initialLanguage || "en");
  const appliedInitial = useRef(false);

  // Sync once the real persisted language loads (e.g. after profile fetch
  // resolves) without overwriting a language the user just picked locally.
  useEffect(() => {
    if (appliedInitial.current) return;
    if (initialLanguage) {
      setLanguageState(initialLanguage);
      appliedInitial.current = true;
    }
  }, [initialLanguage]);

  // Stage 1 of RTL support (see project memory: Arabic RTL governance gap):
  // sets both `lang` and `dir` on the document root. `dir="rtl"` for Arabic
  // is what makes the browser's own direction-relative CSS behavior (flex
  // start/end, CSS Grid line numbering, native form control alignment) kick
  // in for the header/nav/chat/etc. that already rely on it — see the RTL
  // architecture audit. The remaining physical-CSS-property conversion
  // (marginLeft/Right, textAlign left/right, dropdown anchoring, arrows,
  // toggles, badges, number formatting) is explicitly later-stage work, not
  // done here.
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
  }, [language]);

  const setLanguage = useCallback((code) => {
    setLanguageState(code);
    onLanguageChange?.(code);
  }, [onLanguageChange]);

  const t = useCallback((key, fallback) => {
    const value = getNested(LOCALES[language], key) ?? getNested(LOCALES.en, key) ?? fallback ?? key;
    return value;
  }, [language]);

  return { language, setLanguage, t };
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nContext.Provider");
  return ctx;
}
