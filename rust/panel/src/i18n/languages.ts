/** The panel's languages, each named in itself. Turkish is the default. */
export const LANGUAGES = [
  { code: 'tr', nativeName: 'Türkçe' },
  { code: 'en', nativeName: 'English' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

export const DEFAULT_LANGUAGE: Language = 'tr';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((lang) => lang.code === value);
}
