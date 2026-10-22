import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import tr from './tr.json';
import en from './en.json';
import { DEFAULT_LANGUAGE, isLanguage, type Language } from './languages';

// Mirrors v1's wiring (i18next + initReactI18next, bundled JSON resources, the choice remembered
// in localStorage and mirrored on <html lang>), trimmed to the panel: one namespace, two
// languages, Turkish by default whatever the browser says.

const STORAGE_KEY = 'jeeta-panel-language';

export const resources = {
  tr: { translation: tr },
  en: { translation: en },
} as const;

function initialLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return DEFAULT_LANGUAGE;
}

function applyLang(lng: string): void {
  document.documentElement.lang = lng;
}

const lng = initialLanguage();

void i18next.use(initReactI18next).init({
  resources,
  lng,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: ['tr', 'en'],
  defaultNS: 'translation',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  initAsync: false,
  // No promotional console line from the library.
  showSupportNotice: false,
});

applyLang(lng);

i18next.on('languageChanged', (next) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not remembered; the language still changes for this page.
  }
  applyLang(next);
});

export default i18next;
