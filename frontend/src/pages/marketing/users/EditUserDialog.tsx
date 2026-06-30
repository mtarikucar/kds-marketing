/**
 * EditUserDialog — update an existing marketing team member's profile.
 * Uses a subset of marketingUserSchema (no password required on edit).
 */
import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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

// Subset schema for editing — password not required on edit. OWNER is allowed
// in the form ONLY so an owner's current role displays without a validation
// error; it is never submitted (see the submit handler).
const editUserSchema = z.object({
  firstName: z.string().trim().min(1, 'required').max(80),
  lastName: z.string().trim().min(1, 'required').max(80),
  phone: z.string().trim().optional(),
  role: z.enum(['MANAGER', 'REP', 'OWNER']),
});

type EditUserFormValues = z.infer<typeof editUserSchema>;

/**
 * The submit payload. An OWNER's role is OMITTED — the backend role enum is
 * MANAGER/REP only, so sending 'OWNER' 400s the whole update (an owner couldn't
 * even edit their name/phone), and a rep/manager must never be silently promoted
 * to owner here. So `role` is only ever an assignable MANAGER/REP.
 */
export type EditUserSubmit = {
  firstName: string;
  lastName: string;
  phone?: string;
  role?: 'MANAGER' | 'REP';
};

interface User {
  id: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  role?: string;
}

interface EditUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
  onSubmit: (values: EditUserSubmit) => void;
  isPending: boolean;
}

export function EditUserDialog({
  open,
  onOpenChange,
  user,
  onSubmit,
  isPending,
}: EditUserDialogProps) {
  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<EditUserFormValues>({
    resolver: zodResolver(editUserSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      phone: '',
      role: 'REP',
    },
  });

  // Populate form when user changes
  useEffect(() => {
    if (user) {
      reset({
        firstName: user.firstName ?? '',
        lastName: user.lastName ?? '',
        phone: user.phone ?? '',
        role: (user.role ?? 'REP') as 'MANAGER' | 'REP' | 'OWNER',
      });
    }
  }, [user, reset]);

  const role = watch('role');
  const isOwner = role === 'OWNER';

  // Drop OWNER from the payload — it's display-only here (the backend role enum
  // is MANAGER/REP), so editing an owner's name/phone never 400s.
  const submit = handleSubmit((vals) => {
    const { role: r, ...rest } = vals;
    onSubmit(r === 'OWNER' ? rest : { ...rest, role: r });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Team Member</DialogTitle>
        </DialogHeader>

        <form
          id="edit-user-form"
          onSubmit={submit}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        >
          <Field
            label="First Name"
            required
            error={errors.firstName?.message === 'required' ? 'This field is required' : errors.firstName?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('firstName')}
              />
            )}
          </Field>

          <Field
            label="Last Name"
            required
            error={errors.lastName?.message === 'required' ? 'This field is required' : errors.lastName?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('lastName')}
              />
            )}
          </Field>

          <Field label="Phone" error={errors.phone?.message}>
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

          <Field label="Role" required>
            {({ id }) => (
              <Select
                value={role}
                // An owner's role can't be reassigned here — show it read-only
                // (the backend doesn't accept OWNER and demoting the owner would
                // lock them out of owner-only settings).
                disabled={isOwner}
                onValueChange={(v) => setValue('role', v as 'MANAGER' | 'REP' | 'OWNER')}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="REP">Sales Rep</SelectItem>
                  <SelectItem value="MANAGER">Sales Manager</SelectItem>
                  {isOwner && (
                    <SelectItem value="OWNER" disabled>
                      Owner
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            )}
          </Field>
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="edit-user-form" loading={isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
