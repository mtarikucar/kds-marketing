import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, Badge, IconButton } from '@/components/ui';

interface Lead {
  id: string;
  businessName?: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  status?: string;
}

interface LeadContextPaneProps {
  lead: Lead | null | undefined;
  /** When set, renders as a modal sheet (mobile/tablet) with close button. */
  asSheet?: boolean;
  onClose?: () => void;
}

/**
 * Lead context panel — shown inline at lg+ and as a bottom-sheet on smaller
 * screens. Pure presentational; receives the lead data from the parent.
 */
export function LeadContextPane({ lead, asSheet, onClose }: LeadContextPaneProps) {
  const { t } = useTranslation('marketing');

  const body = lead ? (
    <div className="space-y-2 text-sm">
      {lead.businessName && (
        <p className="font-medium text-foreground">{lead.businessName}</p>
      )}
      {lead.contactPerson && (
        <p className="text-muted-foreground">{lead.contactPerson}</p>
      )}
      {lead.phone && (
        <p className="text-xs text-muted-foreground">{lead.phone}</p>
      )}
      {lead.email && (
        <p className="text-xs text-muted-foreground">{lead.email}</p>
      )}
      {lead.status && (
        <div>
          <Badge tone="neutral">{lead.status}</Badge>
        </div>
      )}
      <a
        href={`/leads/${lead.id}`}
        className="text-primary text-xs hover:underline inline-block mt-1"
      >
        {t('inbox.openLead', 'Open lead →')}
      </a>
    </div>
  ) : (
    <p className="text-xs text-muted-foreground">
      {t('inbox.noLead', 'Select a conversation.')}
    </p>
  );

  if (asSheet) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center lg:hidden">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="relative bg-surface w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 max-h-[80vh] overflow-y-auto border border-border shadow-xl">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t('inbox.context', 'Lead')}
            </h3>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={t('common.close', 'Close')}
              onClick={onClose}
            >
              <X className="w-4 h-4" />
            </IconButton>
          </div>
          {body}
        </div>
      </div>
    );
  }

  return (
    <Card className="hidden lg:flex lg:w-64 lg:shrink-0 flex-col overflow-y-auto">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t('inbox.context', 'Lead')}
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
