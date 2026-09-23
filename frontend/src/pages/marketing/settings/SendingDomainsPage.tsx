import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, RefreshCw, Trash2, Copy, ShieldCheck, AlertTriangle, Mail } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import {
  PageHeader, Card, CardContent, Button, Input, Field, Badge, EmptyState, ConfirmDialog,
} from '@/components/ui';

type RecordNoteCode = 'SPF_MERGE' | 'DMARC_ONLY_IF_ABSENT';
type ReasonCode = 'MISSING' | 'DUPLICATE' | 'NO_INCLUDE' | 'KEY_MISMATCH' | 'NOT_CONFIGURED' | 'UNAVAILABLE';

interface DnsRecord {
  label: string;
  host: string;
  type: string;
  value: string;
  /** English fallback for `noteCode`, straight from the server. */
  note?: string;
  noteCode?: RecordNoteCode;
  /** The record must be added ONLY when the host has nothing of its kind. */
  onlyIfAbsent?: boolean;
}
interface RecordCheck { ok: boolean; reason?: ReasonCode }
interface DnsChecks { dkim: RecordCheck; spf: RecordCheck; dmarc: RecordCheck }
interface SendingDomain {
  id: string;
  domain: string;
  status: 'PENDING' | 'VERIFIED' | 'FAILED';
  fromEmail: string | null;
  lastError: string | null;
  records: DnsRecord[];
  /** Present only on a verify response — what the resolver actually said. */
  checks?: DnsChecks;
}

const STATUS_TONE: Record<SendingDomain['status'], 'neutral' | 'success' | 'danger'> = {
  PENDING: 'neutral',
  VERIFIED: 'success',
  FAILED: 'danger',
};

/**
 * English fallbacks for the server's reason codes, keyed the way the catalogue
 * is. "Not yet found: SPF" is actively harmful when the record is there twice —
 * following it makes the tenant's own mail fail SPF harder — so every reason
 * gets its own sentence rather than one generic "missing".
 */
const REASON_FALLBACK: Record<string, string> = {
  'DKIM.MISSING': 'DKIM: the record is not published yet.',
  'DKIM.KEY_MISMATCH': 'DKIM: that selector publishes a different key.',
  'SPF.MISSING': 'SPF: the record is not published yet.',
  'SPF.DUPLICATE': 'SPF: two v=spf1 records are published — merge them into one; a domain may publish only one.',
  'SPF.NO_INCLUDE': 'SPF: a record exists but does not carry our include — add it before the final "all" term.',
  'SPF.NOT_CONFIGURED': 'SPF is not configured on this deployment yet — ask your operator.',
  'DMARC.MISSING': 'DMARC: no policy is published yet.',
  'DMARC.DUPLICATE': 'DMARC: two records are published — keep one; a second _dmarc record voids the policy.',
};

function apiErr(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
}

/**
 * Custom sending domains (Epic 13) — register a domain, publish the DKIM/SPF/
 * DMARC records, and verify it.
 *
 * The register endpoint answers 503 unless an operator has actually wired an
 * ESP, which is what `entitlements.features.sendingDomains` reports, so the
 * form is offered only when a registration could succeed. Everything else here
 * exists to keep the DNS advice from breaking mail we do not send: the records
 * carry their conditions, and a verify reports what the resolver said instead
 * of a flat "not found".
 */
