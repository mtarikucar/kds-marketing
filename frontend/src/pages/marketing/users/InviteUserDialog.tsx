/**
 * InviteUserDialog — invite a new team member into this workspace.
 *
 * Multi-workspace membership Phase 2 Task 15 — "Add user" is now "Invite
 * member": the backend's POST /users/invite (and POST /users, which now
 * delegates to the same invite path) creates an INVITED membership and lets
 * the invitee accept via a token link; any password/name submitted here
 * would be silently IGNORED server-side, so this form only collects what
 * the invite DTO actually uses — email + role. The invitee sets their own
 * name/password when they accept (see pages/marketing/AcceptInvitePage.tsx).
 */
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';

const inviteMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'required')
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'emailInvalid' }),
  role: z.enum(['MANAGER', 'REP']),
});

export type InviteMemberFormValues = z.infer<typeof inviteMemberSchema>;

interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: InviteMemberFormValues) => void;
  isPending: boolean;
  /**
   * Set only when the membership was created but the invitation mail did NOT
   * go out. The dialog then stops being a form and becomes the fallback: the
   * invite is real and the person can still join, but somebody has to hand
   * them the link (`invites-not-sent`).
   */
  inviteLink?: string | null;
}

const MSG: Record<string, string> = {
  required: 'Please enter an email address.',
  emailInvalid: 'Please enter a valid email address.',
};
const msg = (key: string) => MSG[key] ?? key;

export function InviteUserDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  inviteLink,
}: InviteUserDialogProps) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<InviteMemberFormValues>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: {
      email: '',
      role: 'REP',
    },
  });

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const role = watch('role');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Invite Team Member
          </DialogTitle>
        </DialogHeader>

        {inviteLink ? (
          <div className="space-y-3">
            <p className="text-body">
              The invitation could not be emailed. The member is invited — send them this link and
              they can still join:
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  // Best effort: an insecure origin or a denied permission must
                  // not swallow the link, which is still selectable above.
                  void navigator.clipboard?.writeText(inviteLink).catch(() => undefined);
                }}
              >
                Copy
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">
              The link expires like any invitation. Check the mailbox settings if this keeps
              happening.
            </p>
          </div>
        ) : (
        <form id="invite-user-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field
            label="Email"
            required
            error={errors.email ? msg(errors.email.message ?? '') : undefined}
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

          <p className="text-caption text-muted-foreground">
            We'll email them a link to join and set their own password — no password to set here.
          </p>
        </form>
        )}

        <DialogFooter>
          {inviteLink ? (
            <DialogClose asChild>
              <Button>Done</Button>
            </DialogClose>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" form="invite-user-form" loading={isPending}>
                Send Invite
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
