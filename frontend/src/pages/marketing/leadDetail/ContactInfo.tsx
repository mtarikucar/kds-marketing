import { Phone, Mail, MapPin, MessageCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
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
