import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { login } from '@/api/auth';
import { isApiError } from '@/api/client';
import { SESSION_KEY } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, Callout, Field, Input, PageHeader } from '@/components/ui';
import { returnTarget } from '@/lib/navigation';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: login,
    onSuccess: (me) => {
      queryClient.removeQueries();
      queryClient.setQueryData(SESSION_KEY, me);
      navigate(returnTarget(location.state, '/'), { replace: true });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate({ email, password });
  };

  const wrongCredentials = isApiError(signIn.error) && signIn.error.status === 401;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('login.title')} description={t('login.description')} />
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {wrongCredentials ? (
          <Callout tone="danger">{t('login.invalid')}</Callout>
        ) : (
          <ErrorCallout error={signIn.error} />
        )}
        <Field label={t('fields.email')} required>
          {(ids) => (
            <Input
              id={ids.id}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('fields.password')} required>
          {(ids) => (
            <Input
              id={ids.id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" loading={signIn.isPending}>
          {t('login.submit')}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {t('login.noAccount')}{' '}
        <Link to="/register" className="font-medium text-primary hover:underline">
          {t('login.registerLink')}
        </Link>
      </p>
    </div>
  );
}
