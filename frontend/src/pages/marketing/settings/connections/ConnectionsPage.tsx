import { useTranslation } from 'react-i18next';
import { KeyRound, CalendarDays, Slack as SlackIcon } from 'lucide-react';
import { PageHeader, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import { SsoTab } from './SsoTab';
import { GoogleCalendarTab } from './GoogleCalendarTab';
import { SlackTab } from './SlackTab';

/**
 * Connections settings — the workspace's outbound integrations in one place:
 *  - Single sign-on (OIDC) via the per-workspace SSO controller,
 *  - Google Calendar two-way sync via the env-gated google-calendar controller,
 *  - Slack notifications via the incoming-webhook slack controller.
 *
 * Manager-only (the routes are OWNER/MANAGER-gated server-side). Secrets are
 * sealed at rest and never displayed — the UI only shows presence flags.
 */
export default function ConnectionsPage() {
  const { t } = useTranslation('marketing');

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('connections.title', { defaultValue: 'Connections' })}
        description={t('connections.subtitle', {
          defaultValue: 'Connect single sign-on, Google Calendar and Slack to your workspace.',
        })}
      />

      <Tabs defaultValue="sso">
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
