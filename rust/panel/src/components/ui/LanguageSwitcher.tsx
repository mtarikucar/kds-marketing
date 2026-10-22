import { Check, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '@/i18n/languages';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './DropdownMenu';
import { IconButton } from './IconButton';

/**
 * The panel's languages with their native display names. (v1 filtered five locales through a
 * completeness gate; the panel ships exactly Turkish and English, both complete by the parity
 * test, so the list is fixed.)
 */
const LOCALES = LANGUAGES.map(({ code, nativeName }) => ({ code, label: nativeName }));

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current = i18n.language;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label={t('kit.language.change')} variant="ghost">
          <Globe className="h-4 w-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map(({ code, label }) => (
          <DropdownMenuItem
            key={code}
            onSelect={() => i18n.changeLanguage(code)}
            className="justify-between"
          >
            <span lang={code}>{label}</span>
            {current === code && (
              <Check className="h-4 w-4 text-primary ms-4" aria-hidden="true" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
