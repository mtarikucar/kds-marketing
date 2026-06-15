import { Check, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { localeMap } from '@/i18n/localeMap';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './DropdownMenu';
import { IconButton } from './IconButton';

/** Ordered list of the 5 supported locales with their display names. */
const LOCALES = (['en', 'ar', 'ru', 'tr', 'uz'] as const).map((code) => ({
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
