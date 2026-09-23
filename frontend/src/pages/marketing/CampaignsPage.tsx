import { useRef, useState } from 'react';
import { useForm, useWatch, Controller, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Megaphone,
  Trash2,
  Send,
  Sparkles,
  Plus,
  Pause,
  Play,
  Pencil,
  BarChart3,
  XCircle,
  Upload,
  CheckCircle2,
} from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { listEmailTemplates, getEmailTemplate, type EmailTemplateRow } from '../../features/marketing/api/email-templates.service';
import { provisionSocialFromCampaign } from '../../features/marketing/api/social-link.service';
import { useEntitlements } from '../../features/marketing/hooks/useEntitlements';
import { VariantsDialog } from './campaigns/VariantsDialog';
import { CampaignDetailDialog } from './campaigns/CampaignDetailDialog';
import { plainTextBody } from './campaigns/plainText';
import { smsSegments, CAMPAIGN_SMS_RESERVED_SUFFIX_CHARS } from '@/lib/smsSegments';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Callout } from '@/components/ui/Callout';
import { Separator } from '@/components/ui/Separator';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';

// ── Types ────────────────────────────────────────────────────────────────────

interface CampaignRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  stats?: Record<string, number> | null;
  scheduledAt?: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'VOICE'] as const;
const FILTER_FIELDS = ['status', 'city', 'businessType', 'priority', 'source'] as const;
// `exists` compiles to IS NULL / IS NOT NULL on the backend, and its value is a
// boolean — so the value box below becomes a two-option select for it rather
// than free text, where "false" used to be typed and read as truthy.
const OPS = ['eq', 'neq', 'in', 'contains', 'gte', 'lte', 'exists'] as const;
const EXISTS_VALUES = ['true', 'false'] as const;

// NetGSM Phase 5 — a VOICE campaign's TTS-text-vs-uploaded-audio toggle.
const VOICE_MODES = ['TTS', 'AUDIO'] as const;
// DTMF digits the callee may press for a press-N branch capture (mirrors the
// backend's VoiceConfigDto.keys — plain "0".."9" strings, ArrayMaxSize(10)).
const VOICE_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

// ── Schema ────────────────────────────────────────────────────────────────────

const filterRowSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.string(),
});

// A keypress→note row in the composer's mapping editor. Only `digit` is ever
// sent to the backend (as an entry in voiceConfig.keys); `label` is a
// same-session authoring aid (e.g. "1 = interested, connect to sales") that
// helps the operator remember what to wire up on the Automations page's
// voice_keypress trigger — VoiceConfigDto has no label field, so it is not
// persisted and will be blank again the next time a saved campaign is edited.
const voiceKeyRowSchema = z.object({
  digit: z.string(),
  label: z.string().max(200).optional(),
});

const IYS_MESSAGE_TYPES = ['BILGILENDIRME', 'TICARI'] as const;

export const campaignSchema = z
  .object({
    name: z.string().min(1, 'Required').max(120),
    channel: z.enum(CHANNELS),
    subject: z.string().max(200).optional(),
    body: z.string().max(20000),
    bodyHtml: z.string().optional(),
    emailTemplateId: z.string().optional(),
    filters: z.array(filterRowSchema),
    // datetime-local value ("YYYY-MM-DDTHH:mm"), local time — '' = send immediately.
    scheduledAt: z.string().optional(),
    // İYS classification (SMS/VOICE channels) — TICARI = commercial (requires
    // İYS consent, hard-blocked pre-send when unconfirmed), BILGILENDIRME =
    // informational/transactional (İYS-exempt). Default is the safer,
    // exempt option.
    iysMessageType: z.enum(IYS_MESSAGE_TYPES),
    // VOICE (NetGSM Phase 5) — mirrors the backend's voiceConfig: exactly one
    // of msg (TTS text)/audioid (uploaded .wav) is required; voiceMode picks
    // which one the form currently edits.
    voiceMode: z.enum(VOICE_MODES),
    voiceMsg: z.string().max(2000).optional(),
    voiceAudioId: z.string().optional(),
    voiceKeys: z.array(voiceKeyRowSchema),
  })
  // The plain-text body is only optional when an EMAIL HTML template is attached
  // (we auto-derive the plain text from it). For every OTHER channel the HTML is
  // dropped before submit, so the body must always be required there — otherwise
  // leftover EMAIL bodyHtml (not cleared when the channel switches) lets a blank
  // SMS/VOICE campaign pass the form and then 400 on the backend.
  .superRefine((v, ctx) => {
    const htmlFallback = v.channel === 'EMAIL' && !!v.bodyHtml?.trim();
    if (!htmlFallback && !v.body.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'Required' });
    }
    // Mirrors the backend's CampaignsService.assertVoiceConfig — msg XOR
    // audioid, checked against whichever mode is currently selected so a
    // stale value left over from switching modes never satisfies it.
    if (v.channel === 'VOICE') {
      const hasMsg = v.voiceMode === 'TTS' && !!v.voiceMsg?.trim();
      const hasAudio = v.voiceMode === 'AUDIO' && !!v.voiceAudioId?.trim();
      if (!hasMsg && !hasAudio) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: v.voiceMode === 'AUDIO' ? ['voiceAudioId'] : ['voiceMsg'],
          message: 'Required',
        });
      }
    }
    // The subject is what the recipient sees before they open anything, and the
    // sender's last-resort "Update" default was never meant to ship
    // (`prelaunch-safety`). EMAIL only — the other channels do not render the
    // field at all, so a flat `.min(1)` would make them unsavable.
    if (v.channel === 'EMAIL' && !v.subject?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'Required' });
    }
    // A half-written rule used to be discarded on the way out, so "status =
    // (blank)" quietly widened the audience to everybody. It is an error the
    // operator can see and fix, not a silent drop.
    v.filters.forEach((f, i) => {
      if (!f.field?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', i, 'field'], message: 'Required' });
      } else if (!String(f.value ?? '').trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', i, 'value'], message: 'Required' });
      }
    });
  });
type CampaignFormValues = z.infer<typeof campaignSchema>;

const DEFAULT_VALUES: CampaignFormValues = {
  name: '',
  channel: 'EMAIL',
  subject: '',
  body: '',
  bodyHtml: '',
  emailTemplateId: '',
  filters: [],
  scheduledAt: '',
  iysMessageType: 'BILGILENDIRME',
  voiceMode: 'TTS',
  voiceMsg: '',
  voiceAudioId: '',
  voiceKeys: [],
};

// ── Badge helpers ─────────────────────────────────────────────────────────────

