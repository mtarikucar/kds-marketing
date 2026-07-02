import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailBlockBuilder } from './EmailBlockBuilder';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
  }),
}));

describe('EmailBlockBuilder — URL normalization', () => {
  // A scheme-less URL ("example.com") renders as a dead `#` link because the email
  // renderer's safeUrl keeps only http(s). Normalize on blur so the CTA works.
  it('prepends https:// to a scheme-less button URL on blur', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <EmailBlockBuilder
        blocks={[{ type: 'button', text: 'Go', url: 'example.com', align: 'center' }]}
        onChange={onChange}
      />,
    );

    const urlInput = screen.getByPlaceholderText('https://…');
    await user.click(urlInput);
    await user.tab(); // blur

    expect(onChange).toHaveBeenCalled();
    const nextBlocks = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(nextBlocks[0].url).toBe('https://example.com');
  });

  it('leaves an already-scheme URL unchanged on blur', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <EmailBlockBuilder
        blocks={[{ type: 'button', text: 'Go', url: 'https://acme.co/x', align: 'center' }]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByPlaceholderText('https://…'));
    await user.tab();

    const nextBlocks = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(nextBlocks[0].url).toBe('https://acme.co/x');
  });
});
