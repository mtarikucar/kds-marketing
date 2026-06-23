/**
 * EditUserDialog — update an existing marketing team member's profile.
 * Uses a subset of marketingUserSchema (no password required on edit).
 */
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
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

// Subset schema for editing — password not required on edit
const editUserSchema = z.object({
  firstName: z.string().trim().min(1, 'required').max(80),
  lastName: z.string().trim().min(1, 'required').max(80),
  phone: z.string().trim().optional(),
  role: z.enum(['MANAGER', 'REP', 'OWNER']),
});

export type EditUserFormValues = z.infer<typeof editUserSchema>;

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
  onSubmit: (values: EditUserFormValues) => void;
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Team Member</DialogTitle>
        </DialogHeader>

        <form
          id="edit-user-form"
          onSubmit={handleSubmit(onSubmit)}
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
              <PhoneInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('phone')}
              />
            )}
          </Field>

          <Field label="Role" required>
            {({ id }) => (
              <Select
                value={role}
                onValueChange={(v) => setValue('role', v as 'MANAGER' | 'REP' | 'OWNER')}
              >
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
