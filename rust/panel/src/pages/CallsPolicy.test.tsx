import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { CallPolicy } from '@/api/calls';
import type { MeOut } from '@/api/types';
import { me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

const manager: MeOut = {
  ...me,
  memberships: [
    { ...me.memberships[0], permissions: [...me.memberships[0].permissions, 'calls.work', 'calls.manage'] },
  ],
};

const stored: CallPolicy = {
  greeting_inbound: '',
  voicemail_text: '',
  recording_announcement: '',
  disclose_assistant: true,
  disclosure_sentence: '',
  holding_default: [],
  max_duration_s: 360,
  slow_agent_s: 4,
  holding_again_s: 10,
  fallback_after_s: 20,
  caller_silence_s: 6,
  caller_silence_close_s: 15,
  handoff_extension: null,
  estimated_minor_per_minute: 0,
  opening_outbound: "Merhaba, ben Acme'nin dijital asistanıyım.",
  transcript_notice: 'Görüşmemiz hizmet kalitesi için yazıya dökülmektedir.',
  closing: 'Görüşmek üzere, iyi günler.',
  phrases: {
    acknowledgements: ['Hı hı.', 'Anladım.', 'Tamam.', 'Peki.'],
    fillers: ['Bir saniye, hemen bakıyorum.', 'Kontrol ediyorum, kısa bir an.'],
    long_wait: ['Biraz daha zaman alıyor, beklediğiniz için teşekkürler.'],
    not_heard: ['Sizi tam duyamadım, tekrar eder misiniz?'],
    still_there: ['Hâlâ orada mısınız?'],
    fault: ['Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız.'],
  },
};

describe('CallsPolicy', () => {
  const start = async (extra = {}) => {
    const calls = mockFetch({
      'GET /api/auth/me': manager,
      'GET /api/calls': [],
      'GET /api/calls/policy': stored,
      'PUT /api/calls/policy': stored,
      ...extra,
    });
    const rendered = renderAt('/calls');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Arama ayarları' }));
    await screen.findByLabelText(tr.calls.policy.fields.greeting_inbound);
    return { user, calls, ...rendered };
  };
  const section = (name: keyof typeof tr.calls.policy.editor.sections) =>
    screen.getByRole('button', { name: new RegExp('^' + tr.calls.policy.editor.sections[name].title) });

  it('shows one scenario and keeps drafts across directions and scenarios', async () => {
    const { user, calls } = await start();
    expect(screen.queryByLabelText(tr.calls.policy.fields.recording_announcement)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.common.save })).toBeDisabled();
    await user.type(screen.getByLabelText(tr.calls.policy.fields.greeting_inbound), 'Merhaba');
    await user.selectOptions(screen.getByLabelText(tr.calls.policy.editor.direction), 'opening_outbound');
    expect(screen.getByLabelText(tr.calls.policy.fields.opening_outbound)).toHaveValue(
      stored.opening_outbound,
    );
    await user.click(section('waiting'));
    await user.click(section('opening'));
    await user.selectOptions(screen.getByLabelText(tr.calls.policy.editor.direction), 'greeting_inbound');
    expect(screen.getByLabelText(tr.calls.policy.fields.greeting_inbound)).toHaveValue('Merhaba');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.click(screen.getByRole('button', { name: tr.calls.policy.editor.discard }));
    expect(screen.getByLabelText(tr.calls.policy.fields.greeting_inbound)).toHaveValue('');
    expect(screen.getByRole('button', { name: tr.common.save })).toBeDisabled();
  });

  it('saves the whole policy with phrase edits made in another scenario', async () => {
    const { user, calls } = await start();
    await user.type(screen.getByLabelText(tr.calls.policy.fields.greeting_inbound), 'Merhaba');
    await user.click(section('waiting'));
    await user.click(screen.getByRole('button', { name: tr.calls.policy.editor.addPhrase }));
    await user.type(screen.getByLabelText('Cümle 1'), 'Bir saniye');
    await user.click(screen.getByRole('button', { name: tr.calls.policy.editor.addPhrase }));
    await user.type(screen.getByLabelText('Cümle 2'), 'Hemen bakıyorum');
    await user.click(section('opening'));
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        { ...stored, greeting_inbound: 'Merhaba', holding_default: ['Bir saniye', 'Hemen bakıyorum'] },
      ]),
    );
  });

  it('edits notices and bridge phrases without replacing the other groups', async () => {
    const { user, calls } = await start();
    await user.click(section('notices'));
    const notice = screen.getByLabelText(tr.calls.policy.fields.transcript_notice);
    await user.clear(notice);
    await user.type(notice, 'Görüşme yazıya dökülür.');
    await user.click(section('waiting'));
    await user.selectOptions(screen.getByLabelText(tr.calls.policy.editor.phraseType), 'fillers');
    await user.click(screen.getByRole('button', { name: tr.calls.policy.editor.addPhrase }));
    await user.type(screen.getByLabelText('Cümle 3'), 'Hemen dönüyorum.');
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        {
          ...stored,
          transcript_notice: 'Görüşme yazıya dökülür.',
          phrases: { ...stored.phrases, fillers: [...stored.phrases.fillers, 'Hemen dönüyorum.'] },
        },
      ]),
    );
  });

  it('reads resolved workspace templates after saving instead of displaying raw nulls', async () => {
    const shown = { ...stored, disclosure_sentence: "ben Acme'nin dijital asistanıyım" };
    const { user, calls } = await start({
      'GET /api/calls/policy': shown,
      'PUT /api/calls/policy': { ...shown, opening_outbound: null, disclosure_sentence: '' },
    });
    await user.type(screen.getByLabelText(tr.calls.policy.fields.greeting_inbound), 'Merhaba');
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/calls/policy').length;
    const before = reads();
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() => expect(reads()).toBe(before + 1));
    await waitFor(() => expect(screen.getByRole('button', { name: tr.common.save })).toBeDisabled());
    await user.click(section('notices'));
    expect(screen.getByLabelText(tr.calls.policy.fields.disclosure_sentence)).toHaveValue(
      shown.disclosure_sentence,
    );
    await user.click(section('opening'));
    await user.selectOptions(screen.getByLabelText(tr.calls.policy.editor.direction), 'opening_outbound');
    expect(screen.getByLabelText(tr.calls.policy.fields.opening_outbound)).toHaveValue(
      stored.opening_outbound,
    );
  });

  it('reveals invalid timing and never turns a blank duration into zero', async () => {
    const { user, calls } = await start();
    await user.click(section('waiting'));
    await user.clear(screen.getByLabelText(tr.calls.policy.fields.fallback_after_s));
    await user.type(screen.getByLabelText(tr.calls.policy.fields.fallback_after_s), '3');
    await user.click(section('opening'));
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    expect(screen.getByLabelText(tr.calls.policy.fields.fallback_after_s)).toBeVisible();
    await user.clear(screen.getByLabelText(tr.calls.policy.fields.fallback_after_s));
    expect(screen.getByLabelText(tr.calls.policy.fields.fallback_after_s)).toHaveValue(null);
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('preserves a draft on refresh and blocks overwriting a changed server policy', async () => {
    const { user, calls, client } = await start();
    await user.type(screen.getByLabelText(tr.calls.policy.fields.greeting_inbound), 'Yerel taslak');
    await act(async () => {
      client.setQueryData(['calls', 'policy'], { ...stored, max_duration_s: 120 });
    });
    await waitFor(() => expect(screen.getByText(tr.calls.policy.editor.conflict)).toBeVisible());
    expect(screen.getByLabelText(tr.calls.policy.fields.greeting_inbound)).toHaveValue('Yerel taslak');
    expect(screen.getByRole('button', { name: tr.common.save })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: tr.calls.policy.editor.loadLatest }));
    await user.click(section('limits'));
    expect(screen.getByLabelText(tr.calls.policy.fields.max_duration_s)).toHaveValue(120);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('limits phrases to five and keeps their order when removing an entry', async () => {
    const { user, calls } = await start();
    await user.click(section('waiting'));
    await user.selectOptions(screen.getByLabelText(tr.calls.policy.editor.phraseType), 'acknowledgements');
    await user.click(screen.getByRole('button', { name: tr.calls.policy.editor.addPhrase }));
    expect(screen.getByRole('button', { name: tr.calls.policy.editor.addPhrase })).toBeDisabled();
    await user.type(screen.getByLabelText('Cümle 5'), 'Anlaşıldı.');
    await user.click(screen.getByRole('button', { name: '2. cümleyi kaldır' }));
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'PUT').map((c) => (c.body as CallPolicy).phrases.acknowledgements),
      ).toEqual([['Hı hı.', 'Tamam.', 'Peki.', 'Anlaşıldı.']]),
    );
  });
});
