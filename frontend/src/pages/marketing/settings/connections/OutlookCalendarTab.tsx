import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarDays, Link2, Unplug } from 'lucide-react';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
  Button, Badge, Callout, Skeleton, EmptyState, ConfirmDialog,
} from '@/components/ui';
import { useOutlookCalendarStatus, useOutlookCalendarMutations } from './hooks';
import type { OutlookCalendarConnection } from './types';
import { apiError } from './util';

function formatDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/**
 * Epic 12 (inert until MS_OAUTH creds) — Outlook/O365 calendar connect. Mirrors
 * the Google Calendar tab: connect starts the Microsoft OAuth round-trip;
 * inert ⇒ a "not configured" callout. (Two-way delta sync is a follow-up.)
 */
export function OutlookCalendarTab() {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useOutlookCalendarStatus();
  const { connect, disconnect } = useOutlookCalendarMutations();
  const [disconnectTarget, setDisconnectTarget] = useState<OutlookCalendarConnection | null>(null);

  const configured = data?.configured ?? false;
  const connections = data?.connections ?? [];

  const handleConnect = () => {
    connect.mutate(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: (e) => toast.error(apiError(e, t('connections.outlook.connectError', { defaultValue: 'Could not start Outlook connect' }))),
    });
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>{t('connections.outlook.title', { defaultValue: 'Outlook Calendar' })}</CardTitle>
          <CardDescription>
            {t('connections.outlook.subtitle', { defaultValue: 'Connect Microsoft Outlook / Office 365 for calendar sync.' })}
          </CardDescription>
        </div>
        {configured && (
          <Button onClick={handleConnect} loading={connect.isPending} className="shrink-0">
            <Link2 className="h-4 w-4" aria-hidden="true" />
            {t('connections.outlook.connect', { defaultValue: 'Connect Outlook' })}
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        ) : !configured ? (
          <Callout tone="warning" title={t('connections.outlook.notConfiguredTitle', { defaultValue: 'Not configured' })}>
            {t('connections.outlook.notConfigured', {
              defaultValue: 'Outlook Calendar is not configured on this server. Ask your operator to register an Azure AD app and set MS_OAUTH_CLIENT_ID, MS_OAUTH_CLIENT_SECRET and MARKETING_SECRET_KEY.',
            })}
          </Callout>
        ) : connections.length === 0 ? (
          <EmptyState
            icon={<CalendarDays className="h-10 w-10" />}
            title={t('connections.outlook.empty', { defaultValue: 'No calendar connected' })}
            description={t('connections.outlook.emptyHint', { defaultValue: 'Connect Outlook to sync bookings.' })}
            action={
              <Button onClick={handleConnect} loading={connect.isPending} variant="outline">
                <Link2 className="h-4 w-4" aria-hidden="true" />
                {t('connections.outlook.connect', { defaultValue: 'Connect Outlook' })}
              </Button>
            }
          />
        ) : (
          <ul className="space-y-3">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{c.outlookCalendarId}</p>
                    <Badge tone={c.syncEnabled ? 'success' : 'neutral'} size="sm">
                      {c.syncEnabled ? t('connections.outlook.connected', { defaultValue: 'Connected' }) : t('connections.outlook.paused', { defaultValue: 'Paused' })}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('connections.outlook.tokenExpires', { defaultValue: 'Token renews around {{when}}', when: formatDate(c.tokenExpiresAt) })}
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="text-danger" onClick={() => setDisconnectTarget(c)}>
                  <Unplug className="h-4 w-4" aria-hidden="true" />
                  {t('connections.outlook.disconnect', { defaultValue: 'Disconnect' })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!disconnectTarget}
        onOpenChange={(o) => { if (!o) setDisconnectTarget(null); }}
        title={t('connections.outlook.disconnectTitle', { defaultValue: 'Disconnect Outlook' })}
        description={t('connections.outlook.disconnectDesc', { defaultValue: 'You can reconnect at any time.' })}
        confirmLabel={t('connections.outlook.disconnect', { defaultValue: 'Disconnect' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={disconnect.isPending}
        onConfirm={() =>
          disconnectTarget &&
          disconnect.mutate(disconnectTarget.id, {
            onSuccess: () => { setDisconnectTarget(null); toast.success(t('connections.outlook.disconnected', { defaultValue: 'Outlook disconnected' })); },
            onError: (e) => toast.error(apiError(e, t('connections.outlook.disconnectError', { defaultValue: 'Failed to disconnect' }))),
          })
        }
      />
    </Card>
  );
}