function campaignStatusTone(status: string) {
  if (status === 'SENT') return 'success' as const;
  if (status === 'SENDING') return 'info' as const;
  if (status === 'PAUSED') return 'warning' as const;
  if (status === 'SCHEDULED') return 'info' as const;
  return 'neutral' as const;
}

// ── Scheduling helpers ───────────────────────────────────────────────────────

/** A `scheduledAt` more than 30s in the future — mirrors the backend's own
 *  SCHEDULE_TOLERANCE_MS so the confirm dialog's copy matches what launch()
 *  will actually do. */
function isFutureSchedule(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t > Date.now() + 30_000;
}

/** ISO datetime → the local "YYYY-MM-DDTHH:mm" value an <input type="datetime-local">
 *  expects, in the browser's own timezone (so the picker shows the wall-clock
 *  time the operator originally chose, not a UTC-shifted one). */
function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The current moment as a datetime-local value (local time, minute
 *  precision) — used as the schedule picker's `min` so the native control
 *  itself refuses an obviously-past pick. */
function nowDatetimeLocalValue(): string {
  return toDatetimeLocalValue(new Date().toISOString());
}

/** True when a non-empty datetime-local field value (bare "YYYY-MM-DDTHH:mm",
 *  parsed by the JS Date constructor as local time — same round-trip as
 *  toDatetimeLocalValue) already lies in the past. Distinct from
 *  isFutureSchedule, which reads a persisted campaign's full ISO scheduledAt
 *  with the 30s launch tolerance; this drives the live in-form warning as the
 *  operator picks a time. */
function isPastDatetimeLocalValue(value: string | undefined): boolean {
  if (!value) return false;
  const t = new Date(value).getTime();
  return !Number.isNaN(t) && t < Date.now();
}

// ── Cross-link: provision a Social Campaign from this blast ─────────────────────

/**
 * Per-row "Create social content" action. Calls the dedicated provision endpoint
 * (POST /campaigns/:id/social) which prefills a Social Campaign from the blast,
 * then jumps to the new campaign's detail page.
 */
export function CampaignSocialLinkButton({ campaignId }: { campaignId: string }) {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const provision = useMutation({
    mutationFn: () => provisionSocialFromCampaign(campaignId),
    onSuccess: (r) => {
      toast.success(t('campaigns.socialCreated', 'Social content campaign created'));
      navigate(`/social-campaigns/${r.socialCampaignId}`);
    },
    onError: () => toast.error(t('campaigns.socialCreateFailed', 'Could not create social content')),
  });
  return (
    <Button variant="outline" size="sm" disabled={provision.isPending} onClick={() => provision.mutate()}>
      <Sparkles className="h-3.5 w-3.5" />
      {t('campaigns.createSocial', 'Create social content')}
    </Button>
  );
}

// ── Pre-launch sheet ─────────────────────────────────────────────────────────

/** `GET /marketing/campaigns/:id/audience-preview`. */
/** Mirrors `SUPPRESSION_SAMPLE` in campaigns/campaign-preview.service.ts — how
 *  many addresses the server checks before it reports `truncated`. */
const SUPPRESSION_SAMPLE = 5000;

interface AudiencePreview {
  channel: string;
  /** What the send will actually attempt — suppression already subtracted. */
  matched: number;
  excluded: { optedOut: number; bounced: number; invalid: number; suppressed: number; noEmail: number };
  /** The suppression scan is sampled; true means the audience is larger than
   *  the sample, so `excluded.suppressed` is a floor rather than a count. */
  truncated: boolean;
  /** Absent when the gateway could not answer — the card then says nothing
   *  about the sender rather than showing an invented identity. */
  sender?: {
    /** False only for something that stops the WHOLE campaign. */
    ok: boolean;
    transport: string;
    from: { email: string; name: string; replyTo?: string };
    degraded?: { code: string; fix: string } | null;
    reason?: string;
  };
}

/**
 * What the operator sees before the one action in this product that cannot be
 * undone.
 *
 * It used to be a bare confirm dialog: no audience count, no idea who had been
 * dropped and why, no way to tell which address the mail would leave from, and
 * no way to look at the thing first — so an empty filter row (silently
 * discarded on the way out) mailed the entire list a subject line reading
 * "Update" (`prelaunch-safety`). The counts come from the endpoint that reuses
 * the send's own audience predicate, so this card and the blast cannot
 * disagree, and the confirm button stays inert until they have arrived.
 */
