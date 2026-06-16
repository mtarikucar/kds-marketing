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

  it('shows all 5 locale options when open', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByRole('button', { name: 'Change language' }));

    // All 5 locales should be present in the menu
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('العربية')).toBeInTheDocument();
    expect(screen.getByText('Русский')).toBeInTheDocument();
    expect(screen.getByText('Türkçe')).toBeInTheDocument();
    expect(screen.getByText("O'zbek")).toBeInTheDocument();
  });

  it('calls changeLanguage when a locale is selected', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByRole('button', { name: 'Change language' }));
    await user.click(screen.getByText('Türkçe'));

    expect(changeLanguage).toHaveBeenCalledWith('tr');
  });
});
