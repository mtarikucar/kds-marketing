import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { switchWorkspace } from '@/api/auth';
import { isApiError } from '@/api/client';
import { acceptInvite } from '@/api/team';
import type { AcceptOut, MeOut } from '@/api/types';
import { SESSION_KEY, useOptionalSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Button, Callout, Field, Input, PageHeader } from '@/components/ui';
import { MIN_PASSWORD_CHARS } from './RegisterPage';

/**
 * `/invite/:token`. A signed-in user accepts with one click (the invite must be for their
 * email), and the session then moves to the workspace just joined; a visitor creates their
 * account here and is signed in there. When the visitor's email already has an account, the
 * server answers that they must sign in first, and the page links to sign-in, which comes back
 * here.
 */
export function AcceptInvitePage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const session = useOptionalSession();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  const accept = useMutation({
    mutationFn: async (input: Parameters<typeof acceptInvite>[0]): Promise<AcceptOut & { session?: MeOut }> => {
      const out = await acceptInvite(input);
      if (out.me) return { ...out, session: out.me };
      // Signed in: the session goes on in its current workspace (or none), so it moves to the
      // one just joined before the user goes home. The membership stands even if this fails.
      const session = await switchWorkspace(out.workspace_id).catch(() => undefined);
      return { ...out, session };
    },
    onSuccess: async (out) => {
      if (out.session) queryClient.setQueryData(SESSION_KEY, out.session);
      // Whatever was loaded belonged to the previous workspace, and `me` gained a membership.
      await queryClient.invalidateQueries();
    },
  });

  const here = `/invite/${encodeURIComponent(token)}`;
  const loginLink = (
    <Link to="/login" state={{ from: here }} className="font-medium text-primary hover:underline">
      {t('invite.loginLink')}
    </Link>
  );

  const err = accept.error;
  const signedIn = session.data != null;
  const errorView = (() => {
    if (!isApiError(err)) return <ErrorCallout error={err} />;
    if (err.code === 'FORBIDDEN') return <Callout tone="danger">{t('invite.forbidden')}</Callout>;
    if (err.code === 'CONFLICT') {
      return signedIn ? (
        <Callout tone="info">{t('invite.alreadyMember')}</Callout>
      ) : (
        <Callout tone="warning">
          {t('invite.signInRequired')} {loginLink}
        </Callout>
      );
    }
    return <ErrorCallout error={err} />;
  })();

  if (accept.isSuccess) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('invite.title')} />
        <Callout tone="success" icon={<CheckCircle2 className="h-4 w-4" />}>
          {t('invite.accepted')}
        </Callout>
        <Button asChild>
          <Link to="/">{t('invite.goHome')}</Link>
        </Button>
      </div>
    );
  }

  const onSubmitNew = (e: FormEvent) => {
    e.preventDefault();
    accept.mutate({ token, display_name: displayName, password });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('invite.title')} description={t('invite.description')} />
      <QueryState query={session}>
        {err ? errorView : null}
        {session.data ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-foreground">{t('invite.signedInAs', { email: session.data.email })}</p>
            <Button onClick={() => accept.mutate({ token })} loading={accept.isPending}>
              {t('invite.accept')}
            </Button>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={onSubmitNew} noValidate>
            <p className="text-sm text-muted-foreground">{t('invite.newUser')}</p>
            <Field label={t('fields.display_name')} required>
              {(ids) => (
                <Input
                  id={ids.id}
                  autoComplete="name"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
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
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" loading={accept.isPending}>
              {t('invite.submitNew')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t('invite.haveAccount')} {loginLink}
            </p>
          </form>
        )}
      </QueryState>
    </div>
  );
}
