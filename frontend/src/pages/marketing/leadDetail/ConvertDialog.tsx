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
import { passwordSchema } from '../../../features/marketing/schemas';
import { formatMoney } from '../../../lib/money';
import type { ConvertDialogState } from './useConvertDialog';

// RFC 5321 / 5322 lite — mirrors the lead-detail email check; full
// validation happens server-side on /convert.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors the backend admin-password rule for the /convert endpoint
// (8+ chars with upper/lower/digit, via the shared passwordSchema).
const PASSWORD_HINT = 'Min 8 chars, with upper, lower case & a number';

const convertSchema = z.object({
  tenantName: z.string().trim().min(1, 'required'),
  adminEmail: z
    .string()
    .trim()
    .min(1, 'required')
    .refine((v) => EMAIL_RE.test(v), { message: 'Invalid email format.' }),
  adminFirstName: z.string().trim().min(1, 'required'),
  adminLastName: z.string().trim().min(1, 'required'),
  adminPassword: passwordSchema,
  offerId: z.string().optional(),
  commissionAmount: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v == null ? undefined : v)),
});

type ConvertFormValues = z.input<typeof convertSchema>;

interface ConvertDialogProps {
  state: ConvertDialogState;
  fmtDate: (d: string | Date | null | undefined) => string;
  onSubmit: (data: Record<string, unknown>) => void;
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
      adminPassword: '',
      offerId: '',
      commissionAmount: '',
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
        adminPassword: '',
        offerId: sentOffers[0]?.id || '',
        commissionAmount: '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, lead]);

  const submit: SubmitHandler<ConvertFormValues> = (raw) => {
    const values = convertSchema.parse(raw);
    onSubmit({
      tenantName: values.tenantName,
      adminEmail: values.adminEmail,
      adminFirstName: values.adminFirstName,
      adminLastName: values.adminLastName,
      adminPassword: values.adminPassword,
      ...(values.offerId ? { offerId: values.offerId } : {}),
      ...(values.commissionAmount != null && values.commissionAmount !== ''
        ? { commissionAmount: Number(values.commissionAmount) }
        : {}),
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Convert Lead to Customer</DialogTitle>
          <DialogDescription>
            Provision a tenant and admin account from this lead.
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
          <Field
            label="Admin Password"
            required
            hint={PASSWORD_HINT}
            error={form.formState.errors.adminPassword?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={PASSWORD_HINT}
                {...form.register('adminPassword')}
              />
            )}
          </Field>
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
          <Field label="Commission Amount" error={form.formState.errors.commissionAmount?.message}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="number"
                aria-describedby={describedBy}
                placeholder="0"
                {...form.register('commissionAmount')}
              />
            )}
          </Field>
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
