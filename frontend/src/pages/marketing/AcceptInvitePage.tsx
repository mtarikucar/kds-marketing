import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { acceptInvite } from '../../features/marketing/api/membershipApi';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';

/**
 * Multi-workspace membership Phase 2 Task 15 — public landing page for an
 * invite link e-mailed after POST /marketing/users/invite. The token in the
 * URL is the ONLY credential (see marketing-auth.controller.ts's public
 * accept-invite route); this page carries NO auth guard, unlike login/
 * register, so it works for:
 *  - a brand-new identity (needs to set a password here),
 *  - an existing identity accepting from a fresh browser,
 *  - a user currently logged into an unrelated workspace.
 *
 * Whether a password is actually REQUIRED depends on server-side state this
 * page can't see (a brand-new invited identity vs. an existing one being
 * added to a second workspace) — the DTO leaves it optional and the backend
 * decides, 400ing with "Password required to accept" when it turns out to
 * be needed. So the field is always shown, always optional client-side, and
 * that server message is surfaced verbatim if it comes back.
 */

const acceptInviteSchema = z.object({
  password: z
    .string()
    .optional()
    .refine((v) => !v || (v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v)), {
      message: 'Password must be at least 8 characters and include a letter and a number.',
    }),
});
type AcceptInviteValues = z.infer<typeof acceptInviteSchema>;

export default function AcceptInvitePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<AcceptInviteValues>({
    resolver: zodResolver(acceptInviteSchema),
  });

  const onSubmit = async (values: AcceptInviteValues) => {
    if (!token) {
      setError('root', { message: 'This invite link is missing its token.' });
      return;
    }
    try {
      await acceptInvite({ token, password: values.password || undefined });
      // The next page (login) is a fresh mount — a toast (rendered by the
      // app-root <Toaster/> in main.tsx, so it survives the navigation) is
      // the only way to carry this confirmation across the route change.
      toast.success('Invitation accepted — please log in.');
      navigate('/login');
    } catch (err: any) {
      setError('root', {
        message:
          err.response?.data?.message || err.message || 'Failed to accept this invitation.',
      });
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <div className="flex flex-col items-center gap-3 pb-2">
              <img
                src="/logo-mark.png"
                alt="Jeeta"
                className="h-14 w-14 rounded-2xl object-cover shadow-sm ring-1 ring-black/5"
              />
              <div className="text-center">
                <h1 className="font-display text-h2 text-foreground">Accept your invitation</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Join your team's workspace to get started.
                </p>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {!token && (
              <Callout tone="danger" className="mb-4">
                This invite link is missing its token. Please use the link from your invite
                email.
              </Callout>
            )}
            {errors.root && (
              <Callout tone="danger" className="mb-4">
                {errors.root.message}
              </Callout>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <Field
                label="Set a password (if this is your first workspace)"
                hint="Leave blank if you already have a Jeeta account elsewhere."
                error={errors.password?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('password')}
                  />
                )}
              </Field>

              <Button
                type="submit"
                size="lg"
                loading={isSubmitting}
                disabled={!token}
                className="w-full"
              >
                Accept invitation
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-6">
              Already accepted?{' '}
              <Link to="/login" className="text-primary font-medium hover:underline">
                Log in
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
