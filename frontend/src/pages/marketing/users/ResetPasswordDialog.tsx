/**
 * ResetPasswordDialog — set a new password for an existing user.
 * Uses the shared passwordSchema for validation via RHF+Zod.
 */
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { KeyRound } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { passwordSchema } from '@/features/marketing/schemas';

const resetSchema = z.object({
  password: passwordSchema,
});

type ResetFormValues = z.infer<typeof resetSchema>;

const MSG: Record<string, string> = {
  passwordMin: 'Password must be at least 8 characters.',
  passwordWeak: 'Password must include upper, lower case letters and a number.',
};
const msg = (key: string) => MSG[key] ?? key;

interface ResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userName?: string;
  onSubmit: (password: string) => void;
  isPending: boolean;
}

export function ResetPasswordDialog({
  open,
  onOpenChange,
  userName,
  onSubmit,
  isPending,
}: ResetPasswordDialogProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ResetFormValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: '' },
  });

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Reset Password
          </DialogTitle>
          {userName && (
            <DialogDescription>
              Set a new password for <strong>{userName}</strong>.
            </DialogDescription>
          )}
        </DialogHeader>

        <form
          id="reset-password-form"
          onSubmit={handleSubmit((vals) => onSubmit(vals.password))}
          className="space-y-4"
        >
          <Field
            label="New Password"
            required
            error={errors.password ? msg(errors.password.message ?? '') : undefined}
            hint="Min 8 chars, upper + lower + digit"
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="New password"
                {...register('password')}
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
          <Button type="submit" form="reset-password-form" loading={isPending}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
