import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EmailTemplatesPage from './index';

vi.mock('../../../features/marketing/api/email-templates.service', () => ({
  listEmailTemplates: vi.fn().mockResolvedValue([]),
  getEmailTemplate: vi.fn(),
  createEmailTemplate: vi.fn().mockResolvedValue({ id: 't1' }),
  updateEmailTemplate: vi.fn().mockResolvedValue({ id: 't1' }),
  deleteEmailTemplate: vi.fn().mockResolvedValue({ message: 'ok' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The block builder is irrelevant to the accent-input test.
vi.mock('./EmailBlockBuilder', () => ({ EmailBlockBuilder: () => null }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('EmailTemplatesPage — accent color input', () => {
  // A free-text accent let a user type "red"/"#FFF", which the renderer's strict
  // #RRGGBB guard silently dropped to the default with no feedback. A native color
  // picker only ever emits a valid #RRGGBB, closing the silent-ignore gap.
  it('renders the accent as a native color picker, not a free-text field', async () => {
    const user = userEvent.setup();
    render(<EmailTemplatesPage />, { wrapper });

    await user.click((await screen.findAllByRole('button', { name: /new template/i }))[0]);

    // The dialog renders in a portal (document.body), so query the document.
    expect(document.querySelector('input[type="color"]')).not.toBeNull();
  });
});
