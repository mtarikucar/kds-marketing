import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Instagram, Mail, MessageCircle, MessageSquareText, type LucideIcon } from 'lucide-react';
import { listCapabilities } from '@/api/capabilities';
import { isApiError } from '@/api/client';
import { addNote, sendCommercial } from '@/api/inbox';
import { getOutreachSettings } from '@/api/outreach';
import { decideProspect, promoteProspects } from '@/api/prospects';
import type { ContactChannel, ProspectGetOut } from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import {
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
  toast,
} from '@/components/ui';
import { useDraftKey, useInFlight } from '@/lib/leads';
import { useLeadsKey, useLeadsRefresh } from '../LeadsShared';
import { usePoolCopy, type PoolCopyKey } from './copy';
import { HANDOFF_MARK } from './timeline';
import { promoteOutcomeText } from './words';

// "Mesaj gönder" (spec 2026-11-10-prospects-pool-redesign-design.md): the first message to a
// prospect. Email and SMS go out through the workspace's connected account (`inbox.send`);
// WhatsApp and Instagram, where Meta lets no program start a conversation, are handed off: the
// text is prepared, the chat opens, the person presses send. Either way the prospect moves into
// the inbox first (qualified if it was new, then promoted), so the reply lands on its journey.

export type Way = 'email' | 'sms' | 'whatsapp' | 'instagram';
const WAYS: readonly Way[] = ['email', 'sms', 'whatsapp', 'instagram'];
const WAY_LABEL: Record<Way, PoolCopyKey> = { email: 'wayEmail', sms: 'waySms', whatsapp: 'wayWhatsapp', instagram: 'wayInstagram' };
const WAY_ICON: Record<Way, LucideIcon> = { email: Mail, sms: MessageSquareText, whatsapp: MessageCircle, instagram: Instagram };
/** The contact channel a direct way sends on, as the server and the basis name it. */
const DIRECT: Partial<Record<Way, ContactChannel & ('email' | 'sms')>> = { email: 'email', sms: 'sms' };
/** The longest part of the message kept in a hand-off's journey note. */
const NOTE_TEXT = 1000;
/** A hand-off's journey note: the mark the timeline reads it by, whatever the panel's language. */
export const handoffNote = (way: 'whatsapp' | 'instagram', text: string) =>
  `${HANDOFF_MARK}${way === 'whatsapp' ? 'WhatsApp' : 'Instagram'}: ${[...text].slice(0, NOTE_TEXT).join('')}`;

interface Option {
  way: Way;
  /** Whom it reaches: the address, number or handle; `null` when the prospect has none. */
  to: string | null;
  /** The connected account a direct way sends through. */
  via: string | null;
  /** Why it cannot be chosen, and where that is put right. */
  blocked: { text: string; fix?: { label: string; to: string } } | null;
}

/** The chat address a hand-off opens. */
export function handoffUrl(way: 'whatsapp' | 'instagram', to: string, text: string): string {
  if (way === 'whatsapp') return `https://wa.me/${to.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
  const handle = to.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
  return `https://ig.me/m/${encodeURIComponent(handle)}`;
}

/** A send's refusal by the commercial fence, whatever shape the error carries it in. */
function isNoPermission(error: unknown): boolean {
  return isApiError(error) && (error.message === 'IZIN_YOK' || error.details.reason === 'IZIN_YOK');
}

