import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LanguageSwitcher } from './LanguageSwitcher';

const changeLanguage = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'en',
      changeLanguage,
    },
  }),
}));

beforeEach(() => {
  changeLanguage.mockClear();
});

describe('LanguageSwitcher', () => {
  it('renders the language switcher trigger button', () => {
    render(<LanguageSwitcher />);
    expect(screen.getByRole('button', { name: 'Change language' })).toBeInTheDocument();
  });

  it('shows en + tr but hides locales whose catalogs are <95% as complete as tr', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByRole('button', { name: 'Change language' }));

    // en + tr are always offered.
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('Türkçe')).toBeInTheDocument();
    // ar/ru/uz catalogs currently cover well under 95% of the tr key count, so
    // they must be hidden until their translations catch up (recomputed from
    // the locale JSONs at import time — completing a catalog unhides it).
    expect(screen.queryByText('العربية')).not.toBeInTheDocument();
    expect(screen.queryByText('Русский')).not.toBeInTheDocument();
    expect(screen.queryByText("O'zbek")).not.toBeInTheDocument();
  });

  it('calls changeLanguage when a locale is selected', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByRole('button', { name: 'Change language' }));
    await user.click(screen.getByText('Türkçe'));

    expect(changeLanguage).toHaveBeenCalledWith('tr');
  });
});
