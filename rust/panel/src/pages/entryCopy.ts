import { useTranslation } from 'react-i18next';
import type tr from '@/i18n/tr.json';

/** Short, localized guidance for account setup and sign-in flows. */
export function useEntryCopy() {
  const { t } = useTranslation();
  return (key: keyof typeof tr.entryUx, values: Record<string, string | number> = {}) =>
    t(`entryUx.${key}`, values);
}
