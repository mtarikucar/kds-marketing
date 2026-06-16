/**
 * MarketingUsersPage — Console migration (Team & Targets, Phase 4 Task 2).
 *
 * Preserved verbatim:
 *   - useQuery(['marketing','users']) + endpoint /users
 *   - createMutation (POST /users) + invalidation
 *   - deleteMutation (DELETE /users/:id) + invalidation
 *   - editMutation (PATCH /users/:id) + invalidation
 *   - reactivateMutation (PATCH /users/:id { status:'ACTIVE' }) + invalidation
 *   - resetPasswordMutation (PATCH /users/:id { password }) + invalidation
 *   - manager-only gating (route handled by MarketingProtectedRoute in App.tsx)
 *   - marketingUserSchema + passwordSchema from features/marketing/schemas
 *
 * Presentation upgrade:
 *   - PageHeader with "Add Member" action
 *   - Table primitives + Avatar + role/status Badge
 *   - DropdownMenu row actions (edit / reset password / deactivate|reactivate)
 *   - ConfirmDialog for deactivate/reactivate confirmations
 *   - InviteUserDialog (RHF+Zod invite form)
 *   - EditUserDialog (RHF+Zod edit form)
 *   - ResetPasswordDialog (RHF+Zod password reset)
 *   - Skeleton loading + EmptyState
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MoreHorizontal, Users } from 'lucide-react';
import marketingApi from '@/features/marketing/api/marketingApi';
import { fmtDateTime } from '@/features/marketing/utils/format';
import { DistributionConfigCard } from '@/features/marketing/components';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/DropdownMenu';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { InviteUserDialog } from './InviteUserDialog';
import { EditUserDialog, type EditUserFormValues } from './EditUserDialog';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import type { MarketingUserFormValues } from '@/features/marketing/schemas';

// ── Types ──────────────────────────────────────────────────────────────────
interface MarketingUser {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  role: string;
  status: string;
  lastLogin?: string | null;
  _count?: { leads: number };
}

// ── Role helpers ────────────────────────────────────────────────────────────
function roleLabel(role: string): string {
  if (role === 'OWNER') return 'Owner';
  if (role === 'MANAGER') return 'Manager';
  return 'Sales Rep';
}

function roleTone(role: string): 'warning' | 'primary' | 'neutral' {
  if (role === 'OWNER') return 'warning';
  if (role === 'MANAGER') return 'primary';
  return 'neutral';
}

function statusTone(status: string): 'success' | 'danger' {
  return status === 'ACTIVE' ? 'success' : 'danger';
}

function initials(u: MarketingUser): string {
  return `${u.firstName?.[0] ?? ''}${u.lastName?.[0] ?? ''}`.toUpperCase() || '?';
}

// ── Component ───────────────────────────────────────────────────────────────
export default function MarketingUsersPage() {
  const queryClient = useQueryClient();

  // Dialog states
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editUser, setEditUser] = useState<MarketingUser | null>(null);
  const [resetUser, setResetUser] = useState<MarketingUser | null>(null);
  const [confirmUser, setConfirmUser] = useState<{ user: MarketingUser; action: 'deactivate' | 'reactivate' } | null>(null);

  // ── Queries ─────────────────────────────────────────────────────────────
  const { data: users, isLoading } = useQuery<MarketingUser[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
  });

  // ── Mutations ────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: any) => marketingApi.post('/users', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
      setInviteOpen(false);
      toast.success('User created');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Failed to create user');
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      marketingApi.patch(`/users/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
      setEditUser(null);
      toast.success('User updated');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Failed to update user');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/users/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
      setConfirmUser(null);
      toast.success('User deactivated');
    },
    onError: () => {
      toast.error('Failed to deactivate user');
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) =>
      marketingApi.patch(`/users/${id}`, { status: 'ACTIVE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
      setConfirmUser(null);
      toast.success('User reactivated');
    },
    onError: () => {
      toast.error('Failed to reactivate user');
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      marketingApi.patch(`/users/${id}`, { password }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
      setResetUser(null);
      toast.success('Password reset successfully');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Failed to reset password');
    },
  });

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleInvite = (values: MarketingUserFormValues) => {
    createMutation.mutate({
      email: values.email,
      password: values.password,
      firstName: values.firstName,
      lastName: values.lastName,
      phone: values.phone || undefined,
      role: values.role,
    });
  };

  const handleEdit = (values: EditUserFormValues) => {
    if (!editUser) return;
    editMutation.mutate({ id: editUser.id, data: values });
  };

  const handleResetPassword = (password: string) => {
    if (!resetUser) return;
    resetPasswordMutation.mutate({ id: resetUser.id, password });
  };

  const handleConfirmAction = () => {
    if (!confirmUser) return;
    if (confirmUser.action === 'deactivate') {
      deleteMutation.mutate(confirmUser.user.id);
    } else {
      reactivateMutation.mutate(confirmUser.user.id);
    }
  };

  const confirmPending =
    deleteMutation.isPending || reactivateMutation.isPending;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales Team"
        description="Manage team members, roles and access."
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <Users className="h-4 w-4" aria-hidden="true" />
            Add Member
          </Button>
        }
      />

      {/* Auto-distribution rule — sits above the team list */}
      <DistributionConfigCard />

      {/* Team table */}
      <Card>
        {isLoading ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !users || users.length === 0 ? (
          <EmptyState
            icon={<Users className="h-8 w-8" />}
            title="No team members yet"
            description="Invite someone to get started."
            action={
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                Add Member
              </Button>
            }
            className="border-0"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH className="hidden md:table-cell">Status</TH>
                  <TH className="hidden md:table-cell" numeric>Leads</TH>
                  <TH className="hidden lg:table-cell">Last Login</TH>
                  <TH className="w-10" />
                </TR>
              </THead>
              <TBody>
                {users.map((u) => (
                  <TR key={u.id}>
                    <TD>
                      <div className="flex items-center gap-2.5">
                        <Avatar size="sm" initials={initials(u)} />
                        <span className="font-medium text-foreground">
                          {u.firstName} {u.lastName}
                        </span>
                      </div>
                    </TD>
                    <TD className="text-muted-foreground">{u.email}</TD>
                    <TD>
                      <Badge tone={roleTone(u.role)} size="sm">
                        {roleLabel(u.role)}
                      </Badge>
                    </TD>
                    <TD className="hidden md:table-cell">
                      <Badge tone={statusTone(u.status)} size="sm">
                        {u.status}
                      </Badge>
                    </TD>
                    <TD className="hidden md:table-cell" numeric>
                      {u._count?.leads ?? 0}
                    </TD>
                    <TD className="hidden lg:table-cell text-muted-foreground text-xs">
                      {u.lastLogin ? fmtDateTime(u.lastLogin) : 'Never'}
                    </TD>
                    <TD>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Actions for ${u.firstName} ${u.lastName}`}
                          >
                            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditUser(u)}>
                            Edit profile
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setResetUser(u)}>
                            Reset password
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {u.status === 'ACTIVE' ? (
                            <DropdownMenuItem
                              className="text-danger focus:text-danger"
                              onClick={() =>
                                setConfirmUser({ user: u, action: 'deactivate' })
                              }
                            >
                              Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              className="text-success focus:text-success"
                              onClick={() =>
                                setConfirmUser({ user: u, action: 'reactivate' })
                              }
                            >
                              Reactivate
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Invite dialog */}
      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onSubmit={handleInvite}
        isPending={createMutation.isPending}
      />

      {/* Edit dialog */}
      <EditUserDialog
        open={!!editUser}
        onOpenChange={(open) => { if (!open) setEditUser(null); }}
        user={editUser}
        onSubmit={handleEdit}
        isPending={editMutation.isPending}
      />

      {/* Reset password dialog */}
      <ResetPasswordDialog
        open={!!resetUser}
        onOpenChange={(open) => { if (!open) setResetUser(null); }}
        userName={resetUser ? `${resetUser.firstName ?? ''} ${resetUser.lastName ?? ''}`.trim() : undefined}
        onSubmit={handleResetPassword}
        isPending={resetPasswordMutation.isPending}
      />

      {/* Confirm deactivate/reactivate */}
      <ConfirmDialog
        open={!!confirmUser}
        onOpenChange={(open) => { if (!open) setConfirmUser(null); }}
        title={
          confirmUser?.action === 'deactivate'
            ? 'Deactivate user?'
            : 'Reactivate user?'
        }
        description={
          confirmUser?.action === 'deactivate'
            ? `${confirmUser?.user.firstName} ${confirmUser?.user.lastName} will lose access immediately.`
            : `${confirmUser?.user.firstName} ${confirmUser?.user.lastName} will regain access.`
        }
        confirmLabel={
          confirmUser?.action === 'deactivate' ? 'Deactivate' : 'Reactivate'
        }
        tone={confirmUser?.action === 'deactivate' ? 'danger' : 'default'}
        onConfirm={handleConfirmAction}
        loading={confirmPending}
      />
    </div>
  );
}
