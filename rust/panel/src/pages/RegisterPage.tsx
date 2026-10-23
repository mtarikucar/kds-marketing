import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { register } from '@/api/auth';
import { SESSION_KEY } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, Field, Input, PageHeader } from '@/components/ui';

/** The server's minimum password length (`MIN_PASSWORD_CHARS`). */
export const MIN_PASSWORD_CHARS = 10;

export function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ display_name: '', workspace_name: '', email: '', password: '' });
  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const signUp = useMutation({
    mutationFn: register,
    onSuccess: (me) => {
      queryClient.removeQueries();
      queryClient.setQueryData(SESSION_KEY, me);
      navigate('/', { replace: true });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    signUp.mutate(form);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('register.title')} description={t('register.description')} />
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <ErrorCallout error={signUp.error} />
        <Field label={t('fields.display_name')} required>
          {(ids) => (
            <Input id={ids.id} autoComplete="name" required value={form.display_name} onChange={set('display_name')} />
          )}
        </Field>
        <Field label={t('fields.workspace_name')} required>
          {(ids) => (
            <Input
              id={ids.id}
              autoComplete="organization"
              required
              value={form.workspace_name}
              onChange={set('workspace_name')}
            />
          )}
        </Field>
        <Field label={t('fields.email')} required>
          {(ids) => (
            <Input id={ids.id} type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
          )}
        </Field>
        <Field
          label={t('fields.password')}
          hint={t('fields.passwordHint', { min: MIN_PASSWORD_CHARS })}
          required
        >
          {(ids) => (
            <Input
              id={ids.id}
              aria-describedby={ids.describedBy}
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_CHARS}
              required
              value={form.password}
              onChange={set('password')}
            />
          )}
        </Field>
        <Button type="submit" loading={signUp.isPending}>
          {t('register.submit')}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {t('register.haveAccount')}{' '}
        <Link to="/login" className="font-medium text-primary hover:underline">
          {t('register.loginLink')}
        </Link>
      </p>
    </div>
  );
}
