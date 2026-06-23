/**
 * InviteUserDialog — create a new marketing team member.
 * Uses RHF + Zod (marketingUserSchema) for immediate validation,
 * then fires the createMutation from the parent.
 */
import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { UserPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import {
  marketingUserSchema,
  type MarketingUserFormValues,
} from '@/features/marketing/schemas';

interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: MarketingUserFormValues) => void;
  isPending: boolean;
}

// Schema messages mirror original SCHEMA_MESSAGES map
const MSG: Record<string, string> = {
  required: 'Please fill in all required fields.',
  emailInvalid: 'Please enter a valid email address.',
  passwordMin: 'Password must be at least 8 characters.',
  passwordWeak: 'Password must include upper, lower case letters and a number.',
  passwordMismatch: 'Passwords do not match.',
  phoneInvalid: 'Please enter a valid phone number.',
};
const msg = (key: string) => MSG[key] ?? key;

export function InviteUserDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: InviteUserDialogProps) {
  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<MarketingUserFormValues>({
    resolver: zodResolver(marketingUserSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      role: 'REP',
      password: '',
      passwordConfirm: '',
    },
  });

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const role = watch('role');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Add Team Member
          </DialogTitle>
        </DialogHeader>

        <form
          id="invite-user-form"
          onSubmit={handleSubmit(onSubmit)}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        >
          <Field label="First Name" required error={errors.firstName ? msg(errors.firstName.message ?? '') : undefined}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Jane"
                {...register('firstName')}
              />
            )}
          </Field>

          <Field label="Last Name" required error={errors.lastName ? msg(errors.lastName.message ?? '') : undefined}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Doe"
                {...register('lastName')}
              />
            )}
          </Field>

          <Field
            label="Email"
            required
            error={errors.email ? msg(errors.email.message ?? '') : undefined}
            className="sm:col-span-2"
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="email"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="jane@example.com"
                {...register('email')}
              />
            )}
          </Field>

          <Field label="Phone" error={errors.phone ? msg(errors.phone.message ?? '') : undefined}>
            {({ id, describedBy, invalid }) => (
              <Controller
                name="phone"
                control={control}
                render={({ field }) => (
                  <PhoneInput
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            )}
          </Field>

          <Field label="Role" required error={errors.role?.message}>
            {({ id }) => (
              <Select value={role} onValueChange={(v) => setValue('role', v as 'REP' | 'MANAGER')}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="REP">Sales Rep</SelectItem>
                  <SelectItem value="MANAGER">Sales Manager</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field
            label="Password"
            required
            error={errors.password ? msg(errors.password.message ?? '') : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Min 8 chars, upper+lower+digit"
                {...register('password')}
              />
            )}
          </Field>

          <Field
            label="Confirm Password"
            required
            error={errors.passwordConfirm ? msg(errors.passwordConfirm.message ?? '') : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Repeat password"
                {...register('passwordConfirm')}
              />
            )}
          </Field>
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="invite-user-form" loading={isPending}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
