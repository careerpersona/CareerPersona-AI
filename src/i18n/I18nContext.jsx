import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { LOCALES } from "./locales";

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

  // Only sets the `lang` attribute (accessibility/correctness, no visual
  // effect). Deliberately does NOT set `dir="rtl"` for Arabic — that mirrors
  // the entire page layout (header, nav, grids) via the browser's CSS
  // writing-mode handling, which would redesign the header/navigation this
  // pass is explicitly required to leave untouched. Arabic script still
  // renders its own characters right-to-left regardless, since that's
  // inherent to the Unicode bidi algorithm for the text itself. Proper RTL
  // layout support is a separate, larger design decision for later.
  useEffect(() => {
    document.documentElement.lang = language;
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
