import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { completeOAuth, confirmAssets } from '@/api/connectors';
import type { AssetPublic, PendingAssetsOut } from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  PageHeader,
  Spinner,
  toast,
} from '@/components/ui';
import { kindLabel } from '@/lib/capabilities';
import { callbackErrorMessage, oauthProviderErrorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { forgetFlow, rememberedFlow, restartPath, type RememberedFlow } from '@/lib/oauthFlow';
import { invalidateCapabilities } from './capabilities/queries';

/** What the provider sent back in the address, read once when the page opens. */
interface Answer {
  state: string | null;
  code: string | null;
  /** The provider's error code (`access_denied` …); its description is never read. */
  error: string | null;
}

/**
 * The callback addresses a flow comes back to, one per provider app (`connector::OAuthCallback`):
 * `meta` (Facebook Login), `instagram` (Instagram Login), `x`, `tiktok` and `linkedin`.
 */
const CALLBACKS = ['meta', 'instagram', 'x', 'tiktok', 'linkedin'] as const;

function isCallback(segment: string): boolean {
  return (CALLBACKS as readonly string[]).includes(segment);
}

/**
 * Where completing the flow stands. Kept in the page's own state, set by the mutation's own
 * callbacks (which run whatever observes them): under StrictMode the effect that started the
 * completion is cleaned up and run again, which detaches the mutation's observer, so its
 * `isError` would never turn true; the code is good once, so the second run never asks again.
 */
type Completion = { kind: 'waiting' } | { kind: 'done'; out: PendingAssetsOut } | { kind: 'failed'; error: unknown };

/** An asset's public facts worth showing: the granted scopes, the access's end, and plain values. */
function facts(asset: AssetPublic): { scopes: string[]; expiresAt: string | null; plain: [string, string][] } {
  const scopes: string[] = [];
  let expiresAt: string | null = null;
  const plain: [string, string][] = [];
  if (asset.public !== null && typeof asset.public === 'object' && !Array.isArray(asset.public)) {
    for (const [key, value] of Object.entries(asset.public as Record<string, unknown>)) {
      if (key === 'scopes' && Array.isArray(value)) {
        scopes.push(...value.filter((s): s is string => typeof s === 'string'));
      } else if (key === 'expires_at' && typeof value === 'string') {
        expiresAt = value;
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        plain.push([key, String(value)]);
      }
    }
  }
  return { scopes, expiresAt, plain };
}

/**
 * The assets in the order found, those of one provider id together: choosing an id connects every
 * asset it has (`connector::confirm_assets`), so a Page and its Messenger are one choice.
 */
function byAccount(assets: AssetPublic[]): AssetPublic[][] {
  const accounts = new Map<string, AssetPublic[]>();
  for (const asset of assets) accounts.set(asset.external_id, [...(accounts.get(asset.external_id) ?? []), asset]);
  return [...accounts.values()];
}

function AssetRow({
  assets,
  checked,
  onChange,
}: {
  /** The assets of one provider id, at least one. */
  assets: AssetPublic[];
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const account = assets[0].external_id;
  const id = `asset-${account}`;
  const each = assets.map(facts);
  const scopes = [...new Set(each.flatMap((f) => f.scopes))];
  const expiresAt = each.flatMap((f) => (f.expiresAt ? [f.expiresAt] : [])).sort()[0] ?? null;
  const plain = [...new Map(each.flatMap((f) => f.plain).map((kv) => [kv.join('='), kv] as const)).values()];
  const names = [...new Set(assets.map((asset) => asset.name))];
  const kinds = assets.map((asset) => kindLabel(t, asset.kind_key));
  return (
    <li className="flex items-start gap-3 py-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-1" />
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          {names.join(' · ')}
          {assets.map((asset, i) => (
            <Badge key={asset.kind_key} size="sm">
              {kinds[i]}
            </Badge>
          ))}
        </label>
        {assets.length > 1 && (
          <p className="text-caption text-muted-foreground">{t('oauthCallback.together', { kinds: kinds.join(' + ') })}</p>
        )}
        <p className="font-mono text-micro text-muted-foreground">
          {t('oauthCallback.externalId', { id: account })}
        </p>
        {scopes.length > 0 && (
          <p className="text-caption text-muted-foreground">{t('oauthCallback.scopes', { scopes: scopes.join(', ') })}</p>
        )}
        {expiresAt && (
          <p className="text-caption text-muted-foreground">
            {t('oauthCallback.expires', { at: formatDateTime(expiresAt, i18n.language) })}
          </p>
        )}
        {plain.length > 0 && (
          <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-muted-foreground">
            {plain.map(([key, value]) => (
              <div key={`${key}=${value}`} className="flex gap-1">
                <dt>{key}:</dt>
                <dd className="text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

/** A refused callback: the panel's words and a way to start again (for the same capability). */
function Failed({ message, flow }: { message: string; flow: RememberedFlow | null }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('oauthCallback.errorTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Callout tone="danger">{message}</Callout>
        <div>
          <Button asChild variant="outline">
            <Link to={restartPath(flow)}>{t('oauthCallback.restart')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * `/oauth/callback/:provider` (`meta`, `instagram` or `x`, the app the flow signed in with): where
 * a provider sends the owner's browser back. The page reads the provider's answer once, drops it
 * from the address, passes it to the API at the same segment (a same-site request carrying the
 * session, which the provider's redirect did not), lists the assets the flow found and connects
 * the ones the owner chooses. A provider's error is shown in the panel's words only.
 */
export function OAuthCallbackPage() {
  const { t } = useTranslation();
  const { provider = '' } = useParams();
  const known = isCallback(provider);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [answer] = useState<Answer>(() => ({
    state: params.get('state'),
    code: params.get('code'),
    error: params.get('error'),
  }));
  // The flow this tab started, if it is the one coming back: its capability, if bound to one.
  const [flow] = useState(() => rememberedFlow());
  const [completion, setCompletion] = useState<Completion>({ kind: 'waiting' });
  const pending = completion.kind === 'done' ? completion.out : null;
  const [selected, setSelected] = useState<string[]>([]);
  // The code is good once: the flow completes once, whatever renders (or runs effects) twice.
  const asked = useRef(false);

  // The state and the code leave the mutation as soon as it answers: no cache keeps them. Its
  // outcome lives in `completion`, never in the mutation's observer (see `Completion`).
  const complete = useMutation({
    mutationFn: ({ state, code }: { state: string; code: string }) => completeOAuth(provider, state, code),
    gcTime: 0,
    onSuccess: (out) => {
      setCompletion({ kind: 'done', out });
      // One account found (a Page with its Messenger, say): nothing to choose between.
      if (new Set(out.assets.map((asset) => asset.external_id)).size === 1) setSelected([out.assets[0].external_id]);
      complete.reset();
    },
    onError: (error) => {
      setCompletion({ kind: 'failed', error });
      complete.reset();
    },
  });
  const confirm = useMutation({
    mutationFn: (ids: string[]) => confirmAssets(pending?.pending_id ?? '', ids),
    onSuccess: async (connected) => {
      forgetFlow();
      toast.success(t('oauthCallback.connected', { count: connected.length }));
      await invalidateCapabilities(queryClient);
      navigate('/capabilities');
    },
  });

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    // Nothing of the provider's answer stays in the address bar or the history.
    if (answer.state !== null || answer.code !== null || answer.error !== null) {
      navigate({ search: '' }, { replace: true });
    }
    if (known && answer.error === null && answer.state && answer.code) {
      complete.mutate({ state: answer.state, code: answer.code });
    }
  }, [answer, complete, known, navigate]);

  let body;
  if (!known) {
    body = <Failed message={t('oauthCallback.unknownCallback')} flow={flow} />;
  } else if (answer.error !== null) {
    body = <Failed message={oauthProviderErrorMessage(t, answer.error)} flow={flow} />;
  } else if (!answer.state || !answer.code) {
    body = <Failed message={t('oauthCallback.missingParams')} flow={flow} />;
  } else if (completion.kind === 'failed') {
    body = <Failed message={callbackErrorMessage(t, completion.error)} flow={flow} />;
  } else if (!pending) {
    body = (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner />
        {t('oauthCallback.loading')}
      </div>
    );
  } else {
    const assets = pending.assets;
    const bound = flow !== null && flow.pending_id === pending.pending_id && flow.capability_id !== null;
    const toggle = (id: string, on: boolean) =>
      setSelected((now) => (on ? [...now.filter((s) => s !== id), id] : now.filter((s) => s !== id)));
    const onSubmit = (e: FormEvent) => {
      e.preventDefault();
      if (selected.length > 0) confirm.mutate(selected);
    };
    body = (
      <Card>
        <CardHeader>
          <CardTitle>{t('oauthCallback.chooseTitle')}</CardTitle>
          <CardDescription>{t('oauthCallback.chooseBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          {assets.length === 0 ? (
            <div className="flex flex-col gap-3">
              <Callout tone="warning">{t('oauthCallback.none')}</Callout>
              <div>
                <Button asChild variant="outline">
                  <Link to={restartPath(flow)}>{t('oauthCallback.restart')}</Link>
                </Button>
              </div>
            </div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
              {bound && <Callout tone="info">{t('oauthCallback.firstBinds')}</Callout>}
              <ErrorCallout error={confirm.error} />
              <ul aria-label={t('oauthCallback.assetsLabel')} className="flex flex-col divide-y divide-border">
                {byAccount(assets).map((account) => (
                  <AssetRow
                    key={account[0].external_id}
                    assets={account}
                    checked={selected.includes(account[0].external_id)}
                    onChange={(on) => toggle(account[0].external_id, on)}
                  />
                ))}
              </ul>
              <div>
                <Button type="submit" loading={confirm.isPending} disabled={selected.length === 0}>
                  {t('oauthCallback.confirm')}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <PageHeader title={t('oauthCallback.title')} />
      {body}
    </>
  );
}
