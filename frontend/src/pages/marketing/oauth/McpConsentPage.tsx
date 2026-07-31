import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import {
  getMcpConsentData,
  submitMcpConsent,
  type McpAuthorizeParams,
  type McpConsentWorkspace,
} from '../../../features/marketing/api/mcpOAuth.service';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { navigateExternal } from '../../../lib/navigateExternal';
import { Card, CardContent, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Callout } from '../../../components/ui/Callout';
import { Spinner } from '../../../components/ui/Spinner';
import { RadioGroup, RadioGroupItem } from '../../../components/ui/RadioGroup';

/**
 * The MCP OAuth consent screen — the one place a human ever says yes to an
 * external agent (Claude.ai / Claude Desktop) acting inside their workspace.
 *
 * It is a SPA route, not server-rendered HTML, and that is the whole design:
 * `GET /api/mcp-oauth/authorize` is public and simply 302s here with the
 * authorization request as-is. Sitting behind the app's normal auth guard is
 * what turns "arrived without a session" into the ordinary login screen, so
 * the authorization server never has to know how authentication works.
 *
 * Three rules this page keeps:
 *
 *  1. **It invents nothing.** The client name, the requested scopes, the
 *     redirect URI and the grantable scopes all come from the GET response,
 *     which the backend produced after validating the request (CIMD lookup,
 *     redirect_uri match, PKCE, audience). The raw query is only ever passed
 *     back through — notably `redirect_uri` is taken from the RESPONSE, never
 *     from the URL bar, so a tampered link cannot make Deny an open redirect.
 *  2. **It cannot over-grant.** What gets POSTed is the selected workspace's
 *     `grantableScopes` — already the intersection of what the client asked
 *     for and what this user holds there. The backend re-checks all of it.
 *  3. **Scopes are shown in human language.** `leads.read` means nothing to
 *     the person deciding; "Read your leads" does.
 */

/**
 * Scope → i18n key. i18next reads `.` as a nesting separator, so the dotted
 * scope id cannot be a key on its own — `leads.read` would look for
 * `scopes.leads` → `read`. Underscore it once, here.
 */
function scopeKey(scope: string): string {
  return scope.replace(/\./g, '_');
}

/**
 * English fallbacks, so a scope always renders as a sentence even if a locale
 * file is missing the key. An UNKNOWN scope falls back to its raw id rather
 * than being hidden: a permission the user cannot read is one they cannot
 * meaningfully refuse, and silently dropping it from the list would understate
 * what they are about to approve.
 */
const SCOPE_FALLBACKS: Record<string, string> = {
  'leads.read': 'Read your leads',
  'leads.write': 'Create and update your leads',
  'leads.manage': 'Assign, convert and delete your leads',
  'contacts.read': 'Read your contacts',
  'contacts.write': 'Create and update your contacts',
  'campaigns.read': 'Read your campaigns',
  'campaigns.write': 'Create and update your campaigns',
  'campaigns.send': 'Send campaigns and messages to your audience',
  'reports.read': 'Read your reports and analytics',
  'tasks.read': 'Read your tasks',
  'tasks.write': 'Create and update your tasks',
  'automations.manage': 'Create, arm and run your marketing automations',
  'settings.manage': 'Manage your workspace settings',
};

