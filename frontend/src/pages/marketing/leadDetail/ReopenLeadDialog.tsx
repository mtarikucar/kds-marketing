import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';

/** Backend ReopenLeadDto: @MinLength(10). Mirrored so the button explains
 *  itself instead of the server 400ing on a one-word reason. */
const MIN_REASON = 10;

export interface ReopenLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stage being rewound, shown so it is clear what is being undone. */
  currentStatus: string;
  statusLabel: string;
  onConfirm: (reason: string) => void;
  loading?: boolean;
}

/**
 * Sends a lead back to NEW when its stage was entered by mistake.
 *
 * The pipeline only moves forward, so this is the single route back — and the
 * reason is not optional decoration: it lands on the lead's timeline, which is
 * the only thing distinguishing a legitimate correction from someone quietly
 * resetting the funnel.
 */
export function ReopenLeadDialog({
  open,
  onOpenChange,
  currentStatus,
  statusLabel,
  onConfirm,
  loading = false,
}: ReopenLeadDialogProps) {
  const [reason, setReason] = useState('');

  // A stale reason from a previous open would be attributed to this lead.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const tooShort = reason.trim().length < MIN_REASON;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen lead</DialogTitle>
          <DialogDescription>
            Moves this lead from <strong>{statusLabel || currentStatus}</strong> back to New. Use
            this when the stage is wrong — a demo that was never held, an offer that was never
            sent. The reason is written to the lead&apos;s timeline.
          </DialogDescription>
        </DialogHeader>
        <Field
          label="Why is the current stage wrong?"
          hint={`At least ${MIN_REASON} characters — this is what the timeline will show.`}
          required
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. the demo was never held; the stage was set in error"
            />
          )}
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(reason.trim())}
            disabled={tooShort}
            loading={loading}
          >
            Reopen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
ReopenLeadDialog.displayName = 'ReopenLeadDialog';
