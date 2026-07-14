import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormFieldsEditor, type FormField } from './FormFieldsEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

const field = (name: string, label: string): FormField => ({ name, label, type: 'text', required: false });

describe('FormFieldsEditor duplicate-name warning', () => {
  // Two fields with the same `name` POST the same key — the server keeps only one
  // value, silently losing the other. Auto-slugging the name from the label makes
  // this easy to hit (two "Phone" fields → both `phone`). Warn the builder.
  it('warns on every field that shares a name with another', () => {
    render(
      <FormFieldsEditor
        fields={[field('phone', 'Phone'), field('phone', 'Mobile'), field('email', 'Email')]}
        onChange={vi.fn()}
      />,
    );
    const warnings = screen.getAllByText(/another field uses this name/i);
    expect(warnings).toHaveLength(2); // the two `phone` fields, not the unique `email`
  });

  it('does not warn when all field names are unique', () => {
    render(
      <FormFieldsEditor
        fields={[field('phone', 'Phone'), field('email', 'Email')]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/another field uses this name/i)).toBeNull();
  });
});

describe('FormFieldsEditor name/label coupling', () => {
  it('does NOT rewrite a LOADED field\'s name when its label is edited (protects the email/phone POST key)', () => {
    const onChange = vi.fn();
    // A field loaded from the server has no _autoName flag.
    render(<FormFieldsEditor fields={[field('email', 'Email')]} onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText(/Label/i), { target: { value: 'Email address' } });

    const next = onChange.mock.calls[0][0];
    expect(next[0].label).toBe('Email address');
    expect(next[0].name).toBe('email'); // NOT rewritten to email_address
  });

  it('DOES auto-derive the name from the label for a freshly-added field (_autoName)', () => {
    const onChange = vi.fn();
    render(
      <FormFieldsEditor
        fields={[{ name: '', label: '', type: 'text', required: false, _autoName: true }]}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Label/i), { target: { value: 'Company name' } });

    expect(onChange.mock.calls[0][0][0].name).toBe('company_name');
  });
});