export function MessageDialog({ data, onClose }: { data: ProspectGetOut; onClose: () => void }) {
  const { t } = useTranslation();
  const copy = usePoolCopy();
  const key = useLeadsKey();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const promoteKey = useDraftKey();
  const sendKey = useDraftKey();
  const p = data.prospect;
  const capabilities = useQuery({ queryKey: [...key, 'send', 'capabilities'], queryFn: () => listCapabilities() });
  // The basis is the owner's setting; someone who may not read it lets the server decide.
  const settings = useQuery({ queryKey: [...key, 'send', 'outreach-settings'], queryFn: getOutreachSettings, retry: false });

  const live = (kind: string) =>
    capabilities.data?.find((c) => c.capability.kind_key === kind && c.effective_status === 'verified' && c.capability.has_sealed_config)?.capability.name ?? null;
  const basisBlock = (channel: 'email' | 'sms'): Option['blocked'] => {
    if (!settings.data) return null;
    // A commercial email ends with the sender's identity: without it the server refuses it.
    if (channel === 'email' && !settings.data.sender_identity_complete)
      return { text: copy('identityMissing'), fix: { label: copy('fillIdentity'), to: '/outreach/settings' } };
    if (settings.data.b2b_channels_in_force.includes(channel)) return null;
    return settings.data.b2b_basis.includes(channel) && !settings.data.platform_enabled
      ? { text: copy('platformOff') }
      : { text: copy('basisOff'), fix: { label: copy('openBasis'), to: '/outreach/settings' } };
  };
  const email = p.contact.email?.deliverable ? p.contact.email.value : null;
  const phone = p.contact.phone?.deliverable ? p.contact.phone.value : null;
  const handle = p.contact.instagram?.value ?? null;
  const direct = (way: 'email' | 'sms', to: string | null, kind: string, none: PoolCopyKey, unconnected: PoolCopyKey): Option => {
    const via = live(kind);
    return {
      way,
      to,
      via,
      blocked: !to
        ? { text: copy(none) }
        : capabilities.data && !via
          ? { text: copy(unconnected), fix: { label: copy('connectChannel'), to: '/connect' } }
          : basisBlock(way),
    };
  };
  const options: Option[] = [
    direct('email', email, 'mailbox', 'noEmail', 'noMailbox'),
    direct('sms', phone, 'sms_line', 'noPhone', 'noSmsLine'),
    { way: 'whatsapp', to: phone, via: null, blocked: phone ? null : { text: copy('noPhone') } },
    { way: 'instagram', to: handle, via: null, blocked: handle ? null : { text: copy('noHandle') } },
  ];
  const firstOpen = options.find((o) => !o.blocked)?.way ?? null;
  const [picked, setPicked] = useState<Way | null>(null);
  const way = picked && !options.find((o) => o.way === picked)?.blocked ? picked : firstOpen;
  const chosen = options.find((o) => o.way === way) ?? null;
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  // The chat a hand-off could not open itself (a blocked pop-up): offered as a link.
  const [fallback, setFallback] = useState<{ way: Way; url: string } | null>(null);

  const send = useMutation({
    mutationFn: async ({ tab }: { tab: Window | null }): Promise<{ kind: 'sent'; state: string } | { kind: 'handoff'; opened: boolean; url: string }> => {
      if (!chosen?.to || !way) throw new Error('no way chosen');
      try {
        let promoted = p.promoted ? { person_id: p.promoted.person_id, journey_id: p.promoted.journey_id } : null;
        if (!promoted) {
          // A person who writes to a new prospect has judged it worth contacting.
          if (p.status === 'new') await decideProspect(p.id, { decision: 'qualify', expected_revision: p.revision });
          const out = await promoteProspects({ prospect_ids: [p.id], request_key: promoteKey.keyFor({ id: p.id }) });
          const outcome = out.items[0];
          if (!outcome || outcome.outcome === 'refused') throw new Error(outcome ? promoteOutcomeText(t, outcome) : t('leads.promoteRefused.other'));
          promoted = { person_id: outcome.person_id, journey_id: outcome.journey_id };
        }
        const body = text.trim();
        const channel = DIRECT[way];
        if (channel) {
          const out = await sendCommercial(promoted.person_id, {
            channel,
            text: body,
            intent: 'commercial',
            request_key: sendKey.keyFor({ id: p.id, way, subject, body }),
            ...(way === 'email' ? { subject: subject.trim() } : {}),
          });
          return { kind: 'sent', state: out.state };
        }
        const handoff = way as 'whatsapp' | 'instagram';
        const url = handoffUrl(handoff, chosen.to, body);
        await addNote(promoted.journey_id, handoffNote(handoff, body));
        if (handoff === 'instagram') await navigator.clipboard?.writeText(body).catch(() => undefined);
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        }
        return { kind: 'handoff', opened: !!tab, url };
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    onSuccess: async (result) => {
      promoteKey.reset();
      sendKey.reset();
      await refresh();
      if (result.kind === 'sent') {
        toast.success(result.state === 'sent' ? copy('sent') : result.state === 'queued' ? copy('queued') : result.state === 'held' ? copy('held') : copy('sendState', { state: result.state }));
        onClose();
      } else if (result.opened) {
        toast.success(copy('handedOff', { way: copy(WAY_LABEL[way!]) }));
        onClose();
      } else {
        setFallback({ way: way!, url: result.url });
      }
    },
    // A refused qualification or promotion may still have changed the prospect: read it again.
    onError: () => void refresh(),
  });

  const isHandoff = way === 'whatsapp' || way === 'instagram';
  const valid = !!chosen && !chosen.blocked && text.trim() !== '' && (way !== 'email' || subject.trim() !== '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    // The new tab must open inside the click itself, or the browser blocks it; it is pointed at
    // the chat once the prospect is in contact, and closed again if that fails.
    const tab = isHandoff ? window.open('about:blank', '_blank') : null;
    guard((release) => send.mutate({ tab }, { onSettled: release }));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !send.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy('msgTitle', { name: p.business_name })}</DialogTitle>
          <DialogDescription>{[p.sector, [p.district, p.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || ' '}</DialogDescription>
        </DialogHeader>
        {fallback ? (
          <div className="flex flex-col gap-3">
            <Callout tone="info">{copy('popupBlocked')}</Callout>
            <Button asChild className="self-start">
              <a href={fallback.url} target="_blank" rel="noopener noreferrer" onClick={onClose}>
                {copy('openLink', { way: copy(WAY_LABEL[fallback.way]) })}
              </a>
            </Button>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={submit} aria-label={copy('sendMessage')}>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium">{copy('msgChannel')}</legend>
              {options.map((option) => {
                const Icon = WAY_ICON[option.way];
                const label = copy(WAY_LABEL[option.way]);
                return (
                  <label
                    key={option.way}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border px-3 py-2 text-sm',
                      option.blocked ? 'border-border bg-surface-muted/50 text-muted-foreground' : 'cursor-pointer border-border hover:border-border-strong',
                      way === option.way && !option.blocked && 'border-primary ring-1 ring-primary',
                    )}
                  >
                    <input
                      type="radio"
                      name="way"
                      className="mt-1"
                      aria-label={label}
                      checked={way === option.way}
                      disabled={!!option.blocked}
                      onChange={() => setPicked(option.way)}
                    />
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium text-foreground">
                        {label}
                        {option.to && <span className="ms-2 break-all font-normal text-muted-foreground">{option.to}</span>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {option.blocked ? (
                          <>
                            {option.blocked.text}
                            {option.blocked.fix && (
                              <>
                                {' · '}
                                <Link to={option.blocked.fix.to} className="font-medium text-primary hover:underline">
                                  {option.blocked.fix.label}
                                </Link>
                              </>
                            )}
                          </>
                        ) : option.way === 'whatsapp' ? (
                          copy('handoffWhatsapp')
                        ) : option.way === 'instagram' ? (
                          copy('handoffInstagram')
                        ) : option.via ? (
                          copy('viaAccount', { name: option.via })
                        ) : null}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {!firstOpen && capabilities.data && <Callout tone="warning">{copy('noWay')}</Callout>}
            {way === 'email' && (
              <label className="flex flex-col gap-1 text-sm font-medium">
                {copy('subject')}
                <Input value={subject} maxLength={200} autoComplete="off" onChange={(e) => setSubject(e.target.value)} />
              </label>
            )}
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1 text-sm font-medium">
                {copy('message')}
                <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
              </label>
              <span className="self-end text-xs text-muted-foreground">{copy('chars', { n: [...text].length })}</span>
            </div>
            <p className="text-xs text-muted-foreground">{copy('afterSend')}</p>
            {isNoPermission(send.error) ? (
              <Callout tone="warning">
                {copy('noPermission')}{' '}
                <Link to="/outreach/settings" className="font-medium text-primary hover:underline">
                  {copy('openBasis')}
                </Link>
              </Callout>
            ) : isApiError(send.error) ? (
              <ErrorCallout error={send.error} />
            ) : send.error ? (
              <Callout tone="danger">{(send.error as Error).message}</Callout>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={send.isPending} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!valid} loading={send.isPending}>
                {way === 'whatsapp' ? copy('openWhatsapp') : way === 'instagram' ? copy('openInstagram') : copy('send')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
