import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Inbox, Mail, PauseCircle, PlugZap, XCircle } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  Badge,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Skeleton,
} from '@/components/ui';

/**
 * Settings → "E-posta sağlığı".
 *
 * `no-email-observability`: a tenant whose mail stopped going out had nowhere
 * to look. The platform SMTP answers 535, or a mailbox password changed, or an
 * app credential was never mapped in the deploy — and all three look identical
 * from the product: silence. This card is the one screen that names which one
 * it is, in the tenant's own language, without asking them to read a log.
 *
 * Three rules it does not break:
 *  - A server `reason` is a CODE and is never printed raw (PLAN G8): every one
 *    is mapped to a sentence here, with a generic fallback for a code this
 *    build has not met yet.
 *  - A lane that nothing has reported on is UNKNOWN, not broken. `sendOk:null`
 *    renders as nothing at all — an absent value drawn as ✗ is how a perfectly
 *    healthy mailbox ends up looking dead.
 *  - It never becomes an error page. A refused or failed read still renders the
 *    card and its title, because the person reading it is already looking for
 *    an explanation and a blank screen is not one.
 */

interface Mailbox {
  channelId: string;
  name: string;
  address: string | null;
  verified: boolean;
  sendOk: boolean | null;
  sendReason?: string;
  receiveOk: boolean | null;
  receiveReason?: string;
  receiveSince?: string;
  reauthRequiredAt?: string;
  quarantined: number;
}

interface InertFeature {
  key: string;
  env: string[];
  missing: string[];
}

interface EmailHealthReport {
  identity: {
    transport: string;
    fromEmail: string;
    fromName: string;
    replyTo?: string;
    degraded?: { code: string; fix: string };
  } | null;
  send: {
    sent: number;
    refused: number;
    failedPermanent: number;
    failedTransient: number;
    bounced: number;
    complained: number;
    topReasons: { reason: string; count: number }[];
  };
  inbound: { done: number; skipped: number; failed: number; quarantined: number };
  suppression: { total: number; byReason: Record<string, number> };
  mailboxes: Mailbox[];
  daily: { day: string; limit: number; used: number; remaining: number };
  paused: boolean;
  partial: boolean;
  inert: InertFeature[];
}

