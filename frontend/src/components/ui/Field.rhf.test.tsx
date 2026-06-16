import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { useForm } from 'react-hook-form';
import { Field } from './Field';
import { Input } from './Input';

interface FormData {
  username: string;
}

function TestForm({ onSubmit }: { onSubmit: (data: FormData) => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>();

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Field
        label="Username"
        error={errors.username?.message}
        required
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            {...register('username', { required: 'Username is required' })}
          />
        )}
      </Field>
      <button type="submit">Submit</button>
    </form>
  );
}

describe('Field + Input with react-hook-form', () => {
  it('shows error via role=alert when submitted empty', async () => {
    const onSubmit = vi.fn();
    render(<TestForm onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Username is required');
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('marks input as aria-invalid after failed submission', async () => {
    const onSubmit = vi.fn();
    render(<TestForm onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    });
  });

  it('submits values when valid input provided', async () => {
    const onSubmit = vi.fn();
    render(<TestForm onSubmit={onSubmit} />);

    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'tarik');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ username: 'tarik' }, expect.anything());
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
