import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WebhookEditor } from './WebhookEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string) => d ?? _k,
    i18n: { language: 'en' },
  }),
}));

function setup(step: Record<string, unknown> = {}) {
  const onPatch = vi.fn();
  render(
    <WebhookEditor
      step={{ type: 'http_webhook_out', ...step } as never}
      onPatch={onPatch}
    />,
  );
  return { onPatch };
}

describe('WebhookEditor ↔ http_webhook_out contract', () => {
  // The runtime (workflow-action.handler.ts `webhook`) POSTs
  // `{ payload, lead, trigger }` and reads `step.payload` — NOT `step.body`. The
  // editor must write `payload` so the configured body actually goes out.
  it('writes the JSON body to `payload` (the field the runtime sends)', () => {
    const { onPatch } = setup();
    const ta = screen.getByLabelText('Payload (JSON)');
    fireEvent.change(ta, { target: { value: '{"event":"qualified"}' } });
    expect(onPatch).toHaveBeenCalledWith({ payload: { event: 'qualified' } });
  });

  // The runtime hard-codes method:'POST'; a method selector was dead UI.
  it('does not offer a method selector (runtime always POSTs)', () => {
    setup();
    expect(screen.queryByText('Method')).toBeNull();
  });

  it('shows an inline error and does not patch on invalid JSON', () => {
    const { onPatch } = setup();
    const ta = screen.getByLabelText('Payload (JSON)');
    fireEvent.change(ta, { target: { value: '{ not json' } });
    expect(screen.getByText('Invalid JSON.')).toBeInTheDocument();
    expect(onPatch).not.toHaveBeenCalled();
  });
});