export default function SendingDomainsPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const { has, isLoading: entLoading } = useEntitlements();
  const [domain, setDomain] = useState('');
  const [fromName, setFromName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SendingDomain | null>(null);
  // The check is transient (it is never persisted), so the last verify's answer
  // is held per row until the next one replaces it.
  const [checks, setChecks] = useState<Record<string, DnsChecks>>({});

  // Fails CLOSED while /billing/summary is in flight, so wait rather than flash
  // "not enabled" at an owner whose deployment has it on.
  const enabled = has('sendingDomains');

  const { data: domains = [] } = useQuery({
    queryKey: ['sending-domains'],
    queryFn: () => marketingApi.get('/sending-domains').then((r) => r.data as SendingDomain[]),
    refetchInterval: (q) =>
      (q.state.data as SendingDomain[] | undefined)?.some((d) => d.status === 'PENDING') ? 15000 : false,
  });

  const register = useMutation({
    mutationFn: () => marketingApi.post('/sending-domains', { domain, fromName: fromName || undefined }).then((r) => r.data),
    onSuccess: () => {
      setDomain('');
      setFromName('');
      qc.invalidateQueries({ queryKey: ['sending-domains'] });
      toast.success(t('sendingDomains.added', { defaultValue: 'Domain added — publish the DNS records below, then verify.' }));
    },
    onError: (e) => toast.error(apiErr(e, t('sendingDomains.addFailed', { defaultValue: 'Could not add the domain' }))),
  });

  const verify = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/sending-domains/${id}/verify`).then((r) => r.data as SendingDomain),
    onSuccess: (d) => {
      setChecks((prev) => ({ ...prev, [d.id]: d.checks as DnsChecks }));
      qc.invalidateQueries({ queryKey: ['sending-domains'] });
      toast[d.status === 'VERIFIED' ? 'success' : 'message'](
        d.status === 'VERIFIED'
          ? t('sendingDomains.verified', { defaultValue: 'Domain verified!' })
          : t('sendingDomains.notYet', { defaultValue: 'Records not found yet — DNS can take a while to propagate.' }),
      );
    },
    onError: (e) => toast.error(apiErr(e, t('sendingDomains.verifyFailed', { defaultValue: 'Verification failed' }))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/sending-domains/${id}`).then((r) => r.data),
    onSuccess: () => { setDeleteTarget(null); qc.invalidateQueries({ queryKey: ['sending-domains'] }); },
    onError: (e) => toast.error(apiErr(e, t('sendingDomains.deleteFailed', { defaultValue: 'Could not delete the domain' }))),
  });

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).then(
      () => toast.success(t('sendingDomains.copied', { defaultValue: 'Copied' })),
      () => undefined,
    );
  };

  /** One sentence per record that did not pass, in the tenant's language. */
  const problemLines = (c: DnsChecks | undefined): string[] => {
    if (!c) return [];
    return ([['DKIM', c.dkim], ['SPF', c.spf], ['DMARC', c.dmarc]] as const)
      .filter(([, r]) => r && !r.ok)
      .map(([label, r]) => {
        const reason = r.reason ?? 'MISSING';
        if (reason === 'UNAVAILABLE') {
          return t('sendingDomains.reason.unavailable', {
            defaultValue: `${label} could not be checked right now — DNS did not answer.`,
            label,
          });
        }
        return t(`sendingDomains.reason.${label}.${reason}`, {
          defaultValue: REASON_FALLBACK[`${label}.${reason}`] ?? `${label}: ${reason}`,
        });
      });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        embedded={embedded}
        title={t('sendingDomains.title', { defaultValue: 'Sending Domains' })}
        description={t('sendingDomains.subtitle', { defaultValue: 'Send marketing email from your own domain with DKIM/SPF/DMARC.' })}
      />

      {enabled && (
        <Card className="max-w-2xl">
          <CardContent className="space-y-3 p-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <Field label={t('sendingDomains.domain', { defaultValue: 'Domain' })}>
                  {({ id }) => <Input id={id} placeholder="mail.acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} />}
                </Field>
              </div>
              <div className="flex-1 min-w-[160px]">
                <Field label={t('sendingDomains.fromName', { defaultValue: 'From name (optional)' })}>
                  {({ id }) => <Input id={id} value={fromName} onChange={(e) => setFromName(e.target.value)} />}
                </Field>
              </div>
              <Button onClick={() => register.mutate()} loading={register.isPending} disabled={!domain.trim()}>
                <Plus className="h-4 w-4" />{t('sendingDomains.add', { defaultValue: 'Add' })}
              </Button>
            </div>
            {/* A subdomain has no SPF or DMARC of its own, so nothing we ask for
                can collide with the mail the business already sends. */}
            <p className="text-xs text-muted-foreground">
              {t('sendingDomains.subdomainHint', {
                defaultValue:
                  'Use a subdomain such as mail.acme.com — it has no existing SPF or DMARC records for these to collide with.',
              })}
            </p>
          </CardContent>
        </Card>
      )}

      {domains.length === 0 && !entLoading ? (
        enabled ? (
          <EmptyState
            icon={<ShieldCheck className="h-10 w-10 text-muted-foreground" />}
            title={t('sendingDomains.empty', { defaultValue: 'No sending domains' })}
            description={t('sendingDomains.emptyHint', { defaultValue: 'Add a domain to send branded, authenticated email.' })}
          />
        ) : (
          <EmptyState
            data-testid="sending-domains-disabled"
            icon={<ShieldCheck className="h-10 w-10 text-muted-foreground" />}
            title={t('sendingDomains.disabledTitle', { defaultValue: 'Custom sending domains are not enabled here' })}
            description={t('sendingDomains.disabledHint', {
              defaultValue:
                'This deployment has no email provider wired up for tenant domains. Connect your own mailbox instead — your campaigns will then send from it.',
            })}
            action={
              <Button asChild variant="outline">
                <Link to="/accounts?focus=email">
                  <Mail className="h-4 w-4" />
                  {t('sendingDomains.connectMailbox', { defaultValue: 'Connect a mailbox' })}
                </Link>
              </Button>
            }
          />
        )
      ) : (
        <div className="space-y-4">
          {domains.map((d) => {
            const lines = problemLines(checks[d.id]);
            return (
              <Card key={d.id}>
                <CardContent className="p-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-foreground">{d.domain}</p>
                      {d.fromEmail && <p className="text-sm text-muted-foreground">{d.fromEmail}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={STATUS_TONE[d.status]} size="sm">{d.status}</Badge>
                      <Button variant="outline" size="sm" loading={verify.isPending && verify.variables === d.id} onClick={() => verify.mutate(d.id)}>
                        <RefreshCw className="h-4 w-4" />{t('sendingDomains.verify', { defaultValue: 'Verify' })}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(d)} title={t('common.delete', { defaultValue: 'Delete' })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {d.status !== 'VERIFIED' && (
                    <>
                      {/* The resolver's own answer wins over the stored hint: it
                          is newer, and it can say "there are two" where the hint
                          only ever said "not found". */}
                      {lines.length > 0 ? (
                        <ul className="mb-2 space-y-1">
                          {lines.map((line) => (
                            <li key={line} className="flex gap-2 text-sm text-warning">
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                              <span>{line}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        d.lastError && <p className="mb-2 text-sm text-warning">{d.lastError}</p>
                      )}
                      <p className="mb-2 text-sm text-muted-foreground">
                        {t('sendingDomains.addRecords', { defaultValue: 'Add these TXT records at your DNS provider:' })}
                      </p>
                      <div className="space-y-2">
                        {d.records.map((rec) => (
                          <div
                            key={rec.label}
                            data-testid={`record-${rec.label}`}
                            className="rounded-lg border border-border bg-surface-muted p-3 text-sm"
                          >
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <span className="font-medium text-foreground">
                                {rec.label} · {rec.type}
                                {rec.onlyIfAbsent && (
                                  <Badge tone="neutral" size="sm" className="ml-2">
                                    {t('sendingDomains.onlyIfAbsent', { defaultValue: 'Only if it does not exist yet' })}
                                  </Badge>
                                )}
                              </span>
                              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => copy(rec.value)} title={t('sendingDomains.copy', { defaultValue: 'Copy value' })}>
                                <Copy className="h-4 w-4" />
                              </button>
                            </div>
                            <p className="break-all font-mono text-xs text-muted-foreground">{rec.host}</p>
                            <p className="break-all font-mono text-xs text-foreground">{rec.value}</p>
                            {rec.note && (
                              <p className="mt-2 flex gap-2 text-xs text-warning">
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span>
                                  {rec.noteCode
                                    ? t(`sendingDomains.note.${rec.noteCode}`, {
                                        defaultValue: rec.note,
                                        domain: d.domain,
                                        host: rec.host,
                                      })
                                    : rec.note}
                                </span>
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('sendingDomains.deleteTitle', { defaultValue: 'Delete sending domain?' })}
        description={t('sendingDomains.deleteDesc', {
          defaultValue:
            'Email can no longer be sent from this domain. Re-adding it means publishing and verifying the DKIM/SPF/DMARC records again.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />
    </div>
  );
}