export function CampaignLaunchSheet({
  campaign,
  onCancel,
  onConfirm,
  launching,
}: {
  campaign: CampaignRow | null;
  onCancel: () => void;
  onConfirm: () => void;
  launching: boolean;
}) {
  const { t } = useTranslation('marketing');
  const open = !!campaign;
  // A future "Send at" makes this a SCHEDULE, not an instant send — same rule
  // the row and the backend use.
  const scheduled = isFutureSchedule(campaign?.scheduledAt);

  const preview = useQuery<AudiencePreview>({
    queryKey: ['marketing', 'campaigns', campaign?.id, 'audience-preview'],
    queryFn: () => marketingApi.get(`/campaigns/${campaign!.id}/audience-preview`).then((r) => r.data),
    enabled: open,
  });

  const testSend = useMutation({
    mutationFn: () => marketingApi.post(`/campaigns/${campaign!.id}/test-send`).then((r) => r.data),
    onSuccess: (d: { ok?: boolean; to?: string; reason?: string }) => {
      if (d?.ok) {
        toast.success(
          t('campaigns.prelaunch.testSendSent', { defaultValue: 'Test email sent to {{email}}', email: d.to ?? '' }),
        );
        return;
      }
      // A refusal is an answer, not a failure — and it is the same answer every
      // recipient would have got, which is the point of a rehearsal.
      toast.error(
        t('mail.notSent', { defaultValue: 'Not sent: {{reason}}', reason: t(`mail.reason.${d?.reason ?? 'UNKNOWN'}`) }),
      );
    },
    onError: (e: any) =>
      toast.error(
        e.response?.data?.message ?? t('campaigns.prelaunch.testSendFailed', 'Could not send the test email'),
      ),
  });

  const p = preview.data;
  const x = p?.excluded;
  const excludedTotal = x ? x.optedOut + x.bounced + x.invalid + x.suppressed + x.noEmail : 0;
  // Only a real number unlocks the button: an undefined count is "we do not
  // know yet", and nobody may blast on that.
  const audienceKnown = typeof p?.matched === 'number';
  const canLaunch = audienceKnown && (p as AudiencePreview).matched > 0;

  const excludedLine = (key: string, fallback: string, count: number) =>
    count > 0 ? (
      <li key={key}>{t(`campaigns.prelaunch.${key}`, { defaultValue: fallback, count })}</li>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {scheduled
              ? t('campaigns.scheduleTitle', 'Schedule this campaign?')
              : t('campaigns.prelaunch.title', 'Before you send')}
          </DialogTitle>
          <DialogDescription>
            {scheduled
              ? t('campaigns.scheduleDesc', {
                  defaultValue: 'It will be sent automatically at {{when}}.',
                  when: campaign?.scheduledAt ? new Date(campaign.scheduledAt).toLocaleString() : '',
                })
              : t('campaigns.prelaunch.desc', 'Who this campaign reaches, and which address it goes out from.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Audience */}
          {preview.isError ? (
            <Callout tone="danger">
              {t('campaigns.prelaunch.audienceFailed', 'Could not work out the audience — try again.')}
              <div className="mt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => preview.refetch()}>
                  {t('common.retry', 'Retry')}
                </Button>
              </div>
            </Callout>
          ) : !audienceKnown ? (
            <p className="text-sm text-muted-foreground">
              {t('campaigns.prelaunch.audienceLoading', 'Working out the audience…')}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                {t('campaigns.prelaunch.audience', {
                  defaultValue: '{{count}} people will be reached',
                  count: p!.matched,
                })}
              </p>
              {p!.matched === 0 && (
                <Callout tone="warning">
                  {t('campaigns.prelaunch.noRecipients', 'Nobody in this audience can be mailed.')}
                </Callout>
              )}
              {excludedTotal > 0 && (
                <div className="rounded-md border border-border p-3">
                  <p className="text-caption font-medium text-muted-foreground">
                    {t('campaigns.prelaunch.excluded', { defaultValue: '{{count}} excluded', count: excludedTotal })}
                  </p>
                  {/* The per-reason breakdown is email deliverability; the other
                      channels only have an opt-out to report, which the total
                      above already carries. */}
                  {p!.channel === 'EMAIL' && (
                    <ul className="mt-1 space-y-0.5 text-caption text-muted-foreground">
                      {excludedLine('excludedOptedOut', 'Unsubscribed: {{count}}', x!.optedOut)}
                      {excludedLine('excludedBounced', 'Hard-bounced: {{count}}', x!.bounced)}
                      {excludedLine('excludedInvalid', 'Invalid address: {{count}}', x!.invalid)}
                      {excludedLine('excludedSuppressed', 'Blocked for another reason: {{count}}', x!.suppressed)}
                      {excludedLine('excludedNoEmail', 'No email address: {{count}}', x!.noEmail)}
                    </ul>
                  )}
                  {/* The suppression half is sampled, so on a very large
                      audience the figure above is a FLOOR. Saying so is the
                      difference between a number and a guess. */}
                  {p!.truncated && (
                    <p className="mt-1 text-caption text-muted-foreground">
                      {t('campaigns.prelaunch.truncated', {
                        defaultValue:
                          'The first {{count}} addresses were checked — the audience is larger, so the excluded figure is a floor.',
                        count: SUPPRESSION_SAMPLE,
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Sender identity */}
          {p?.sender && (
            <div className="space-y-1">
              <p className="text-caption font-medium text-muted-foreground">
                {t('campaigns.prelaunch.sender', 'Sender')}
              </p>
              <p className="text-sm text-foreground">
                {p.sender.from.name} &lt;{p.sender.from.email}&gt;
              </p>
              {p.sender.transport === 'PLATFORM' && p.sender.from.replyTo && (
                <p className="text-caption text-muted-foreground">
                  {t('campaigns.prelaunch.senderPlatform', {
                    defaultValue: 'Jeeta sender — replies come back to {{replyTo}}.',
                    replyTo: p.sender.from.replyTo,
                  })}
                </p>
              )}
              {p.sender.degraded && (
                <p className="text-caption text-warning">
                  {t('campaigns.prelaunch.senderDegraded', {
                    defaultValue: 'Your own mailbox cannot be used: {{reason}}',
                    reason: t(`campaigns.prelaunch.degradedReason.${p.sender.degraded.code}`, p.sender.degraded.code),
                  })}
                </p>
              )}
              {!p.sender.ok && p.sender.reason && (
                <Callout tone="warning">
                  {t('mail.notSent', {
                    defaultValue: 'Not sent: {{reason}}',
                    reason: t(`mail.reason.${p.sender.reason}`),
                  })}
                </Callout>
              )}
            </div>
          )}

          {/* Rehearsal — the same mail, through the same gates, to the operator. */}
          {p?.channel === 'EMAIL' && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={testSend.isPending}
                disabled={testSend.isPending}
                onClick={() => testSend.mutate()}
              >
                <Send className="h-3.5 w-3.5" />
                {t('campaigns.prelaunch.testSend', 'Send a test to yourself')}
              </Button>
              <p className="mt-1 text-caption text-muted-foreground">
                {t('campaigns.prelaunch.testSendHint', 'One copy goes to you and is not counted in the stats.')}
              </p>
            </div>
          )}

          {!scheduled && (
            <p className="text-caption text-muted-foreground">
              {t('campaigns.prelaunch.irreversible', 'Once sending starts it cannot be undone.')}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            loading={launching}
            disabled={!canLaunch || launching}
          >
            {scheduled ? t('campaigns.scheduleConfirm', 'Schedule') : t('campaigns.launch', 'Launch')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { has } = useEntitlements();
  // SMS is its own feature (split off `conversationAi` for the NetGSM SMS v2
  // program) — hide it from the channel picker when the workspace isn't
  // entitled, instead of letting the create call 403 on submit. VOICE
  // (NetGSM Phase 5) is gated the same way on its own `voiceCampaigns` feature.
  const availableChannels = CHANNELS.filter(
    (c) => (c !== 'SMS' || has('sms')) && (c !== 'VOICE' || has('voiceCampaigns')),
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string>('');
  const [aiGoal, setAiGoal] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CampaignRow | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [launchTarget, setLaunchTarget] = useState<CampaignRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CampaignRow | null>(null);

  // ── Query ─────────────────────────────────────────────────────────────────
  const { data: campaigns, isError, refetch } = useQuery<CampaignRow[]>({
    queryKey: ['marketing', 'campaigns'],
    queryFn: () => marketingApi.get('/campaigns').then((r) => r.data),
    refetchInterval: 15_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'campaigns'] });

  // ── Form ──────────────────────────────────────────────────────────────────
  const form = useForm<CampaignFormValues>({
    resolver: zodResolver(campaignSchema),
    defaultValues: DEFAULT_VALUES,
  });
  const selectedChannel = useWatch({ control: form.control, name: 'channel' });
  const selectedTemplateId = useWatch({ control: form.control, name: 'emailTemplateId' });
  const bodyValue = useWatch({ control: form.control, name: 'body' }) ?? '';
  const bodySmsSegments = smsSegments(bodyValue, { reservedSuffixChars: CAMPAIGN_SMS_RESERVED_SUFFIX_CHARS });
  const scheduledAtField = useWatch({ control: form.control, name: 'scheduledAt' });
  const scheduleIsPast = isPastDatetimeLocalValue(scheduledAtField);
  const [variantsOpen, setVariantsOpen] = useState(false);

  // VOICE (NetGSM Phase 5) — TTS-text-vs-audio-upload mode + the uploaded
  // audioid (set by the file picker's mutation below).
  const voiceMode = useWatch({ control: form.control, name: 'voiceMode' });
  const voiceAudioId = useWatch({ control: form.control, name: 'voiceAudioId' });
  const voiceFileRef = useRef<HTMLInputElement>(null);
  const { fields: voiceKeyFields, append: appendVoiceKey, remove: removeVoiceKey } = useFieldArray({
    control: form.control,
    name: 'voiceKeys',
  });

  const { data: emailTemplates } = useQuery<EmailTemplateRow[]>({
    queryKey: ['marketing', 'email-templates'],
    queryFn: listEmailTemplates,
    enabled: selectedChannel === 'EMAIL',
  });

  // Attach an HTML template (fetches its compiled HTML) or clear it ('' = plain text).
  const pickTemplate = async (id: string) => {
    if (!id) {
      form.setValue('emailTemplateId', '');
      form.setValue('bodyHtml', '');
      return;
    }
    try {
      const tpl = await getEmailTemplate(id);
      form.setValue('emailTemplateId', id);
      form.setValue('bodyHtml', tpl.compiledHtml ?? '');
    } catch {
      toast.error(t('campaigns.templateLoadFailed', 'Could not load the template'));
    }
  };

  const { fields: filterFields, append: appendFilter, remove: removeFilter } = useFieldArray({
    control: form.control,
    name: 'filters',
  });
  /**
   * The audience filter as the SERVER has it, for a campaign being edited.
   *
   * The builder can only express `field op value` over five lead columns, but a
   * filter can also carry `id`, `tag`, `segmentId`, an array value or a boolean
   * `exists` — an MCP-created campaign usually does. Reading one of those into
   * the form and writing it back out rewrote it, which the backend read as an
   * audience CHANGE and used to silently cancel a scheduled send
   * (`mcp-filter-rewrite`). So an untouched filter is round-tripped exactly as
   * it was stored, and only a filter the operator actually edited is rebuilt.
   */
  const savedFilter = useRef<unknown[] | null>(null);
  // Read during render so react-hook-form's formState proxy subscribes to it.
  const filtersEdited = !!form.formState.dirtyFields.filters;

  const openCreate = () => {
    setEditId('');
    savedFilter.current = null;
    form.reset(DEFAULT_VALUES);
    setAiGoal('');
    setFormOpen(true);
  };

  const openEdit = async (c: CampaignRow) => {
    const full = await marketingApi.get(`/campaigns/${c.id}`).then((r) => r.data);
    setEditId(full.id);
    // What the campaign actually has on file, kept aside so an edit that never
    // touches the audience can send it back verbatim (see buildPayload).
    savedFilter.current = Array.isArray(full.audienceFilter) ? full.audienceFilter : [];
    form.reset({
      name: full.name,
      channel: full.channel,
      subject: full.subject ?? '',
      body: full.body,
      bodyHtml: full.bodyHtml ?? '',
      emailTemplateId: full.emailTemplateId ?? '',
      filters: (full.audienceFilter ?? []).map((f: any) => ({
        field: String(f.field).replace('lead.', ''),
        op: f.op,
        value: Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? ''),
      })),
      scheduledAt: toDatetimeLocalValue(full.scheduledAt),
      iysMessageType: full.iysMessageType === 'TICARI' ? 'TICARI' : 'BILGILENDIRME',
      // VOICE (NetGSM Phase 5) — reopen in whichever mode the saved
      // voiceConfig actually used; audioid wins if somehow both are set.
      // Keypress labels are a same-session-only aid (see voiceKeyRowSchema's
      // comment) — reopening a saved campaign shows the digits with blank notes.
      voiceMode: full.voiceConfig?.audioid ? 'AUDIO' : 'TTS',
      voiceMsg: full.voiceConfig?.msg ?? '',
      voiceAudioId: full.voiceConfig?.audioid ?? '',
      voiceKeys: Array.isArray(full.voiceConfig?.keys)
        ? full.voiceConfig.keys.map((digit: string) => ({ digit: String(digit), label: '' }))
        : [],
    });
    setAiGoal('');
    setFormOpen(true);
  };

  // Upload a .wav for a VOICE campaign's audio mode — POSTs to the Task 4
  // endpoint and stashes the returned audioid straight into the form.
  const uploadVoiceAudio = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await marketingApi.post('/campaigns/voice/audio', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return data.audioid as string;
    },
    onSuccess: (audioid) => {
      form.setValue('voiceAudioId', audioid, { shouldValidate: true });
      toast.success(t('campaigns.voiceAudioUploaded', 'Audio uploaded'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.voiceAudioUploadFailed', 'Upload failed')),
    onSettled: () => {
      if (voiceFileRef.current) voiceFileRef.current.value = '';
    },
  });

  // ── Mutations ─────────────────────────────────────────────────────────────
  const buildPayload = (values: CampaignFormValues) => ({
    name: values.name,
    channel: values.channel,
    // Send '' (not undefined) when cleared so an edit actually CLEARS the subject
    // — the backend maps '' → null (like bodyHtml/emailTemplateId below). Sending
    // undefined would leave the stale subject in the DB.
    subject: values.subject || '',
    // The backend requires a non-empty body; when an HTML template is attached
    // and the operator left the plain-text field blank, derive it from the HTML
    // so attaching a template never blocks the save.
    body: plainTextBody(values.body, values.channel === 'EMAIL' ? values.bodyHtml : ''),
    // Always send these (as '' when cleared) so the backend actually CLEARS a
    // previously-attached template — sending undefined would leave the stale
    // HTML in the DB and keep shipping it. The service maps '' → null.
    bodyHtml: values.channel === 'EMAIL' ? (values.bodyHtml || '') : '',
    emailTemplateId: values.channel === 'EMAIL' ? (values.emailTemplateId || '') : '',
    // Verbatim when untouched (see `savedFilter`); rebuilt only when the
    // operator edited the rules. Nothing is dropped here any more — the schema
    // refuses a half-written rule instead.
    audienceFilter:
      savedFilter.current && !filtersEdited
        ? savedFilter.current
        : values.filters.map((f) => ({
            field: `lead.${f.field}`,
            op: f.op,
            value: f.op === 'in' ? f.value.split(',').map((s) => s.trim()) : f.value,
          })),
    // Backend validates this with @IsDateString(), which (unlike @IsString()
    // above) does NOT treat '' as "skip validation" — only null/undefined do.
    // So clearing the picker must send null, not ''.
    scheduledAt: values.scheduledAt ? new Date(values.scheduledAt).toISOString() : null,
    // Meaningful for SMS/VOICE only — the service itself also normalizes any
    // other channel back to BILGILENDIRME, but sending the honest value only
    // for those two keeps the payload legible.
    iysMessageType:
      values.channel === 'SMS' || values.channel === 'VOICE' ? values.iysMessageType : 'BILGILENDIRME',
    // VOICE (NetGSM Phase 5) — msg XOR audioid (per the currently-selected
    // mode) + the configured DTMF digits (deduped; labels are UI-only, see
    // voiceKeyRowSchema). Omitted entirely for every other channel — the
    // backend forces voiceConfig to null there regardless.
    ...(values.channel === 'VOICE'
      ? {
          voiceConfig: {
            ...(values.voiceMode === 'TTS' ? { msg: values.voiceMsg?.trim() || undefined } : {}),
            ...(values.voiceMode === 'AUDIO' ? { audioid: values.voiceAudioId?.trim() || undefined } : {}),
            keys: Array.from(new Set(values.voiceKeys.map((k) => k.digit).filter(Boolean))),
          },
        }
      : {}),
  });

  const save = useMutation({
    mutationFn: (values: CampaignFormValues) =>
      editId
        ? marketingApi.patch(`/campaigns/${editId}`, buildPayload(values))
        : marketingApi.post('/campaigns', buildPayload(values)),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      toast.success(t('campaigns.saved', 'Campaign saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.saveFailed', 'Save failed')),
  });

  const compose = useMutation({
    mutationFn: () =>
      marketingApi.post('/ai/compose', {
        kind:
          selectedChannel === 'EMAIL'
            ? 'email'
            : selectedChannel === 'SMS'
              ? 'sms'
              : 'social',
        goal: aiGoal,
      }),
    onSuccess: ({ data }) => {
      if (data.subject) form.setValue('subject', data.subject);
      if (data.body) {
        // For a VOICE campaign the spoken text is `voiceMsg`; `body` is only an
        // internal, not-read-aloud label. Route generated copy to the field that
        // the call actually uses so the AI output isn't silently lost.
        if (selectedChannel === 'VOICE') {
          form.setValue('voiceMsg', data.body, { shouldValidate: true });
        } else {
          form.setValue('body', data.body);
        }
      }
      toast.success(t('campaigns.composed', 'Draft ready'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.composeFailed', 'Compose failed')),
  });

  const launch = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/campaigns/${id}/launch`),
    onSuccess: ({ data }) => {
      invalidate();
      setLaunchTarget(null);
      // A future scheduledAt on the campaign made this a SCHEDULE, not an
      // immediate send — the backend reports which one happened (data.scheduledAt
      // is only set on the SCHEDULED path).
      if (data.scheduledAt) {
        toast.success(
          t('campaigns.scheduled', { defaultValue: 'Scheduled for {{when}}', when: new Date(data.scheduledAt).toLocaleString() }),
        );
      } else {
        toast.success(t('campaigns.launched', `Launched to ${data.recipients} recipients`));
      }
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.launchFailed', 'Launch failed')),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      marketingApi.post(`/campaigns/${id}/${action}`),
    onSuccess: invalidate,
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.actionFailed', 'Action failed')),
  });

  // Cancel a SCHEDULED (not yet sending) campaign's queued send — its own
  // mutation (not the generic `act`) so the confirm dialog gets a dedicated
  // loading state and success/error toast, matching the `launch` mutation.
  const cancelScheduled = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/campaigns/${id}/cancel`),
    onSuccess: () => {
      invalidate();
      setCancelTarget(null);
      toast.success(t('campaigns.cancelScheduledSuccess', 'Scheduled send cancelled'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('campaigns.cancelScheduledFailed', 'Could not cancel the scheduled send')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/campaigns/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('campaigns.title', 'Campaigns')}
        description={t(
          'campaigns.subtitle',
          'Blast email, SMS or WhatsApp to a filtered slice of your leads. Opt-outs and an unsubscribe link are handled for you.',
        )}
        actions={
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('campaigns.new', 'New campaign')}
          </Button>
        }
      />

      {/* ── Create/Edit dialog ───────────────────────────────────────────── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editId
                ? t('campaigns.editTitle', 'Edit campaign')
                : t('campaigns.new', 'New campaign')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'campaigns.formHint',
                'Build your message and target audience. Opt-outs are handled automatically.',
              )}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Name */}
              <div className="sm:col-span-2">
                <Field
                  label={t('campaigns.name', 'Name')}
                  error={form.formState.errors.name?.message}
                  required
                >
                  {({ id, invalid }) => (
                    <Input
                      id={id}
                      aria-invalid={invalid}
                      maxLength={120}
                      {...form.register('name')}
                    />
                  )}
                </Field>
              </div>

              {/* Channel */}
              <Field label={t('campaigns.channel', 'Channel')}>
                {({ id }) => (
                  <Controller
                    control={form.control}
                    name="channel"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(v) => {
                          field.onChange(v);
                          // Drop any attached EMAIL template when leaving EMAIL so
                          // its HTML can't satisfy the body requirement for a
                          // channel that never sends HTML.
                          if (v !== 'EMAIL') {
                            form.setValue('bodyHtml', '');
                            form.setValue('emailTemplateId', '');
                          }
                        }}
                      >
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableChannels.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>
            </div>

            {/* Schedule (optional) — leave blank to send immediately on Launch */}
            <Field
              label={t('campaigns.scheduledAt', 'Send at (optional)')}
              hint={
                scheduleIsPast
                  ? t('campaigns.scheduleInPast', 'This time is in the past — the campaign will be sent immediately.')
                  : t('campaigns.scheduledAtHint', 'Leave blank to send immediately when you launch.')
              }
            >
              {({ id }) => (
                <Input
                  id={id}
                  type="datetime-local"
                  min={nowDatetimeLocalValue()}
                  {...form.register('scheduledAt')}
                />
              )}
            </Field>

            {/* Audience filter builder */}
            <div>
              <p className="text-caption font-medium text-muted-foreground mb-2">
                {t(
                  'campaigns.audience',
                  'Audience (leads matching all rules; empty = everyone opted-in)',
                )}
              </p>
              <div className="space-y-2">
                {filterFields.map((f, i) => {
                  const rowError =
                    form.formState.errors.filters?.[i]?.field?.message ??
                    form.formState.errors.filters?.[i]?.value?.message;
                  return (
                  <div key={f.id} className="space-y-1">
                    <div className="flex flex-wrap gap-2">
                    {/* Field select */}
                    <Controller
                      control={form.control}
                      name={`filters.${i}.field`}
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="flex-1 min-w-[8rem]" aria-invalid={!!rowError}>
                            <SelectValue placeholder={t('campaigns.field', 'field')} />
                          </SelectTrigger>
                          <SelectContent>
                            {FILTER_FIELDS.map((x) => (
                              <SelectItem key={x} value={x}>
                                {x}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {/* Op select */}
                    <Controller
                      control={form.control}
                      name={`filters.${i}.op`}
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(op) => {
                            field.onChange(op);
                            // `exists` is a boolean: seed a real choice rather
                            // than leaving the row in an invalid in-between
                            // state, and clear a stale text value on the way
                            // back out.
                            const current = form.getValues(`filters.${i}.value`);
                            if (op === 'exists' && !EXISTS_VALUES.includes(current as any)) {
                              form.setValue(`filters.${i}.value`, 'true', { shouldDirty: true });
                            } else if (op !== 'exists' && EXISTS_VALUES.includes(current as any)) {
                              form.setValue(`filters.${i}.value`, '', { shouldDirty: true });
                            }
                          }}
                        >
                          <SelectTrigger className="w-24">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {OPS.map((x) => (
                              <SelectItem key={x} value={x}>
                                {x}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {/* Value — a two-option select for `exists`, free text otherwise. */}
                    <Controller
                      control={form.control}
                      name={`filters.${i}.value`}
                      render={({ field }) =>
                        form.watch(`filters.${i}.op`) === 'exists' ? (
                          <Select value={field.value || 'true'} onValueChange={field.onChange}>
                            <SelectTrigger className="flex-1 min-w-[8rem]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="true">{t('common.yes', 'Yes')}</SelectItem>
                              <SelectItem value="false">{t('common.no', 'No')}</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            placeholder={t('campaigns.value', 'value')}
                            className="flex-1 min-w-[8rem]"
                            aria-invalid={!!rowError}
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                          />
                        )
                      }
                    />
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove rule"
                      className="text-danger hover:bg-danger-subtle"
                      onClick={() => removeFilter(i)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                    </div>
                    {rowError && (
                      <p role="alert" className="text-caption text-danger">
                        {t('common.required', 'Required')}
                      </p>
                    )}
                  </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => appendFilter({ field: '', op: 'eq', value: '' })}
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  {t('campaigns.addRule', 'Add rule')}
                </button>
              </div>
            </div>

            <Separator />

            {/* AI compose */}
            <Callout tone="info">
              <div className="flex items-center gap-1 mb-1.5 font-medium text-sm">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {t('campaigns.aiCompose', 'AI copywriter')}
              </div>
              <div className="flex gap-2">
                <Input
                  value={aiGoal}
                  onChange={(e) => setAiGoal(e.target.value)}
                  placeholder={t(
                    'campaigns.aiGoal',
                    'Goal — e.g. announce a 20% spring discount',
                  )}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => compose.mutate()}
                  disabled={!aiGoal.trim() || compose.isPending}
                  loading={compose.isPending}
                  className="shrink-0"
                >
                  {t('campaigns.write', 'Write')}
                </Button>
              </div>
            </Callout>

            {/* İYS message type (SMS/VOICE) — legal classification the sender's
                pre-send preflight hard-blocks on for TİCARİ (ARAMA consent for
                VOICE, MESAJ consent for SMS). */}
            {(selectedChannel === 'SMS' || selectedChannel === 'VOICE') && (
              <Field
                label={t('campaigns.iysMessageType', 'İYS message type')}
                hint={
                  form.watch('iysMessageType') === 'TICARI'
                    ? t(
                        'campaigns.iysMessageTypeTicariHint',
                        'Commercial (ads/promotions) — requires İYS consent. Recipients without approval are skipped automatically before sending.',
                      )
                    : t(
                        'campaigns.iysMessageTypeBilgiHint',
                        'Informational (order/appointment/account updates) — exempt from İYS consent.',
                      )
                }
              >
                {({ id }) => (
                  <Controller
                    control={form.control}
                    name="iysMessageType"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="BILGILENDIRME">
                            {t('campaigns.iysBilgilendirme', 'Bilgilendirme (informational)')}
                          </SelectItem>
                          <SelectItem value="TICARI">
                            {t('campaigns.iysTicari', 'Ticari (commercial)')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>
            )}

            {/* VOICE (NetGSM Phase 5) — TTS text OR uploaded .wav, then a
                keypress→note mapping editor for press-N branch capture. */}
            {selectedChannel === 'VOICE' && (
              <div className="space-y-4 rounded-lg border border-border p-4">
                <Field
                  label={t('campaigns.voiceMode', 'Voice message type')}
                  hint={t(
                    'campaigns.voiceModeHint',
                    'Play a built-in text-to-speech message, or upload a pre-recorded .wav.',
                  )}
                >
                  {({ id }) => (
                    <Controller
                      control={form.control}
                      name="voiceMode"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id={id}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="TTS">{t('campaigns.voiceModeTts', 'Text-to-speech')}</SelectItem>
                            <SelectItem value="AUDIO">{t('campaigns.voiceModeAudio', 'Upload audio file')}</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  )}
                </Field>

                {voiceMode === 'TTS' && (
                  <Field
                    label={t('campaigns.voiceMsg', 'Spoken text (TTS)')}
                    error={form.formState.errors.voiceMsg?.message}
                    required
                  >
                    {({ id, invalid }) => (
                      <Textarea
                        id={id}
                        aria-invalid={invalid}
                        className="min-h-24"
                        maxLength={2000}
                        placeholder={t('campaigns.voiceMsgPlaceholder', 'Hello {{lead.contactPerson}}, this is…')}
                        {...form.register('voiceMsg')}
                      />
                    )}
                  </Field>
                )}

                {voiceMode === 'AUDIO' && (
                  <Field
                    label={t('campaigns.voiceAudio', 'Audio file (.wav, max 4MB)')}
                    error={form.formState.errors.voiceAudioId?.message}
                    required
                  >
                    {() => (
                      <div className="flex items-center gap-2">
                        <input
                          ref={voiceFileRef}
                          type="file"
                          accept=".wav,audio/wav,audio/x-wav,audio/wave"
                          hidden
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) uploadVoiceAudio.mutate(file);
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          loading={uploadVoiceAudio.isPending}
                          onClick={() => voiceFileRef.current?.click()}
                        >
                          <Upload className="h-4 w-4" aria-hidden="true" />
                          {t('campaigns.voiceAudioUpload', 'Upload .wav')}
                        </Button>
                        {voiceAudioId ? (
                          <Badge tone="success" size="sm">
                            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                            {t('campaigns.voiceAudioReady', 'Audio ready')}
                          </Badge>
                        ) : null}
                      </div>
                    )}
                  </Field>
                )}

                {/* Keypress→note mapping — only the digit is persisted
                    (voiceConfig.keys); the note is a same-session aid for
                    setting up the matching voice_keypress workflow trigger
                    on the Automations page. */}
                <div>
                  <p className="text-caption font-medium text-muted-foreground mb-2">
                    {t('campaigns.voiceKeys', 'Keypress actions (press-N)')}
                  </p>
                  <p className="text-caption text-muted-foreground mb-2">
                    {t(
                      'campaigns.voiceKeysHint',
                      'Callers pressing a mapped digit fire a voice_keypress trigger you can react to in Automations. Notes here are just for your reference.',
                    )}
                  </p>
                  <div className="space-y-2">
                    {voiceKeyFields.map((f, i) => (
                      <div key={f.id} className="flex flex-wrap gap-2">
                        <Controller
                          control={form.control}
                          name={`voiceKeys.${i}.digit`}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={field.onChange}>
                              <SelectTrigger className="w-20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {VOICE_DIGITS.map((d) => (
                                  <SelectItem key={d} value={d}>{d}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                        <Input
                          placeholder={t('campaigns.voiceKeyLabel', 'Note (optional) — e.g. interested, connect to sales')}
                          className="flex-1 min-w-[10rem]"
                          maxLength={200}
                          {...form.register(`voiceKeys.${i}.label`)}
                        />
                        <IconButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t('campaigns.removeKeyMapping', 'Remove mapping')}
                          className="text-danger hover:bg-danger-subtle"
                          onClick={() => removeVoiceKey(i)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={voiceKeyFields.length >= 10}
                      onClick={() => appendVoiceKey({ digit: '1', label: '' })}
                      className="text-xs text-primary hover:underline flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus className="h-3 w-3" aria-hidden="true" />
                      {t('campaigns.addKeyMapping', 'Add keypress mapping')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Subject (EMAIL only) — required: the sender's "Update" default
                was never meant to be what a recipient sees. */}
            {selectedChannel === 'EMAIL' && (
              <Field
                label={t('campaigns.subject', 'Subject')}
                required
                error={form.formState.errors.subject?.message ? t('common.required', 'Required') : undefined}
              >
                {({ id, invalid }) => (
                  <Input id={id} aria-invalid={invalid} maxLength={200} {...form.register('subject')} />
                )}
              </Field>
            )}

            {/* HTML email template (EMAIL only) */}
            {selectedChannel === 'EMAIL' && (
              <Field label={t('campaigns.emailTemplate', 'HTML template (optional)')}>
                {({ id }) => (
                  <div className="flex items-center gap-2">
                    <Select value={selectedTemplateId || '__none__'} onValueChange={(v) => pickTemplate(v === '__none__' ? '' : v)}>
                      <SelectTrigger id={id} className="flex-1">
                        <SelectValue placeholder={t('campaigns.plainText', 'Plain text only')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t('campaigns.plainText', 'Plain text only')}</SelectItem>
                        {(emailTemplates ?? []).map((tpl) => (
                          <SelectItem key={tpl.id} value={tpl.id}>{tpl.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {form.watch('bodyHtml') ? (
                      <Badge tone="success" size="sm">{t('campaigns.htmlAttached', 'HTML attached')}</Badge>
                    ) : null}
                  </div>
                )}
              </Field>
            )}

            {/* A/B test (EMAIL, existing draft only — variants are a sub-resource) */}
            {selectedChannel === 'EMAIL' && editId && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setVariantsOpen(true)}>
                  {t('campaigns.abTest', 'A/B test…')}
                </Button>
                <VariantsDialog campaignId={editId} open={variantsOpen} onOpenChange={setVariantsOpen} />
              </div>
            )}

            {/* Body — when an HTML template is attached this is an OPTIONAL
                plain-text fallback (auto-derived from the HTML if left blank). */}
            {(() => {
              const htmlAttached = selectedChannel === 'EMAIL' && !!form.watch('bodyHtml');
              return (
                <Field
                  label={htmlAttached
                    ? t('campaigns.bodyPlainFallback', 'Plain-text fallback')
                    : selectedChannel === 'VOICE'
                      ? t('campaigns.bodyVoiceLabel', 'Internal label')
                      : t('campaigns.body', 'Message')}
                  hint={htmlAttached
                    ? t('campaigns.bodyPlainFallbackHint', 'Optional — auto-generated from your template if left blank.')
                    : selectedChannel === 'VOICE'
                      ? t('campaigns.bodyVoiceHint', 'For your reference only — not read aloud. The spoken message is set above.')
                      : undefined}
                  error={form.formState.errors.body?.message}
                  required={!htmlAttached}
                >
                  {({ id, invalid }) => (
                    <>
                      <Textarea
                        id={id}
                        aria-invalid={invalid}
                        className="min-h-40"
                        maxLength={20000}
                        placeholder="Hi {{lead.contactPerson}}, …"
                        {...form.register('body')}
                      />
                      {selectedChannel === 'SMS' && (
                        <p className="text-caption text-muted-foreground mt-1">
                          {t('campaigns.smsCounter', {
                            defaultValue: '{{chars}} characters · {{segments}} segment{{plural}}',
                            chars: bodyValue.length,
                            segments: bodySmsSegments,
                            plural: bodySmsSegments === 1 ? '' : 's',
                          })}
                        </p>
                      )}
                    </>
                  )}
                </Field>
              );
            })()}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={save.isPending}>
                {t('common.save', 'Save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ─────────────────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('campaigns.deleteTitle', 'Delete campaign?')}
        description={t(
          'campaigns.deleteDesc',
          'Sent stats will be lost. This cannot be undone.',
        )}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />

      {/* ── Campaign detail (recipients + delivery stats) ──────────────────── */}
      <CampaignDetailDialog campaignId={detailId} onClose={() => setDetailId(null)} />

      {/* ── Pre-launch sheet ───────────────────────────────────────────────── */}
      {/* Launching sends the campaign to its whole audience right away (and
          can't be undone / costs message quota), so it is guarded by a sheet
          that first says WHO it reaches, who was left out and why, which
          address it leaves from, and offers one copy to the operator. When the
          campaign has a future "Send at" set, launch() SCHEDULES it instead —
          the copy reflects that rather than implying an instant send. */}
      <CampaignLaunchSheet
        campaign={launchTarget}
        onCancel={() => setLaunchTarget(null)}
        onConfirm={() => launchTarget && launch.mutate(launchTarget.id)}
        launching={launch.isPending}
      />

      {/* ── Cancel scheduled send confirm ───────────────────────────────────── */}
      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(o) => { if (!o) setCancelTarget(null); }}
        title={t('campaigns.cancelScheduledTitle', 'Cancel scheduled send?')}
        description={t(
          'campaigns.cancelScheduledDesc',
          'The campaign will not go out at its scheduled time. You can launch it manually later.',
        )}
        confirmLabel={t('campaigns.cancelScheduledConfirm', 'Cancel send')}
        tone="danger"
        loading={cancelScheduled.isPending}
        onConfirm={() => cancelTarget && cancelScheduled.mutate(cancelTarget.id)}
      />

      {/* ── Campaign list ─────────────────────────────────────────────────── */}
      <QueryStateBoundary
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('common.loadError', 'Could not load. Please try again.')}
      />

      {!isError && (
      <div className="space-y-3">
        {(campaigns ?? []).map((c) => (
          <Card key={c.id}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Megaphone className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground truncate">{c.name}</span>
                      <Badge tone="neutral" size="sm" className="uppercase">
                        {c.channel}
                      </Badge>
                      <Badge tone={campaignStatusTone(c.status)} size="sm">
                        {c.status}
                      </Badge>
                    </div>
                    {c.status === 'SCHEDULED' && c.scheduledAt && (
                      <p className="text-caption text-muted-foreground mt-0.5">
                        {t('campaigns.scheduledFor', {
                          defaultValue: 'Scheduled for {{when}}',
                          when: new Date(c.scheduledAt).toLocaleString(),
                        })}
                      </p>
                    )}
                    {c.stats && (
                      <p className="text-caption text-muted-foreground mt-0.5">
                        {c.stats.sent ?? 0}/{c.stats.recipients ?? 0}{' '}
                        {t('campaigns.sent', 'sent')} ·{' '}
                        {c.stats.opened ?? 0} {t('campaigns.opened', 'opened')} ·{' '}
                        {c.stats.clicked ?? 0} {t('campaigns.clicked', 'clicked')} ·{' '}
                        {c.stats.unsubscribed ?? 0} {t('campaigns.unsub', 'unsub')}
                      </p>
                    )}
                    {/* İYS visibility (NetGSM Phase 2 Task 6): iysBlocked is a
                        per-recipient RET/YOK/invalid-phone tally (BİLGİLENDİRME
                        campaigns never bump it); iysUnavailable means a TİCARİ
                        tick aborted closed (nothing sent) — surfaced here so an
                        operator doesn't have to open the detail dialog to learn
                        why a TİCARİ campaign looks stalled. */}
                    {!!c.stats?.iysBlocked && (
                      <p className="text-caption text-warning mt-0.5">
                        {t('campaigns.iysBlockedLabel', 'İYS engelli')}: {c.stats.iysBlocked}
                      </p>
                    )}
                    {!!c.stats?.iysUnavailable && (
                      <p className="text-caption text-danger mt-0.5">
                        {t('campaigns.iysUnavailableLabel', 'İYS erişilemedi')}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {c.status === 'DRAFT' && (
                    <Button size="sm" onClick={() => setLaunchTarget(c)} loading={launch.isPending && launch.variables === c.id}>
                      <Send className="h-3.5 w-3.5" />
                      {t('campaigns.launch', 'Launch')}
                    </Button>
                  )}
                  {c.status === 'SENDING' && (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={t('campaigns.pause', 'Pause')}
                      onClick={() => act.mutate({ id: c.id, action: 'pause' })}
                      disabled={act.isPending && act.variables?.id === c.id}
                    >
                      <Pause className="h-5 w-5" />
                    </IconButton>
                  )}
                  {c.status === 'PAUSED' && (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={t('campaigns.resume', 'Resume')}
                      onClick={() => act.mutate({ id: c.id, action: 'resume' })}
                      disabled={act.isPending && act.variables?.id === c.id}
                    >
                      <Play className="h-5 w-5" />
                    </IconButton>
                  )}
                  {c.status === 'SCHEDULED' && (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label={t('campaigns.cancelScheduled', 'Cancel scheduled send')}
                      className="text-danger hover:bg-danger-subtle"
                      onClick={() => setCancelTarget(c)}
                      disabled={cancelScheduled.isPending && cancelTarget?.id === c.id}
                    >
                      <XCircle className="h-5 w-5" />
                    </IconButton>
                  )}
                  {/* SCHEDULED is editable too (backend allows it) — this is how an
                      operator reschedules or clears the "Send at" time; clearing it
                      reverts the campaign to DRAFT (see CampaignsService.update). */}
                  {(c.status === 'DRAFT' || c.status === 'SCHEDULED') && (
                    <Button variant="outline" size="sm" onClick={() => openEdit(c)}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t('common.edit', 'Edit')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setDetailId(c.id)}>
                    <BarChart3 className="h-3.5 w-3.5" />
                    {t('campaigns.details', 'Details')}
                  </Button>
                  <CampaignSocialLinkButton campaignId={c.id} />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('common.delete', 'Delete')}
                    className="text-danger hover:bg-danger-subtle"
                    onClick={() => setDeleteTarget(c)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {(campaigns ?? []).length === 0 && (
          <EmptyState
            icon={<Megaphone className="h-10 w-10" />}
            title={t('campaigns.emptyTitle', 'No campaigns yet')}
            description={t(
              'campaigns.empty',
              'No campaigns yet — create one and let AI write the copy.',
            )}
            action={
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                {t('campaigns.new', 'New campaign')}
              </Button>
            }
          />
        )}
      </div>
      )}
    </div>
  );
}
