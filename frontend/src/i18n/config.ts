import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { rtlLanguages, supportedLanguages } from './localeMap';

// Marketing SPA only needs the `common` + `marketing` namespaces (the POS app
// ships ~18 others). Trimmed from frontend/src/i18n/config.ts.
import enCommon from './locales/en/common.json';
import enMarketing from './locales/en/marketing.json';
import trCommon from './locales/tr/common.json';
import trMarketing from './locales/tr/marketing.json';
import ruCommon from './locales/ru/common.json';
import ruMarketing from './locales/ru/marketing.json';
import uzCommon from './locales/uz/common.json';
import uzMarketing from './locales/uz/marketing.json';
import arCommon from './locales/ar/common.json';
import arMarketing from './locales/ar/marketing.json';

const resources = {
  en: { common: enCommon, marketing: enMarketing },
  tr: { common: trCommon, marketing: trMarketing },
  ru: { common: ruCommon, marketing: ruMarketing },
  uz: { common: uzCommon, marketing: uzMarketing },
  ar: { common: arCommon, marketing: arMarketing },
};

const getInitialLanguage = (): string => {
  const stored = localStorage.getItem('i18n_language');
  if (stored && supportedLanguages.includes(stored)) return stored;
  const navLangs = navigator.languages ?? [navigator.language || 'en'];
  for (const lang of navLangs) {
    const code = lang.toLowerCase().split('-')[0];
    if (supportedLanguages.includes(code)) return code;
  }
  return 'en';
};

const applyDir = (lng: string) => {
  document.documentElement.lang = lng;
  document.documentElement.dir = rtlLanguages.includes(lng) ? 'rtl' : 'ltr';
};

// Dev-only: surface every key that has NO catalog entry (so it renders its inline
// `defaultValue` instead of a translation). Each missing key is logged ONCE so the
// console isn't spammed — the list is the to-do for extracting + translating
// remaining inline strings into the en/tr catalogs (ru/uz/ar fall back to en).
const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
const seenMissing = new Set<string>();
const missingKeyHandler = (
  lngs: readonly string[],
  ns: string,
  key: string,
  fallbackValue: string,
): void => {
  const id = `${ns}:${key}`;
  if (seenMissing.has(id)) return;
  seenMissing.add(id);
  // eslint-disable-next-line no-console
  console.warn(`[i18n] missing key ${id} (${lngs.join(',')}) — rendering default "${fallbackValue}"`);
};

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    lng: getInitialLanguage(),
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'marketing'],
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'] },
    returnEmptyString: false,
    // Catch untranslated keys during development without shipping the cost to prod.
    saveMissing: isDev,
    missingKeyHandler: isDev ? missingKeyHandler : undefined,
  });

applyDir(getInitialLanguage());

i18next.on('languageChanged', (lng) => {
  localStorage.setItem('i18n_language', lng);
  applyDir(lng);
});

export default i18next;
