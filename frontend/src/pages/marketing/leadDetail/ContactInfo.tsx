import { useTranslation } from 'react-i18next';
import { Phone, Mail, MapPin, MessageCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { AssignCell } from '../../../features/marketing/components';
import {
  LeadStatus,
  LEAD_STATUS_LABELS,
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
  isManager: boolean;
  fmtDate: (d: string | Date | null | undefined) => string;
  onAssigned: () => void;
  onStatusChange: (status: string) => void;
  statusPending: boolean;
}

/** Left-rail summary cards: contact, business details, assignment, status, notes. */
export default function ContactInfo({
  lead,
  isManager,
  fmtDate,
  onAssigned,
  onStatusChange,
  statusPending,
}: ContactInfoProps) {
  const { t } = useTranslation('marketing');

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
            {lead.assignedTo && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Assigned To</dt>
                <dd className="text-foreground">
                  {lead.assignedTo.firstName} {lead.assignedTo.lastName}
                </dd>
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

      {/* Assign (Manager only) — compact inline popover so the rest
          of the panel still serves as the lead's info hub. */}
      {isManager && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('leads.assignment.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <AssignCell
              leadId={lead.id}
              currentAssignee={lead.assignedTo ?? null}
              onAssigned={onAssigned}
            />
          </CardContent>
        </Card>
      )}

      {/* Status Change */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Change Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {/* WON is owned by the /convert flow on the backend
                (marketing-leads.service.ts:295-299) — exposing a WON
                button here just produced a 400 every time. */}
            {Object.values(LeadStatus)
              .filter((s) => s !== LeadStatus.WON)
              .map((s) => {
                const active = lead.status === s;
                return (
                  <Button
                    key={s}
                    type="button"
                    variant={active ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => onStatusChange(s)}
                    disabled={active || statusPending}
                    className={
                      active
                        ? 'rounded-full bg-primary/15 text-primary hover:bg-primary/15'
                        : 'rounded-full'
                    }
                  >
                    {LEAD_STATUS_LABELS[s]}
                  </Button>
                );
              })}
          </div>
        </CardContent>
      </Card>

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