export default function McpConsentPage() {
  const { t } = useTranslation('marketing');
  const [searchParams] = useSearchParams();
  const activeWorkspaceId = useMarketingAuthStore((s) => s.user?.workspaceId);
  const [chosenWorkspaceId, setChosenWorkspaceId] = useState<string | null>(null);

  // The authorize request, verbatim. Keyed on the serialised query so a changed
  // link refetches rather than showing the previous request's consent.
  const queryString = searchParams.toString();
  const params: McpAuthorizeParams = useMemo(
    () => Object.fromEntries(new URLSearchParams(queryString).entries()),
    [queryString],
  );

  const consent = useQuery({
    queryKey: ['mcp-oauth-consent', queryString],
    queryFn: () => getMcpConsentData(params),
    retry: false,
  });

  const data = consent.data;
  const workspaces: McpConsentWorkspace[] = data?.workspaces ?? [];
  // Default to the workspace the user is currently working in — the one they
  // almost certainly mean. Falls back to the first offered when the active
  // session belongs to a workspace this grant cannot cover.
  const selectedId =
    chosenWorkspaceId ??
    (workspaces.some((w) => w.workspaceId === activeWorkspaceId)
      ? activeWorkspaceId!
      : workspaces[0]?.workspaceId) ??
    null;
  const selected = workspaces.find((w) => w.workspaceId === selectedId) ?? null;
  const grantable = new Set(selected?.grantableScopes ?? []);

  const approve = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('no workspace selected');
      return submitMcpConsent(params, {
        workspace_id: selected.workspaceId,
        granted_scopes: selected.grantableScopes,
      });
    },
    onSuccess: (res) => {
      // The backend hands back the fully-built redirect (code + state + RFC
      // 9207 `iss`); the SPA only has to follow it.
      navigateExternal(res.redirect_to);
    },
  });

  const deny = () => {
    if (!data) return;
    // RFC 6749 §4.1.2.1 — a refusal is still a protocol response: the client is
    // waiting on its redirect and must learn WHY, with its `state` echoed so it
    // can tie the answer to the request it started.
    const url = new URL(data.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'The user declined the request');
    if (data.state !== null) url.searchParams.set('state', data.state);
    navigateExternal(url.toString());
  };

  const scopeLabel = (scope: string): string =>
    t(`mcpConsent.scopes.${scopeKey(scope)}`, { defaultValue: SCOPE_FALLBACKS[scope] ?? scope });

  const clientName =
    data?.client.clientName ||
    data?.client.clientId ||
    t('mcpConsent.unknownClient', { defaultValue: 'An application' });

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <Card>
          <CardHeader>
            <div className="flex flex-col items-center gap-3 pb-2 text-center">
              {data?.client.logoUri ? (
                <img
                  src={data.client.logoUri}
                  alt=""
                  className="h-14 w-14 rounded-2xl object-cover ring-1 ring-black/5"
                />
              ) : (
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                  <ShieldCheck className="h-7 w-7 text-primary" aria-hidden="true" />
                </span>
              )}
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('mcpConsent.title', { defaultValue: 'Authorize access' })}
                </p>
                {/* The name is its own element rather than interpolated into a
                    sentence: it is the single fact the decision rests on, and
                    keeping it out of the translated string means no locale can
                    accidentally bury or drop it. */}
                <h1 className="font-display text-h2 text-foreground">{clientName}</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('mcpConsent.subtitle', {
                    defaultValue:
                      'is asking to act inside your workspace. Review what it will be able to do before you allow it.',
                  })}
                </p>
                {data && (
                  // The CIMD document URL IS the client's identity (nobody else
                  // can publish at it). Showing it lets a user tell a real
                  // connector from a lookalike that merely picked the name.
                  <p className="text-xs text-muted-foreground mt-2 break-all">
                    {data.client.clientId}
                  </p>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {consent.isPending && (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            )}

            {consent.isError && (
              <Callout tone="danger">{errorMessage(consent.error)}</Callout>
            )}

            {data && (
              <div className="space-y-6">
                <section>
                  <h2 className="text-sm font-medium text-foreground mb-2">
                    {t('mcpConsent.permissionsTitle', { defaultValue: 'It will be able to:' })}
                  </h2>
                  <ul className="space-y-1.5">
                    {data.requestedScopes.map((scope) => {
                      const allowed = grantable.has(scope);
                      return (
                        <li
                          key={scope}
                          className={`flex items-start gap-2 text-sm ${
                            allowed ? 'text-foreground' : 'text-muted-foreground line-through'
                          }`}
                        >
                          <span aria-hidden="true">{allowed ? '✓' : '✕'}</span>
                          <span>{scopeLabel(scope)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {selected && selected.grantableScopes.length < data.requestedScopes.length && (
                    <p className="text-xs text-muted-foreground mt-2">
                      {t('mcpConsent.cappedByRole', {
                        defaultValue:
                          'Crossed-out permissions are ones your role in this workspace does not have, so they will not be granted.',
                      })}
                    </p>
                  )}
                </section>

                <section>
                  <h2 className="text-sm font-medium text-foreground mb-2">
                    {t('mcpConsent.workspaceTitle', { defaultValue: 'In this workspace:' })}
                  </h2>
                  {workspaces.length === 0 ? (
                    <Callout tone="warning">
                      {t('mcpConsent.noWorkspaces', {
                        defaultValue:
                          'You are not an active member of any workspace, so there is nothing you can grant access to.',
                      })}
                    </Callout>
                  ) : (
                    <RadioGroup
                      value={selectedId ?? undefined}
                      onValueChange={setChosenWorkspaceId}
                    >
                      {workspaces.map((ws) => (
                        <label
                          key={ws.workspaceId}
                          className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 cursor-pointer"
                        >
                          <RadioGroupItem
                            value={ws.workspaceId}
                            aria-label={ws.workspaceName}
                          />
                          <span className="text-sm text-foreground">{ws.workspaceName}</span>
                          <span className="ml-auto text-xs text-muted-foreground uppercase">
                            {ws.role}
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  )}
                </section>

                {approve.isError && <Callout tone="danger">{errorMessage(approve.error)}</Callout>}

                <div className="flex gap-3">
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onClick={deny}
                    disabled={approve.isPending}
                  >
                    {t('mcpConsent.deny', { defaultValue: 'Deny' })}
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => approve.mutate()}
                    loading={approve.isPending}
                    // Nothing grantable means an "Allow" that could only ever
                    // produce a 403 from the backend's scope cap. Say so up
                    // front instead of letting the user click into an error.
                    disabled={!selected || selected.grantableScopes.length === 0}
                  >
                    {t('mcpConsent.allow', { defaultValue: 'Allow' })}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground text-center">
                  {t('mcpConsent.revokeHint', {
                    defaultValue:
                      'You can revoke this access at any time from your workspace settings.',
                  })}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Prefer the OAuth envelope's `error_description` — it explains the refusal. */
function errorMessage(err: unknown): string {
  const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
  const description = data?.error_description ?? data?.message;
  if (typeof description === 'string' && description) return description;
  if (Array.isArray(description) && typeof description[0] === 'string') return description[0];
  return (err as { message?: string })?.message ?? 'This authorization request could not be read.';
}
