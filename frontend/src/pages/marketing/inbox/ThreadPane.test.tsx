import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreadPane } from './ThreadPane';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown) =>
      (typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue) ?? _k,
    i18n: { language: 'en' },
  }),
}));

const convo = { id: 'c1', aiPaused: false, status: 'OPEN' };

function baseProps(over: Record<string, unknown> = {}) {
  return {
    convo,
    lead: null,
    channel: null,
    messages: [],
    draft: 'hello',
    isSending: false,
    isTogglingAi: false,
    isClosing: false,
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onToggleAi: vi.fn(),
    onClose: vi.fn(),
    onBack: vi.fn(),
    onShowContext: vi.fn(),
    ...over,
  } as any;
}

describe('ThreadPane composer — Enter-to-send', () => {
  beforeEach(() => {
    // jsdom lacks scrollIntoView (used by the thread auto-scroll effect).
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
  });

  it('sends on Enter when a draft is present and not already sending', async () => {
    const onSend = vi.fn();
    render(<ThreadPane {...baseProps({ onSend })} />);
    await userEvent.type(screen.getByPlaceholderText(/type a reply/i), '{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does NOT send on Enter while a reply is already in flight (no duplicate message)', async () => {
    const onSend = vi.fn();
    render(<ThreadPane {...baseProps({ onSend, isSending: true })} />);
    await userEvent.type(screen.getByPlaceholderText(/type a reply/i), '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });
});
