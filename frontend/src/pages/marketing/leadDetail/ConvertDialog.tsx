import { useEffect } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import { formatMoney } from '../../../lib/money';
import type { ConvertLeadPayload } from '../../../features/marketing/api/leads.service';
import type { ConvertDialogState } from './useConvertDialog';

// RFC 5321 / 5322 lite — mirrors the lead-detail email check; full
// validation happens server-side on /convert.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// NOTE: the convert endpoint (ConvertLeadDto) accepts ONLY these fields and the
// global ValidationPipe runs with forbidNonWhitelisted:true — sending anything
// else (e.g. adminPassword, commissionAmount) makes the request fail with 400.
// By design the admin's temporary password is generated + emailed server-side
// (sales staff never hold plaintext creds), and the commission is computed from
// the plan — so neither is collected here.
const convertSchema = z.object({
  tenantName: z.string().trim().min(1, 'required'),
  adminEmail: z
    .string()
    .trim()
    .min(1, 'required')
    .refine((v) => EMAIL_RE.test(v), { message: 'Invalid email format.' }),
  adminFirstName: z.string().trim().min(1, 'required'),
  adminLastName: z.string().trim().min(1, 'required'),
  offerId: z.string().optional(),
});

type ConvertFormValues = z.input<typeof convertSchema>;

interface ConvertDialogProps {
  state: ConvertDialogState;
  fmtDate: (d: string | Date | null | undefined) => string;
  onSubmit: (data: ConvertLeadPayload) => void;
  isPending: boolean;
}

export default function ConvertDialog({ state, fmtDate, onSubmit, isPending }: ConvertDialogProps) {
  const { isOpen, lead, sentOffers, close } = state;

  const form = useForm<ConvertFormValues>({
    resolver: zodResolver(convertSchema),
    mode: 'onBlur',
    defaultValues: {
      tenantName: '',
      adminEmail: '',
      adminFirstName: '',
      adminLastName: '',
      offerId: '',
    },
  });

  // Prefill from the lead each time the dialog opens (tenant name, email,
  // contact name split into first/last, first SENT offer).
  useEffect(() => {
    if (isOpen && lead) {
      const parts = (lead.contactPerson || '').split(' ');
      form.reset({
        tenantName: lead.businessName,
        adminEmail: lead.email || '',
        adminFirstName: parts[0] || '',
        adminLastName: parts.slice(1).join(' ') || '',
        offerId: sentOffers[0]?.id || '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, lead]);

  const submit: SubmitHandler<ConvertFormValues> = (raw) => {
    const values = convertSchema.parse(raw);
    // Send ONLY the fields ConvertLeadDto whitelists — anything extra 400s.
    onSubmit({
      tenantName: values.tenantName,
      adminEmail: values.adminEmail,
      adminFirstName: values.adminFirstName,
      adminLastName: values.adminLastName,
      ...(values.offerId ? { offerId: values.offerId } : {}),
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Convert Lead to Customer</DialogTitle>
          <DialogDescription>
            Provision a tenant and admin account from this lead. A temporary
            password is generated and emailed to the admin.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-4">
          <Field label="Tenant Name" required error={form.formState.errors.tenantName?.message}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register('tenantName')}
              />
            )}
          </Field>
          <Field label="Admin Email" required error={form.formState.errors.adminEmail?.message}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="email"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register('adminEmail')}
              />
            )}
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="First Name"
              required
              error={form.formState.errors.adminFirstName?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  {...form.register('adminFirstName')}
                />
              )}
            </Field>
            <Field label="Last Name" required error={form.formState.errors.adminLastName?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  {...form.register('adminLastName')}
                />
              )}
            </Field>
          </div>
          {sentOffers.length > 0 && (
            <Field label="Link Offer (optional)">
              {({ id, describedBy }) => (
                <select
                  id={id}
                  aria-describedby={describedBy}
                  className="h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  {...form.register('offerId')}
                >
                  <option value="">No offer</option>
                  {sentOffers.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.customPrice ? formatMoney(o.customPrice) : 'Standard'}{' '}
                      {o.discount ? `(${o.discount}% off)` : ''} — {fmtDate(o.createdAt)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={isPending}
              className="bg-success text-success-foreground hover:opacity-90"
            >
              Convert
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
