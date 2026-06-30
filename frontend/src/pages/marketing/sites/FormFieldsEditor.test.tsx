import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
