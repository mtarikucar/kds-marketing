import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, CalendarDays, Slack as SlackIcon } from 'lucide-react';
import { PageHeader, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import { SsoTab } from './SsoTab';
import { GoogleCalendarTab } from './GoogleCalendarTab';
import { SlackTab } from './SlackTab';
import { googleCalendarKey } from './hooks';

/**
 * Human-readable fallback for each coarse Google-callback `reason` the backend
 * redirects back with (`?gcal=error&reason=...`). i18n keys take precedence;
 * these are the English defaults and the actionable hint for the user.
 */
function gcalErrorFallback(reason: string): string {
  // Token-exchange failures arrive as `exchange_<googleCode>` (e.g.
  // exchange_invalid_client) — give the operator the specific, actionable cause.
  if (reason.startsWith('exchange_')) {
    const code = reason.slice('exchange_'.length);
    switch (code) {
      case 'invalid_client':
        return 'Google rejected the OAuth credentials (invalid_client). The client ID and secret must be from the SAME OAuth client — re-set both and redeploy.';
      case 'redirect_uri_mismatch':
        return 'Google rejected the redirect URI (redirect_uri_mismatch). Register https://marketing.hummytummy.com/api/marketing/integrations/google-calendar/callback exactly in the OAuth client.';
      case 'invalid_grant':
        return 'The authorization code was invalid or expired (invalid_grant). Click Connect and finish the consent promptly.';
      default:
        return `Could not finish Google sign-in at the token-exchange step (${code || 'failed'}). Check the OAuth client_id/secret and redirect URI.`;
    }
  }
  switch (reason) {
    case 'state_invalid':
      return 'The Google connection link expired. Please click Connect again.';
    case 'no_refresh_token':
      return 'Google did not grant offline access. Reconnect and approve every prompt.';
    case 'not_configured':
      return 'Google Calendar is not configured on this server.';
    case 'missing_code':
      return 'Google did not return an authorization code. Please try again.';
    default:
      return 'Could not connect Google Calendar. Please try again.';
  }
}

/**
 * Connections settings — the workspace's outbound integrations in one place:
 *  - Single sign-on (OIDC) via the per-workspace SSO controller,
 *  - Google Calendar two-way sync via the env-gated google-calendar controller,
 *  - Slack notifications via the incoming-webhook slack controller.
 *
 * Manager-only (the routes are OWNER/MANAGER-gated server-side). Secrets are
 * sealed at rest and never displayed — the UI only shows presence flags.
 *
 * The Google OAuth callback 302s the browser back here with `?gcal=connected`
 * or `?gcal=error&reason=<step>`; we surface a toast, refresh the status query,
 * focus the Google tab, and strip the params so a refresh doesn't re-fire.
 */
export default function ConnectionsPage() {
  const { t } = useTranslation('marketing');
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();

  const gcalResult = searchParams.get('gcal');
  const [tab, setTab] = useState(gcalResult ? 'google-calendar' : 'sso');
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || !gcalResult) return;
    handled.current = true;

    if (gcalResult === 'connected') {
      toast.success(
        t('connections.gcal.connectedToast', { defaultValue: 'Google Calendar connected' }),
      );
      qc.invalidateQueries({ queryKey: googleCalendarKey });
    } else {
      const reason = searchParams.get('reason') ?? 'unknown';
      toast.error(
        t(`connections.gcal.errorReason.${reason}`, { defaultValue: gcalErrorFallback(reason) }),
      );
    }

    const next = new URLSearchParams(searchParams);
    next.delete('gcal');
    next.delete('reason');
    setSearchParams(next, { replace: true });
  }, [gcalResult, searchParams, setSearchParams, qc, t]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('connections.title', { defaultValue: 'Connections' })}
        description={t('connections.subtitle', {
          defaultValue: 'Connect single sign-on, Google Calendar and Slack to your workspace.',
        })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="sso">
            <KeyRound className="me-2 h-4 w-4" aria-hidden="true" />
            {t('connections.tabs.sso', { defaultValue: 'Single sign-on' })}
          </TabsTrigger>
          <TabsTrigger value="google-calendar">
            <CalendarDays className="me-2 h-4 w-4" aria-hidden="true" />
            {t('connections.tabs.googleCalendar', { defaultValue: 'Google Calendar' })}
          </TabsTrigger>
          <TabsTrigger value="slack">
            <SlackIcon className="me-2 h-4 w-4" aria-hidden="true" />
            {t('connections.tabs.slack', { defaultValue: 'Slack' })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sso">
          <SsoTab />
        </TabsContent>
        <TabsContent value="google-calendar">
          <GoogleCalendarTab />
        </TabsContent>
        <TabsContent value="slack">
          <SlackTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