export default function EmailHealthCard() {
  const { t } = useTranslation('marketing');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['marketing', 'email-health'],
    queryFn: () =>
      marketingApi.get('/channels/email/health').then((r) => r.data as EmailHealthReport),
    // A mailbox that just came back should show it without a reload, and this
    // is one small aggregate, not a feed.
    refetchInterval: 60_000,
    retry: false,
  });

  /** A machine code the server sent, as a sentence. Never the code itself. */
  const reasonText = (code?: string): string | null => {
    if (!code) return null;
    const known: Record<string, string> = {
      AUTH_FAILED: t('mail.health.reason.AUTH_FAILED', {
        defaultValue: 'Kullanıcı adı veya parola kabul edilmedi.',
      }),
      OAUTH_REAUTH_REQUIRED: t('mail.health.reason.OAUTH_REAUTH_REQUIRED', {
        defaultValue: 'Bağlantı yenilenmeli.',
      }),
      CONNECT_FAILED: t('mail.health.reason.CONNECT_FAILED', {
        defaultValue: 'Posta sunucusuna ulaşılamadı.',
      }),
      POLL_FAILED: t('mail.health.reason.POLL_FAILED', {
        defaultValue: 'Posta kutusu okunamadı.',
      }),
    };
    return known[code] ?? t('mail.health.reason.unknown', { defaultValue: 'Bilinmeyen bir hata.' });
  };

  const degradedText = (code?: string): string | null => {
    if (!code) return null;
    const known: Record<string, string> = {
      NO_MAILBOX: t('mail.health.degraded.NO_MAILBOX', {
        defaultValue:
          'Mailiniz Jeeta üzerinden gönderiliyor. Kendi adresinizden göndermek için posta kutunuzu bağlayın.',
      }),
      MAILBOX_UNVERIFIED: t('mail.health.degraded.MAILBOX_UNVERIFIED', {
        defaultValue: 'Posta kutunuz doğrulanmadığı için mailiniz Jeeta üzerinden gönderiliyor.',
      }),
      MAILBOX_SEND_ONLY: t('mail.health.degraded.MAILBOX_SEND_ONLY', {
        defaultValue: 'Bağlı posta kutusu bu tür e-postayı taşıyamıyor; gönderim Jeeta üzerinden.',
      }),
      OAUTH_REAUTH: t('mail.health.degraded.OAUTH_REAUTH', {
        defaultValue: 'Posta kutusu bağlantısı yenilenmeli; şimdilik Jeeta üzerinden gönderiliyor.',
      }),
      HTML_ON_CONSENT: t('mail.health.degraded.HTML_ON_CONSENT', {
        defaultValue: 'Biçimli e-postalar Jeeta üzerinden gönderiliyor.',
      }),
    };
    return known[code] ?? null;
  };

  /** An env-gated feature, named as a capability — the key list is the fix. */
  const featureText = (key: string): string => {
    const known: Record<string, string> = {
      SENDING_DOMAIN_ESP: t('mail.health.inert.SENDING_DOMAIN_ESP', {
        defaultValue: 'Kendi alan adınızdan gönderim',
      }),
      ESP_FEEDBACK: t('mail.health.inert.ESP_FEEDBACK', {
        defaultValue: 'Otomatik geri dönüş ve şikâyet bildirimleri',
      }),
      MAILBOX_OAUTH_GOOGLE: t('mail.health.inert.MAILBOX_OAUTH_GOOGLE', {
        defaultValue: 'Google ile posta kutusu bağlama',
      }),
      MAILBOX_OAUTH_MICROSOFT: t('mail.health.inert.MAILBOX_OAUTH_MICROSOFT', {
        defaultValue: 'Microsoft ile posta kutusu bağlama',
      }),
      INBOUND_WEBHOOK: t('mail.health.inert.INBOUND_WEBHOOK', {
        defaultValue: 'Webhook ile gelen e-posta',
      }),
      PLATFORM_DKIM: t('mail.health.inert.PLATFORM_DKIM', {
        defaultValue: 'Giden e-posta imzalama (DKIM)',
      }),
      SECRET_BOX: t('mail.health.inert.SECRET_BOX', {
        defaultValue: 'Posta kutusu bilgilerinin şifrelenmesi',
      }),
    };
    return known[key] ?? key;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('mail.health.title', { defaultValue: 'E-posta sağlığı' })}
        </CardTitle>
        <CardDescription>
          {t('mail.health.subtitle', {
            defaultValue: 'E-postanız kimden gidiyor, ne gitti, ne gitmedi ve neden.',
          })}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isLoading && <Skeleton className="h-24 w-full" />}

        {isError && (
          <Callout tone="warning">
            {t('mail.health.unavailable', {
              defaultValue: 'E-posta sağlığı şu anda okunamıyor.',
            })}
          </Callout>
        )}

        {data && (
          <>
            {data.partial && (
              <Callout tone="warning">
                {t('mail.health.partial', {
                  defaultValue: 'Bir okuma tamamlanamadı — bazı sayılar eksik olabilir.',
                })}
              </Callout>
            )}

            {data.paused && (
              <Callout tone="danger" icon={<PauseCircle className="h-4 w-4" aria-hidden />}>
                {t('mail.health.paused', {
                  defaultValue:
                    'Bu çalışma alanında e-posta gönderimi duraklatıldı. Hiçbir e-posta gönderilmiyor.',
                })}
              </Callout>
            )}

            {/* Who the mail is from — the first question, and the one the
                platform-fallback answer belongs to. */}
            {data.identity && (
              <section className="flex flex-col gap-1">
                <div className="text-sm text-muted-foreground">
                  {t('mail.health.from', { defaultValue: 'Gönderen' })}
                </div>
                <div className="text-sm text-foreground">
                  {data.identity.fromName} &lt;{data.identity.fromEmail}&gt;
                </div>
                {data.identity.replyTo && (
                  <div className="text-sm text-muted-foreground">
                    {t('mail.health.replyTo', { defaultValue: 'Yanıtlar' })}:{' '}
                    {data.identity.replyTo}
                  </div>
                )}
                {degradedText(data.identity.degraded?.code) && (
                  <Callout tone="info" className="mt-1">
                    {degradedText(data.identity.degraded?.code)}
                  </Callout>
                )}
              </section>
            )}

            <Separator />

            {/* Today against the shared relay's per-tenant ceiling. */}
            <section className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">
                {t('mail.health.today', { defaultValue: 'Bugün (Jeeta üzerinden)' })}
              </span>
              <span className="text-sm font-medium text-foreground">
                {data.daily.used} / {data.daily.limit}
              </span>
            </section>
            {data.daily.limit > 0 && data.daily.used >= data.daily.limit && (
              <Callout tone="warning">
                {t('mail.dailyCapReached', {
                  used: data.daily.used,
                  limit: data.daily.limit,
                  defaultValue:
                    'Günlük e-posta sınırına ulaşıldı ({{used}}/{{limit}}). Yarın devam edecek.',
                })}
              </Callout>
            )}

            {/* The window's outcomes. Bounces and complaints are separated from
                failures on purpose: they are reputation, not plumbing. */}
            <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t('mail.health.sent', { defaultValue: 'Gönderildi' })} value={data.send.sent} />
              <Stat
                label={t('mail.health.failed', { defaultValue: 'Gönderilemedi' })}
                value={data.send.failedPermanent + data.send.failedTransient}
              />
              <Stat
                label={t('mail.health.bounced', { defaultValue: 'Geri döndü' })}
                value={data.send.bounced}
              />
              <Stat
                label={t('mail.health.complained', { defaultValue: 'Spam işaretlendi' })}
                value={data.send.complained}
              />
            </section>

            {data.send.topReasons.length > 0 && (
              <section className="flex flex-wrap gap-2">
                {data.send.topReasons.map((r) => (
                  <Badge key={r.reason} tone="neutral">
                    {t(`mail.reason.${r.reason}`, { defaultValue: r.reason })} · {r.count}
                  </Badge>
                ))}
              </section>
            )}

            {data.inbound.quarantined > 0 && (
              <Callout tone="warning" icon={<Inbox className="h-4 w-4" aria-hidden />}>
                {t('channels.inboundQuarantined', {
                  count: data.inbound.quarantined,
                  defaultValue: '{{count}} gelen e-posta işlenemedi',
                })}
              </Callout>
            )}

            {data.mailboxes.length > 0 && (
              <>
                <Separator />
                <section className="flex flex-col gap-3">
                  {data.mailboxes.map((box) => (
                    <div key={box.channelId} className="flex flex-col gap-1">
                      <div className="text-sm font-medium text-foreground">
                        {box.address ?? box.name}
                      </div>

                      {!box.verified && (
                        <div className="text-sm text-warning">
                          {t('channels.notVerified', {
                            defaultValue:
                              'Bu posta kutusu henüz doğrulanmadı — gönderim ve yanıt alma kapalı.',
                          })}
                        </div>
                      )}

                      {/* Rendered ONLY for an explicit true/false. `null` is
                          "nobody has reported on this lane yet". */}
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        {box.sendOk !== null && <Lane ok={box.sendOk} label={t('mail.health.laneSend', { defaultValue: 'Gönderim' })} />}
                        {box.receiveOk !== null && (
                          <Lane
                            ok={box.receiveOk}
                            label={t('mail.health.laneReceive', { defaultValue: 'Alım' })}
                          />
                        )}
                      </div>

                      {box.receiveOk === false && reasonText(box.receiveReason) && (
                        <div className="text-sm text-muted-foreground">
                          {reasonText(box.receiveReason)}
                        </div>
                      )}
                      {box.sendOk === false && !box.reauthRequiredAt && reasonText(box.sendReason) && (
                        <div className="text-sm text-muted-foreground">
                          {reasonText(box.sendReason)}
                        </div>
                      )}
                      {box.reauthRequiredAt && (
                        <div className="flex items-center gap-2 text-sm text-danger">
                          <PlugZap className="h-4 w-4" aria-hidden />
                          {t('accounts.reauthRequired', { defaultValue: 'Bağlantı yenilenmeli' })}
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              </>
            )}

            {data.suppression.total > 0 && (
              <div className="text-sm text-muted-foreground">
                {t('mail.health.suppressed', {
                  count: data.suppression.total,
                  defaultValue: '{{count}} adres e-posta almıyor (çıkış, geri dönüş veya şikâyet).',
                })}
              </div>
            )}

            {data.inert.length > 0 && (
              <>
                <Separator />
                <section className="flex flex-col gap-2">
                  <div className="text-sm text-muted-foreground">
                    {t('mail.health.inertTitle', {
                      defaultValue: 'Şu anda kapalı olan özellikler',
                    })}
                  </div>
                  {data.inert.map((f) => (
                    <div key={f.key} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-foreground">{featureText(f.key)}</span>
                      {f.missing.map((env) => (
                        <code
                          key={env}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                        >
                          {env}
                        </code>
                      ))}
                    </div>
                  ))}
                  <div className="text-xs text-muted-foreground">
                    {t('mail.health.inertHint', {
                      defaultValue:
                        'Bu anahtarları yöneticiniz tanımlayana kadar ilgili özellik sessizce kapalı kalır.',
                    })}
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-h3 font-display text-foreground">{value}</div>
    </div>
  );
}

/** "Gönderim ✓" / "Alım ✗" — the two lanes the card promises, as one shape. */
function Lane({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={ok ? 'flex items-center gap-1 text-success' : 'flex items-center gap-1 text-danger'}>
      {ok ? (
        <CheckCircle2 className="h-4 w-4" aria-hidden />
      ) : (
        <XCircle className="h-4 w-4" aria-hidden />
      )}
      {label} {ok ? '✓' : '✗'}
    </span>
  );
}
