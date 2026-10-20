import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { BarChart3 } from 'lucide-react';
import { Badge, Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog } from '@/components/ui';
import { isNotOffered, useGa4Mutations, useGa4Properties, useGa4Status } from './ga4Hooks';
import { apiError } from './util';

/** Actionable English fallback for each coarse callback `reason` (i18n keys win). */
function ga4ErrorFallback(reason: string): string {
  if (reason.startsWith('exchange_')) {
    const code = reason.slice('exchange_'.length);
    if (code === 'redirect_uri_mismatch') {
      return 'Google rejected the redirect URI (redirect_uri_mismatch). Register https://jeetagrowth.com/api/marketing/integrations/ga4/callback in the OAuth client.';
    }
    if (code === 'invalid_client') return 'Google rejected the OAuth client (invalid_client). Check the client ID and secret.';
    if (code === 'invalid_grant') return 'The authorization code expired (invalid_grant). Click Connect and finish promptly.';
    return `Could not finish Google sign-in (${code || 'failed'}).`;
  }
  switch (reason) {
    case 'access_denied':
      return 'Access to Google Analytics was not granted.';
    case 'state_invalid':
      return 'The connection link expired. Please click Connect again.';
    case 'no_refresh_token':
      return 'Google did not grant offline access. Reconnect and approve every prompt.';
    case 'not_configured':
      return 'Google Analytics is not configured on this server.';
    default:
      return 'Could not connect Google Analytics. Please try again.';
  }
}

/**
 * Workspace GA4 connection (Account Center → Integrations): connect over Google
 * OAuth (read-only), choose the property, see when it last synced. Renders
 * nothing when the server does not offer GA4 (GA4_SYNC_ENABLED off → 404).
 */
export function Ga4Card() {
  const { t } = useTranslation('marketing');
  const status = useGa4Status();
  const s = status.data;
  const needsProperty = !!s?.connected && !s.propertyId;
  const properties = useGa4Properties(needsProperty);
  const { connect, selectProperty, syncNow, disconnect } = useGa4Mutations();
  const [choice, setChoice] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);

  // The OAuth callback lands back here with ?ga4=connected|error&reason=…
  useEffect(() => {
    const result = params.get('ga4');
    if (!result || handled.current) return;
    handled.current = true;
    if (result === 'connected') {
      toast.success(t('connections.ga4.connected', { defaultValue: 'Google Analytics connected. Now choose the property.' }));
    } else {
      const reason = params.get('reason') ?? 'failed';
      toast.error(t(`connections.ga4.error.${reason}`, { defaultValue: ga4ErrorFallback(reason) }));
    }
    const next = new URLSearchParams(params);
    next.delete('ga4');
    next.delete('reason');
    setParams(next, { replace: true });
  }, [params, setParams, t]);

  if (status.isError && isNotOffered(status.error)) return null;
  if (!s) return null;

  const startConnect = () =>
    connect.mutate(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: (e) => toast.error(apiError(e, t('connections.ga4.connectError', { defaultValue: 'Could not start the Google sign-in.' }))),
    });

  const reauth = s.connected && (s.lastError === 'REAUTH_REQUIRED' || !s.enabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          {t('connections.ga4.title', { defaultValue: 'Google Analytics 4' })}
          {s.connected && s.propertyId && !reauth && <Badge tone="success">{t('connections.ga4.live', { defaultValue: 'Connected' })}</Badge>}
        </CardTitle>
        <CardDescription>
          {t('connections.ga4.desc', {
            defaultValue: 'Read-only daily pull of sessions, users, sources, campaigns and purchases from your GA4 property, for the weekly report.',
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!s.configured && (
          <Callout tone="warning">
            {t('connections.ga4.notConfigured', { defaultValue: 'Google Analytics is not configured on this server.' })}
          </Callout>
        )}

        {s.configured && !s.connected && (
          <Button onClick={startConnect} disabled={connect.isPending}>
            {t('connections.ga4.connect', { defaultValue: 'Connect Google Analytics' })}
          </Button>
        )}

        {reauth && (
          <Callout tone="warning">
            {t('connections.ga4.reauth', { defaultValue: 'Google access was revoked or expired, so syncing has stopped.' })}{' '}
            <Button size="sm" variant="secondary" onClick={startConnect} disabled={connect.isPending}>
              {t('connections.ga4.reconnect', { defaultValue: 'Reconnect' })}
            </Button>
          </Callout>
        )}

        {needsProperty && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              {t('connections.ga4.property', { defaultValue: 'GA4 property' })}
              <select
                className="rounded-md border border-border bg-background px-2 py-1.5"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">{t('connections.ga4.choose', { defaultValue: 'Choose…' })}</option>
                {(properties.data ?? []).map((p) => (
                  <option key={p.propertyId} value={p.propertyId}>
                    {p.displayName} {p.account ? `(${p.account})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={!choice || selectProperty.isPending}
              onClick={() =>
                selectProperty.mutate(choice, {
                  onError: (e) => toast.error(apiError(e, t('connections.ga4.selectError', { defaultValue: 'Could not save the property.' }))),
                })
              }
            >
              {t('connections.ga4.save', { defaultValue: 'Save property' })}
            </Button>
          </div>
        )}

        {s.connected && s.propertyId && (
          <div className="space-y-2 text-sm">
            <div className="font-medium text-foreground">{s.propertyName ?? s.propertyId}</div>
            <div className="text-caption text-muted-foreground">
              {s.lastSyncedAt
                ? `${t('connections.ga4.lastSynced', { defaultValue: 'Last synced' })}: ${new Date(s.lastSyncedAt).toLocaleString()}`
                : t('connections.ga4.firstSync', { defaultValue: 'The first sync (35 days) runs within the hour.' })}
            </div>
            {s.lastError && s.lastError !== 'REAUTH_REQUIRED' && (
              <div className="text-caption text-danger">{s.lastError}</div>
            )}
          </div>
        )}

        {s.connected && (
          <div className="flex gap-2">
            {s.propertyId && !reauth && (
              <Button size="sm" variant="secondary" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
                {t('connections.ga4.syncNow', { defaultValue: 'Sync now' })}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setConfirmOff(true)}>
              {t('connections.ga4.disconnect', { defaultValue: 'Disconnect' })}
            </Button>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title={t('connections.ga4.disconnectTitle', { defaultValue: 'Disconnect Google Analytics?' })}
        description={t('connections.ga4.disconnectDesc', {
          defaultValue: 'Syncing stops and the stored Google tokens are deleted. Days already pulled stay in reports.',
        })}
        confirmLabel={t('connections.ga4.disconnectConfirm', { defaultValue: 'Disconnect GA4' })}
        tone="danger"
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate(undefined, { onSettled: () => setConfirmOff(false) })}
      />
    </Card>
  );
}
