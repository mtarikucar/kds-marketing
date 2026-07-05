import { Check, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { localeMap } from '@/i18n/localeMap';
import { isLocaleOffered } from '@/i18n/localeCompleteness';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './DropdownMenu';
import { IconButton } from './IconButton';

/**
 * Supported locales with their native display names, filtered to those whose
 * catalog is complete enough to offer (see localeCompleteness). Half-translated
 * locales stay hidden until their translations catch up.
 */
const LOCALES = (['en', 'ar', 'ru', 'tr', 'uz'] as const)
  .filter((code) => isLocaleOffered(code))
  .map((code) => ({
    code,
    label: localeMap[code]?.nativeName ?? code,
  }));

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = i18n.language;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label="Change language" variant="ghost">
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
            <span>{label}</span>
            {current === code && (
              <Check className="h-4 w-4 text-primary ms-4" aria-hidden="true" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
