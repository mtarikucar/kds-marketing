import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Phone, Mail, MapPin, MessageCircle, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Button,
  Field,
  Input,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Badge,
} from '@/components/ui';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import { verifyLeadPhoneStart, verifyLeadPhoneConfirm } from '../../../features/marketing/api/leads.service';
import {
  BUSINESS_TYPE_LABELS,
  LEAD_SOURCE_LABELS,
} from '../../../features/marketing/types';
import type { DetailLead } from './types';

// RFC 5321 / 5322 lite: enough to catch typos (missing @, leading dot,
// trailing whitespace) without falsely rejecting real addresses. Full
// validation happens on the server when /convert is called.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ContactInfoProps {
  lead: DetailLead;
  fmtDate: (d: string | Date | null | undefined) => string;
}

function apiErrorMessage(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

/**
 * NetGSM SMS v2 Task 12 — "Verify phone" for a lead's phone number, behind
 * the `smsOtp` add-on. Texts a 6-digit code (SmsOtpService) on open; the
 * dialog's confirm step stamps `lead.phoneVerifiedAt` on success. Hidden
 * entirely when the workspace isn't entitled (no add-on purchased) or the
 * lead has no phone on file; once verified, the button is replaced by a
 * static "Verified" badge (re-editing the phone clears the stamp server-side).
 */
function VerifyPhoneControl({ lead }: { lead: DetailLead }) {
  const { t } = useTranslation('marketing');
  const { has } = useEntitlements();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');

  const startMutation = useMutation({
    mutationFn: () => verifyLeadPhoneStart(lead.id),
    onSuccess: () => {
      setCode('');
      setOpen(true);
    },
    onError: (e) =>
      toast.error(
        apiErrorMessage(e, t('leadDetail.verifyPhone.sendError', { defaultValue: 'Could not send the code' })),
      ),
  });

  const confirmMutation = useMutation({
    mutationFn: () => verifyLeadPhoneConfirm(lead.id, code),
    onSuccess: () => {
      setOpen(false);
      setCode('');
      qc.invalidateQueries({ queryKey: ['marketing', 'lead', lead.id] });
      toast.success(t('leadDetail.verifyPhone.verified', { defaultValue: 'Phone number verified' }));
    },
    onError: (e) =>
      toast.error(
        apiErrorMessage(e, t('leadDetail.verifyPhone.invalidCode', { defaultValue: 'Invalid code' })),
      ),
  });

  if (!has('smsOtp') || !lead.phone) return null;

  if (lead.phoneVerifiedAt) {
    return (
      <Badge tone="success" className="gap-1">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {t('leadDetail.verifyPhone.badge', { defaultValue: 'Verified' })}
      </Badge>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        loading={startMutation.isPending}
        onClick={() => startMutation.mutate()}
      >
        <ShieldQuestion className="h-3.5 w-3.5" aria-hidden="true" />
        {t('leadDetail.verifyPhone.button', { defaultValue: 'Verify phone' })}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('leadDetail.verifyPhone.dialogTitle', { defaultValue: 'Verify phone number' })}</DialogTitle>
            <DialogDescription>
              {t('leadDetail.verifyPhone.dialogDesc', {
                defaultValue: 'We texted a 6-digit code to {{phone}}. Enter it below to confirm this number.',
                phone: lead.phone,
              })}
            </DialogDescription>
          </DialogHeader>
          <Field
            label={t('leadDetail.verifyPhone.codeLabel', { defaultValue: 'Verification code' })}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                className="max-w-[12rem]"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate()}
            >
              {t('leadDetail.verifyPhone.resend', { defaultValue: 'Resend code' })}
            </Button>
            <Button
              type="button"
              loading={confirmMutation.isPending}
              disabled={code.trim().length === 0}
              onClick={() => confirmMutation.mutate()}
            >
              {t('leadDetail.verifyPhone.confirm', { defaultValue: 'Confirm' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Left-rail summary cards: contact, business details, notes. Trimmed (2026-07):
 * assignment and status each live in ONE place now — the page header's
 * AssignCell and its legal-transitions status Select. The old rail showed
 * assignment in 3 places and an 8-pill status card where most pills were
 * illegal moves that 400'd.
 */
export default function ContactInfo({ lead, fmtDate }: ContactInfoProps) {
  return (
    <div className="space-y-4">
      {/* Contact Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Contact Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {lead.phone && (
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-muted-foreground" />
              <a href={`tel:${lead.phone}`} className="text-primary hover:underline">
                {lead.phone}
              </a>
              <VerifyPhoneControl lead={lead} />
            </div>
          )}
          {lead.whatsapp && (
            <div className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-success" />
              <a
                href={`https://wa.me/${lead.whatsapp.replace(/\D/g, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-success hover:underline"
              >
                WhatsApp
              </a>
            </div>
          )}
          {lead.email && (
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              {/* Only build a mailto: for a well-formed address, and encode
                  it — an unvalidated email could carry header-injection
                  payload (newlines, extra recipients) into the link. */}
              {EMAIL_RE.test(lead.email) ? (
                <a
                  href={`mailto:${encodeURIComponent(lead.email)}`}
                  className="text-primary hover:underline"
                >
                  {lead.email}
                </a>
              ) : (
                <span className="text-muted-foreground">{lead.email}</span>
              )}
            </div>
          )}
          {(lead.city || lead.address) && (
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                {lead.city}
                {lead.address ? `, ${lead.address}` : ''}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Business Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Business Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Type</dt>
              <dd className="text-foreground">
                {BUSINESS_TYPE_LABELS[lead.businessType as keyof typeof BUSINESS_TYPE_LABELS] ||
                  lead.businessType}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="text-foreground">
                {LEAD_SOURCE_LABELS[lead.source as keyof typeof LEAD_SOURCE_LABELS] || lead.source}
              </dd>
            </div>
            {lead.tableCount != null && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tables</dt>
                <dd className="text-foreground">{lead.tableCount}</dd>
              </div>
            )}
            {lead.branchCount != null && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Branches</dt>
                <dd className="text-foreground">{lead.branchCount}</dd>
              </div>
            )}
            {lead.currentSystem && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Current System</dt>
                <dd className="text-foreground">{lead.currentSystem}</dd>
              </div>
            )}
            {lead.nextFollowUp && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Next Follow-up</dt>
                <dd className="text-foreground">{fmtDate(lead.nextFollowUp)}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Ad / UTM attribution — where this lead actually came from. Only the
          captured, non-empty signals are shown; absent for leads with no
          click/UTM origin. */}
      {lead.attribution && (() => {
        const a = lead.attribution;
        const rows: Array<[string, string | null]> = [
          ['Campaign', a.utmCampaign],
          ['Source', a.utmSource],
          ['Medium', a.utmMedium],
          ['Content', a.utmContent],
          ['Term', a.utmTerm],
          ['Click ID', a.clickId ? `${a.clickIdType ?? 'CLICK'}: ${a.clickId}` : null],
          ['WhatsApp Ad', a.ctwaClid],
          ['Ad Campaign', a.sourceAdCampaignId],
          ['Ad Creative', a.sourceAdCreativeId],
          ['Landing Page', a.landingUrl],
          ['Referrer', a.referrerUrl],
        ];
        const shown = rows.filter(([, v]) => v != null && v !== '');
        if (shown.length === 0) return null;
        return (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Attribution</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                {shown.map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{label}</dt>
                    <dd className="truncate text-right text-foreground" title={value ?? undefined}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        );
      })()}

      {lead.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{lead.notes}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
