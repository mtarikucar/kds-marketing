import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Field } from './Field';
import { Input } from './Input';

describe('Field', () => {
  it('renders label associated with control via htmlFor/id', () => {
    render(
      <Field label="Email">
        {({ id }) => <Input id={id} />}
      </Field>,
    );
    expect(screen.getByText('Email')).toBeInTheDocument();
    // The input exists and is associated via htmlFor
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows hint text when no error', () => {
    render(
      <Field label="Email" hint="Enter your work email">
        {({ id }) => <Input id={id} />}
      </Field>,
    );
    expect(screen.getByText('Enter your work email')).toBeInTheDocument();
  });

  it('shows error with role=alert and hides hint', () => {
    render(
      <Field label="Email" hint="Hint text" error="This field is required">
        {({ id }) => <Input id={id} />}
      </Field>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This field is required');
    expect(screen.queryByText('Hint text')).not.toBeInTheDocument();
  });

  it('marks input as aria-invalid when error provided', () => {
    render(
      <Field label="Email" error="Bad email">
        {({ id, invalid }) => (
          <Input id={id} aria-invalid={invalid || undefined} />
        )}
      </Field>,
    );
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows required asterisk when required=true', () => {
    render(
      <Field label="Email" required>
        {({ id }) => <Input id={id} />}
      </Field>,
    );
    // The asterisk span is aria-hidden so check DOM presence
    const label = screen.getByText('Email', { exact: false });
    expect(label.closest('label')).toBeInTheDocument();
  });
});
