/**
 * Locale configuration mapping for all supported languages
 * Provides Intl locale strings, date-fns locales (lazy loaded), and plural rules
 */

import type { Locale as DateFnsLocale } from 'date-fns';

export interface LocaleConfig {
  /** BCP 47 locale tag for Intl APIs */
  intlLocale: string;
  /** Language code */
  code: string;
  /** Human-readable name */
  name: string;
  /** Native name */
  nativeName: string;
  /** Is RTL language */
  rtl: boolean;
  /** Number of plural forms */
  pluralForms: number;
  /** Currency code commonly used in this locale */
  defaultCurrency: string;
  /** Date-fns locale loader (lazy loaded) */
  dateFnsLocale: () => Promise<DateFnsLocale>;
}

/**
 * Locale configurations for all supported languages
 */
export const localeMap: Record<string, LocaleConfig> = {
  en: {
    intlLocale: 'en-US',
    code: 'en',
    name: 'English',
    nativeName: 'English',
    rtl: false,
    pluralForms: 2, // one, other
    defaultCurrency: 'USD',
    dateFnsLocale: async () => {
      const { enUS } = await import('date-fns/locale');
      return enUS;
    },
  },
  tr: {
    intlLocale: 'tr-TR',
    code: 'tr',
    name: 'Turkish',
    nativeName: 'Türkçe',
    rtl: false,
    pluralForms: 2, // one, other
    defaultCurrency: 'TRY',
    dateFnsLocale: async () => {
      const { tr } = await import('date-fns/locale');
      return tr;
    },
  },
  ru: {
    intlLocale: 'ru-RU',
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',
    rtl: false,
    pluralForms: 3, // one, few, many
    defaultCurrency: 'RUB',
    dateFnsLocale: async () => {
      const { ru } = await import('date-fns/locale');
      return ru;
    },
  },
  uz: {
    intlLocale: 'uz-UZ',
    code: 'uz',
    name: 'Uzbek',
    nativeName: "O'zbek",
    rtl: false,
    pluralForms: 2, // one, other
    defaultCurrency: 'UZS',
    dateFnsLocale: async () => {
      const { uz } = await import('date-fns/locale');
      return uz;
    },
  },
  ar: {
    intlLocale: 'ar-SA',
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    rtl: true,
    pluralForms: 6, // zero, one, two, few, many, other
    defaultCurrency: 'SAR',
    dateFnsLocale: async () => {
      const { arSA } = await import('date-fns/locale');
      return arSA;
    },
  },
};

/**
 * Get locale config for a language code
 * Falls back to English if not found
 */
export const getLocaleConfig = (langCode: string): LocaleConfig => {
  return localeMap[langCode] || localeMap.en;
};

/**
 * List of all supported language codes
 */
export const supportedLanguages = Object.keys(localeMap);

/**
 * List of RTL language codes
 */
export const rtlLanguages = Object.entries(localeMap)
  .filter(([, config]) => config.rtl)
  .map(([code]) => code);
