import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { delayed, mockFetch, renderAt, withStatus } from '@/test/render';
import { LOADED, leadsMe, outreachSettings, template } from '@/test/leads';

const english = template(2, { name: 'Hatırlatma', language: 'en', subject: 'Hello {{company}}', body: 'Hi {{first_name|there}}' });

function answers(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/auth/me': leadsMe,
    'GET /api/outreach/settings': outreachSettings,
    'GET /api/outreach/templates': { items: [template(1), english], next: null },
    ...extra,
  };
}

async function openTemplate(name: string) {
  const user = userEvent.setup();
  const list = await screen.findByRole('list', { name: tr.leads.templates.list }, LOADED);
  await user.click(within(list).getByRole('button', { name: new RegExp(name) }));
  return user;
}

describe('OutreachTemplates', () => {
  it('template_editor_renders_sample_and_footer', async () => {
    mockFetch(answers());
    renderAt('/outreach/templates');
    const user = await openTemplate('Tanışma 1');
    expect(screen.getByTestId('preview-subject')).toHaveTextContent('Merhaba Örnek Kafe');
    const body = screen.getByTestId('preview-body');
    expect(body).toHaveTextContent('Merhaba Ayşe Yılmaz,');
    expect(body).toHaveTextContent('Örnek Kafe için bir önerimiz var');
    const footer = screen.getByTestId('preview-footer');
    expect(footer).toHaveTextContent('Alfa Atölye · Örnek Mah. 1, İzmir');
    expect(footer).toHaveTextContent('Bu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz.');
    expect(footer).toHaveTextContent('Kişisel verilerin işlenmesi hakkında: https://alfa.example.invalid/kvkk');
    expect(footer).toHaveTextContent('Bu e-postaları almak istemiyorsanız:');
    expect(within(screen.getByRole('list', { name: tr.leads.templates.links })).getByText('https://teklif.example.invalid/kafe')).toBeInTheDocument();

    // The source line follows the recipient's basis.
    await user.selectOptions(screen.getByRole('combobox', { name: tr.leads.templates.recipient }), 'consent');
    expect(footer).toHaveTextContent('Bu e-postayı bizden ileti almayı kabul ettiğiniz için alıyorsunuz.');

    // A variable chip goes into the body and the preview fills it.
    await user.click(within(screen.getByRole('group', { name: tr.leads.templates.vars })).getByRole('button', { name: '{{city}}' }));
    expect(screen.getByRole('textbox', { name: tr.leads.templates.body })).toHaveValue(`${template(1).template.body}{{city}}`);
    expect(screen.getByTestId('preview-body').textContent?.endsWith('İzmir')).toBe(true);

    // The footer is in the template's language.
    await openTemplate('Hatırlatma');
    expect(screen.getByTestId('preview-footer')).toHaveTextContent('To stop receiving these emails:');
    expect(screen.getByTestId('preview-body')).toHaveTextContent('Hi Ayşe');
  });

  it('unknown_variable_error_shown', async () => {
    const calls = mockFetch(
      answers({
        'POST /api/outreach/templates': withStatus(422, {
          code: 'VALIDATION',
          message: 'unknown variable',
          details: { field: 'body', reason: 'unknown_variable', name: 'custom.teklif' },
        }),
      }),
    );
    renderAt('/outreach/templates');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: tr.leads.templates.new }, LOADED));
    const form = within(screen.getByRole('form', { name: tr.leads.templates.editor }));
    await user.type(form.getByRole('textbox', { name: tr.leads.templates.name }), 'Yeni');
    await user.click(form.getByRole('textbox', { name: tr.leads.templates.subject }));
    await user.paste('Merhaba {{firma}}');
    await user.click(form.getByRole('textbox', { name: tr.leads.templates.body }));
    await user.paste('Selam {{custom.teklif}}');
    expect(await form.findByText('Konu içinde bilinmeyen değişken: firma')).toBeInTheDocument();
    const save = form.getByRole('button', { name: tr.leads.templates.create });
    expect(save).toBeDisabled();
    // Fixed here, the server may still name one it refuses.
    await user.clear(form.getByRole('textbox', { name: tr.leads.templates.subject }));
    await user.type(form.getByRole('textbox', { name: tr.leads.templates.subject }), 'Merhaba');
    expect(form.queryByText('Konu içinde bilinmeyen değişken: firma')).not.toBeInTheDocument();
    await user.click(save);
    expect(await form.findByText('Metin içinde bilinmeyen değişken: custom.teklif')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      name: 'Yeni',
      language: 'tr',
      subject: 'Merhaba',
      body: 'Selam {{custom.teklif}}',
    });
  });

  it('template_editor_resets_on_template_change', async () => {
    mockFetch(answers());
    renderAt('/outreach/templates');
    const user = await openTemplate('Tanışma 1');
    const name = screen.getByRole('textbox', { name: tr.leads.templates.name });
    await user.clear(name);
    await user.type(name, 'Taslak ad');
    await openTemplate('Hatırlatma');
    expect(screen.getByRole('textbox', { name: tr.leads.templates.name })).toHaveValue('Hatırlatma');
    expect(screen.getByRole('textbox', { name: tr.leads.templates.subject })).toHaveValue('Hello {{company}}');
  });

  it('a_new_template_is_saved_once_with_its_request_key', async () => {
    const calls = mockFetch(answers({ 'POST /api/outreach/templates': delayed(300, template(3)) }));
    renderAt('/outreach/templates');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: tr.leads.templates.new }, LOADED));
    const formEl = screen.getByRole('form', { name: tr.leads.templates.editor });
    const form = within(formEl);
    await user.type(form.getByRole('textbox', { name: tr.leads.templates.name }), 'Yeni');
    await user.type(form.getByRole('textbox', { name: tr.leads.templates.subject }), 'Merhaba');
    await user.type(form.getByRole('textbox', { name: tr.leads.templates.body }), 'Selam');
    (formEl as HTMLFormElement).requestSubmit();
    (formEl as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(typeof (calls.find((c) => c.method === 'POST')!.body as { request_key: unknown }).request_key).toBe('string');
  });
});
