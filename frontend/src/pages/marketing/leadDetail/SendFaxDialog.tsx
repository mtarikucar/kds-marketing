import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';

export interface SendFaxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled recipient — e.g. the lead's own phone, when it looks fax-like. */
  defaultTo?: string;
  onSubmit: (data: { to: string; file: File; header?: string }) => void;
  isPending: boolean;
}

/**
 * Minimal "send fax" action (NetGSM Phase 6 Task 1) — a recipient fax number
 * + a PDF file picker, POSTing to `/marketing/fax/send`. Mirrors
 * `ConvertDialog`'s dialog shell; kept as local `useState` (not
 * react-hook-form) since there's no multi-field cross-validation here, just
 * "a number and a file are both present" before the backend's own magic-byte
 * + size guard takes over.
 */
export default function SendFaxDialog({ open, onOpenChange, defaultTo, onSubmit, isPending }: SendFaxDialogProps) {
  const { t } = useTranslation('marketing');
  const [to, setTo] = useState(defaultTo ?? '');
  const [header, setHeader] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset every time the dialog is (re)opened so a previous send's leftovers
  // never bleed into the next one.
  useEffect(() => {
    if (open) {
      setTo(defaultTo ?? '');
      setHeader('');
      setFile(null);
      setError(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [open, defaultTo]);

  const submit = () => {
    if (!to.trim()) {
      setError(t('fax.toRequired', 'Recipient fax number is required.'));
      return;
    }
    if (!file) {
      setError(t('fax.fileRequired', 'Choose a PDF to fax.'));
      return;
    }
    setError(null);
    onSubmit({ to: to.trim(), file, header: header.trim() || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fax.dialogTitle', 'Send fax')}</DialogTitle>
          <DialogDescription>
            {t('fax.dialogDesc', 'Send a PDF document to a fax number via NetGSM.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={t('fax.to', 'Recipient fax number')} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="0212 555 00 00"
              />
            )}
          </Field>
          <Field label={t('fax.header', 'Cover header (optional)')}>
            {({ id }) => (
              <Input id={id} value={header} onChange={(e) => setHeader(e.target.value)} maxLength={50} />
            )}
          </Field>
          <Field label={t('fax.document', 'PDF document')} required>
            {() => (
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  hidden
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  {t('fax.choosePdf', 'Choose PDF')}
                </Button>
                {file && <span className="truncate text-sm text-muted-foreground">{file.name}</span>}
              </div>
            )}
          </Field>
          {error && (
            <p className="text-caption text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="button" loading={isPending} onClick={submit}>
            {t('fax.send', 'Send fax')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
