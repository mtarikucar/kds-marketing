import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SiteBlockBuilder } from './SiteBlockBuilder';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
  }),
}));

const heroWith = (ctaUrl: string) => [
  { type: 'hero', heading: 'H', sub: 'S', ctaText: 'Go', ctaUrl },
];

describe('SiteBlockBuilder — URL normalization', () => {
  it('prepends https:// to a scheme-less CTA URL on blur (no dead link)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SiteBlockBuilder blocks={heroWith('example.com') as any} forms={[]} onChange={onChange} />);

    await user.click(screen.getByDisplayValue('example.com'));
    await user.tab(); // blur

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(next[0].ctaUrl).toBe('https://example.com');
  });

  it('LEAVES a relative CTA URL unchanged on blur (internal link, not an external host)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SiteBlockBuilder blocks={heroWith('/pricing') as any} forms={[]} onChange={onChange} />);

    await user.click(screen.getByDisplayValue('/pricing'));
    await user.tab();

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(next[0].ctaUrl).toBe('/pricing');
  });
});

describe("SiteBlockBuilder — 'callback' block (NetGSM Phase 5 Task 6)", () => {
  it('the palette adds a callback block with a default redirectType of "queue"', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SiteBlockBuilder blocks={[]} forms={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /callback/i }));

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ type: 'callback', redirectType: 'queue' })]);
  });

  it('renders the redirectMenu + phone-label editor fields for an existing callback block', () => {
    const onChange = vi.fn();
    render(
      <SiteBlockBuilder
        blocks={[{ type: 'callback', heading: 'Call me', redirectMenu: '850-queue-vip', redirectType: 'queue' }] as any}
        forms={[]}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('Call me')).toBeInTheDocument();
    expect(screen.getByDisplayValue('850-queue-vip')).toBeInTheDocument();
  });

  it('editing the redirectMenu input calls onChange with the patched block', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SiteBlockBuilder
        blocks={[{ type: 'callback', redirectMenu: '', redirectType: 'queue' }] as any}
        forms={[]}
        onChange={onChange}
      />,
    );
    const input = screen.getByPlaceholderText('850-queue-vip');
    await user.type(input, 'x');

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(next[0].redirectMenu).toBe('x');
  });

  it('shows a warning when no Netsantral target name is set yet', () => {
    render(
      <SiteBlockBuilder
        blocks={[{ type: 'callback', redirectMenu: '', redirectType: 'queue' }] as any}
        forms={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/activate this block/i)).toBeInTheDocument();
  });
});
