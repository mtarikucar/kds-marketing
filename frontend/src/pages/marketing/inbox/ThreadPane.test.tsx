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

describe('ThreadPane — voicemail messages', () => {
  beforeEach(() => {
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
  });

  it('shows a Voicemail badge + audio player for a message tagged meta.raw.kind === VOICEMAIL', () => {
    const messages = [
      {
        id: 'm1',
        direction: 'INBOUND' as const,
        authorType: 'CUSTOMER' as const,
        body: 'Sesli mesaj',
        createdAt: '2026-07-09T10:00:00.000Z',
        meta: { raw: { kind: 'VOICEMAIL', audioUrl: 'https://sesdosya.netgsm.com.tr/x.wav', durationSec: 12 } },
      },
    ];
    render(<ThreadPane {...baseProps({ messages })} />);
    expect(screen.getByText('Voicemail')).toBeInTheDocument();
    expect(screen.getByText('Sesli mesaj')).toBeInTheDocument();
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe('https://sesdosya.netgsm.com.tr/x.wav');
  });

  it('does not render an audio player when a voicemail carries no audioUrl', () => {
    const messages = [
      {
        id: 'm2',
        direction: 'INBOUND' as const,
        authorType: 'CUSTOMER' as const,
        body: 'Sesli mesaj',
        createdAt: '2026-07-09T10:00:00.000Z',
        meta: { raw: { kind: 'VOICEMAIL', audioUrl: null } },
      },
    ];
    render(<ThreadPane {...baseProps({ messages })} />);
    expect(screen.getByText('Voicemail')).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('does not show the Voicemail badge for a regular SMS message', () => {
    const messages = [
      {
        id: 'm3',
        direction: 'INBOUND' as const,
        authorType: 'CUSTOMER' as const,
        body: 'merhaba',
        createdAt: '2026-07-09T10:00:00.000Z',
      },
    ];
    render(<ThreadPane {...baseProps({ messages })} />);
    expect(screen.queryByText('Voicemail')).not.toBeInTheDocument();
  });
});
