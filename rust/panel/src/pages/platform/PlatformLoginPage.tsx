import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { isApiError } from '@/api/client';
import { platformLogin } from '@/api/platform';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, Callout, Field, Input, PageHeader } from '@/components/ui';
import { returnTarget } from '@/lib/navigation';
import { PLATFORM_WORKSPACES_KEY } from './WorkspacesPage';

/** The operator's sign-in; its session is the separate `jt_platform` cookie. */
export function PlatformLoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: platformLogin,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: PLATFORM_WORKSPACES_KEY });
      navigate(returnTarget(location.state, '/platform/workspaces'), { replace: true });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate({ email, password });
  };

  const wrongCredentials = isApiError(signIn.error) && signIn.error.status === 401;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('platform.login.title')} description={t('platform.login.description')} />
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {wrongCredentials ? (
          <Callout tone="danger">{t('platform.login.invalid')}</Callout>
        ) : (
          <ErrorCallout error={signIn.error} />
        )}
        <Field label={t('fields.email')} required>
          {(ids) => (
            <Input
              id={ids.id}
              type="email"
              autoComplete="username"
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
          {t('platform.login.submit')}
        </Button>
      </form>
    </div>
  );
}
