import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogClose } from './Dialog';
import { Button } from './Button';

/**
 * ConfirmDialog — a controlled confirmation modal composed from Dialog. The
 * caller owns `open`/`onOpenChange`; `onConfirm` fires when the confirm button is
 * pressed (it does not auto-close — let the caller close after the async work, or
 * close in the handler). `tone="danger"` renders a destructive confirm button for
 * irreversible actions. Inherits Dialog's focus-trap, Escape and aria-modal.
 *
 * A `DialogDescription` is ALWAYS rendered so Radix's "Missing Description"
 * advisory never fires. When no explicit `description` is passed the element
 * is visually hidden via `sr-only` but still present in the accessibility tree.
 */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  loading = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            /* Always provide a description for screen readers even when not visually displayed.
               This prevents Radix's "Missing Description" advisory from firing. */
            <DialogDescription className="sr-only">
              {confirmLabel} confirmation dialog
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={loading}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
ConfirmDialog.displayName = 'ConfirmDialog';
