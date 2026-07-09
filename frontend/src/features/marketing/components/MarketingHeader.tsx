import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Bell, Search, Plus, Menu } from 'lucide-react';
import { toast } from 'sonner';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useCommandPaletteStore } from '../../../store/commandPaletteStore';
import { useOnboardingStore } from '../../../store/onboardingStore';
import { useTourStore } from '../../../store/tourStore';
import { useTwoFactorStatus } from '../hooks/useTwoFactorStatus';
import { QUICK_ACTIONS } from '../quickActions';
import { fmtDate } from '../utils/format';
import Breadcrumbs from './Breadcrumbs';
import {
  IconButton,
  Badge,
  Button,
  Avatar,
  Field,
  Input,
  Popover,
  PopoverTrigger,
  PopoverContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  ThemeToggle,
  LanguageSwitcher,
  cn,
} from '@/components/ui';

interface Notification {
  id: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return fmtDate(dateStr);
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(1, 'New password is required')
    .min(8, 'New password must be at least 8 characters'),
});

type ChangePasswordValues = z.infer<typeof changePasswordSchema>;

// currentPassword is intentionally NOT required here — it's only mandatory
// when the phone number is dirty on an SMS-2FA-armed account, a condition
// that depends on runtime query/dirty state the static schema can't see.
// That check runs by hand right before submit (see onEditProfile below).
const editProfileSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required'),
  lastName: z.string().trim().min(1, 'Last name is required'),
  phone: z.string().trim().optional(),
  currentPassword: z.string().optional(),
});

type EditProfileValues = z.infer<typeof editProfileSchema>;

function apiErrorMessage(e: unknown): string | undefined {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  return Array.isArray(msg) ? msg[0] : msg;
}

/** OS-appropriate hint for the command-palette shortcut. */
const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
const PALETTE_SHORTCUT = isMac ? '⌘K' : 'Ctrl K';

export default function MarketingHeader({ onMenuClick }: { onMenuClick?: () => void } = {}) {
  const { user, logout, updateUser } = useMarketingAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation('marketing');
  const openPalette = useCommandPaletteStore((s) => s.setOpen);
  const reopenOnboarding = useOnboardingStore((s) => s.reopen);
  const openTour = useTourStore((s) => s.setOpen);

  const [showNotifications, setShowNotifications] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);

  // --- Notifications ---
  const { data: unreadCount } = useQuery({
    queryKey: ['marketing', 'notifications', 'unread-count'],
    queryFn: () => marketingApi.get('/notifications/unread-count').then((r) => r.data),
    refetchInterval: 30000,
  });

  const { data: notifications } = useQuery({
    queryKey: ['marketing', 'notifications'],
    queryFn: () => marketingApi.get('/notifications').then((r) => r.data),
    enabled: showNotifications,
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => marketingApi.patch('/notifications/read-all'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'notifications'] });
      toast.success('All notifications marked as read');
    },
    onError: (err: any) => toast.error(err.response?.data?.message || 'Could not mark all as read'),
  });

  const markOneReadMutation = useMutation({
    mutationFn: (id: string) => marketingApi.patch(`/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'notifications'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.message || 'Could not update the notification'),
  });

  // --- Change Password ---
  const changePasswordForm = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      marketingApi.post('/auth/change-password', data),
    onSuccess: () => {
      toast.success('Password changed successfully');
      setShowChangePassword(false);
      changePasswordForm.reset();
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Failed to change password');
    },
  });

  // --- Edit Profile ---
  const editProfileForm = useForm<EditProfileValues>({
    resolver: zodResolver(editProfileSchema),
    defaultValues: { firstName: '', lastName: '', phone: '', currentPassword: '' },
  });

  // Only fetch 2FA status once the dialog is actually open — no point paying
  // for the request on every authenticated page load.
  const twoFactorStatus = useTwoFactorStatus(showEditProfile);

  const watchedPhone = editProfileForm.watch('phone');
  const originalPhone = (user?.phone ?? '').trim();
  const phoneDirty = (watchedPhone ?? '').trim() !== originalPhone;

  // Precise signal when the 2FA status query has resolved. If a phone-related
  // 400 comes back anyway (query failed, stale cache, etc.) `forcedPasswordField`
  // reveals the field retroactively — see changePassword-style onError below.
  const [forcedPasswordField, setForcedPasswordField] = useState(false);
  const smsTwoFactorArmed = Boolean(
    twoFactorStatus.data?.enabled && twoFactorStatus.data?.method === 'SMS',
  );
  const needsCurrentPassword = forcedPasswordField || (phoneDirty && smsTwoFactorArmed);

  const openEditProfile = () => {
    editProfileForm.reset({
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
      phone: user?.phone ?? '',
      currentPassword: '',
    });
    setForcedPasswordField(false);
    setShowEditProfile(true);
  };

  const closeEditProfile = () => {
    setShowEditProfile(false);
    setForcedPasswordField(false);
    editProfileForm.reset();
  };

  const editProfileMutation = useMutation({
    mutationFn: (values: EditProfileValues) => {
      const payload: Record<string, unknown> = {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        phone: values.phone?.trim() || undefined,
      };
      if (needsCurrentPassword) payload.currentPassword = values.currentPassword;
      return marketingApi.patch('/auth/profile', payload).then((r) => r.data);
    },
    onSuccess: (data: { firstName?: string; lastName?: string; phone?: string | null }) => {
      updateUser({
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone ?? undefined,
      });
      toast.success(t('profile.updateSuccess', 'Profile updated'));
      closeEditProfile();
    },
    onError: (e: unknown) => {
      const msg = apiErrorMessage(e);
      // The backend's currentPassword messages ("Confirm your current
      // password…" / "Current password is incorrect") both mention
      // "password" — route those to the field itself rather than a toast.
      if (msg && /password/i.test(msg)) {
        setForcedPasswordField(true);
        editProfileForm.setError('currentPassword', { type: 'server', message: msg });
        return;
      }
      toast.error(msg || t('profile.updateError', 'Failed to update profile'));
    },
  });

  const onEditProfile = editProfileForm.handleSubmit((values) => {
    if (needsCurrentPassword && !values.currentPassword) {
      editProfileForm.setError('currentPassword', {
        type: 'required',
        message: t(
          'profile.currentPasswordRequired',
          'Enter your current password to continue.',
        ),
      });
      return;
    }
    editProfileMutation.mutate(values);
  });

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const closeChangePassword = () => {
    setShowChangePassword(false);
    changePasswordForm.reset();
  };

  const handleNotificationClick = (notification: Notification) => {
    if (!notification.read) {
      markOneReadMutation.mutate(notification.id);
    }
  };

  const userInitials = user
    ? `${user.firstName?.charAt(0) || ''}${user.lastName?.charAt(0) || ''}`.toUpperCase()
    : '?';

  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const roleBadgeLabel =
    user?.role === 'OWNER' ? 'Owner' : user?.role === 'MANAGER' ? 'Manager' : 'Sales Rep';

  const count = typeof unreadCount === 'number' ? unreadCount : unreadCount?.count ?? 0;
  const notificationList: Notification[] = Array.isArray(notifications)
    ? notifications
    : notifications?.data ?? [];

  return (
    <>
      <header className="bg-surface border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          {onMenuClick && (
            <IconButton
              aria-label={t('nav.openMenu', 'Open menu')}
              variant="ghost"
              className="lg:hidden"
              onClick={onMenuClick}
            >
              <Menu className="h-5 w-5" />
            </IconButton>
          )}
          <Breadcrumbs />
        </div>

        <div className="flex items-center gap-2">
          {/* Global search — opens the command palette (Cmd/Ctrl+K). */}
          <button
            type="button"
            onClick={() => openPalette(true)}
            className="hidden items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
          >
            <Search className="h-4 w-4" />
            <span>{t('commandPalette.search', 'Search')}</span>
            <kbd className="ms-2 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {PALETTE_SHORTCUT}
            </kbd>
          </button>
          <IconButton
            aria-label={t('commandPalette.search', 'Search')}
            variant="ghost"
            className="sm:hidden"
            onClick={() => openPalette(true)}
          >
            <Search className="h-5 w-5" />
          </IconButton>

          {/* Global "+ Create" quick action. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="gap-1.5" aria-label={t('quickCreate.button', 'Create')}>
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">{t('quickCreate.button', 'Create')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {QUICK_ACTIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <DropdownMenuItem key={a.id} onSelect={() => navigate(a.to)}>
                    <Icon className="me-2 h-4 w-4" />
                    {t(a.labelKey, a.label)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <LanguageSwitcher />
          <ThemeToggle />

          {/* Notification Bell */}
          <Popover open={showNotifications} onOpenChange={setShowNotifications}>
            <PopoverTrigger asChild>
              <IconButton aria-label="Notifications" variant="ghost" className="relative">
                <Bell className="h-5 w-5" />
                {count > 0 && (
                  <Badge
                    tone="danger"
                    size="sm"
                    className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] justify-center px-1 text-[10px] font-bold"
                  >
                    {count > 99 ? '99+' : count}
                  </Badge>
                )}
              </IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 max-h-96 flex flex-col p-0">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
                {count > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => markAllReadMutation.mutate()}
                  >
                    Mark all read
                  </Button>
                )}
              </div>
              <div className="overflow-y-auto flex-1">
                {notificationList.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No notifications
                  </div>
                ) : (
                  notificationList.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => handleNotificationClick(n)}
                      className={cn(
                        'w-full text-left px-4 py-3 border-b border-border transition-colors hover:bg-surface-muted',
                        !n.read && 'bg-primary/5',
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {!n.read && (
                          <span className="mt-1.5 h-2 w-2 rounded-full bg-primary flex-shrink-0" />
                        )}
                        <div className={cn('flex-1 min-w-0', n.read && 'ms-4')}>
                          <p className="text-sm font-medium text-foreground truncate">
                            {n.title}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {n.message}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            {formatTimeAgo(n.createdAt)}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>

          {/* Profile Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Avatar initials={userInitials} size="sm" />
                <span className="text-sm font-medium text-foreground hidden sm:block">
                  {user?.firstName} {user?.lastName}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="px-2 py-2">
                <p className="text-sm font-medium text-foreground">
                  {user?.firstName} {user?.lastName}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{user?.email}</p>
                <Badge tone={isManager ? 'primary' : 'neutral'} size="sm" className="mt-1.5">
                  {roleBadgeLabel}
                </Badge>
              </div>
              <DropdownMenuSeparator />
              {isManager && (
                <DropdownMenuItem
                  onSelect={() => {
                    reopenOnboarding(user?.workspaceId ?? 'unknown');
                    navigate('/dashboard');
                    // Confirm the action even when the workspace is fully set up
                    // (in which case the checklist stays hidden — nothing to do).
                    toast.success(t('onboarding.reopened', 'Setup guide reopened'));
                  }}
                >
                  {t('onboarding.reopen', 'Show setup guide')}
                </DropdownMenuItem>
              )}
              {isManager && (
                <DropdownMenuItem onSelect={() => openTour(true)}>
                  {t('tour.reopen', 'Take a tour')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={openEditProfile}>
                {t('profile.menuItem', 'Edit profile')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setShowChangePassword(true)}>
                Change Password
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={handleLogout}
                className="text-danger focus:bg-danger-subtle focus:text-danger"
              >
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Change Password Dialog */}
      <Dialog
        open={showChangePassword}
        onOpenChange={(open) => {
          if (!open) closeChangePassword();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
            <DialogDescription>
              Enter your current password and choose a new one.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={changePasswordForm.handleSubmit((values) =>
              changePasswordMutation.mutate(values),
            )}
            className="flex flex-col gap-4"
          >
            <Field
              label="Current Password"
              error={changePasswordForm.formState.errors.currentPassword?.message}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  placeholder="Enter current password"
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  {...changePasswordForm.register('currentPassword')}
                />
              )}
            </Field>
            <Field
              label="New Password"
              error={changePasswordForm.formState.errors.newPassword?.message}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  placeholder="Enter new password"
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  {...changePasswordForm.register('newPassword')}
                />
              )}
            </Field>
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={closeChangePassword}>
                Cancel
              </Button>
              <Button type="submit" loading={changePasswordMutation.isPending}>
                Change Password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Profile Dialog */}
      <Dialog
        open={showEditProfile}
        onOpenChange={(open) => {
          if (!open) closeEditProfile();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('profile.dialogTitle', 'Edit profile')}</DialogTitle>
            <DialogDescription>
              {t('profile.dialogDescription', 'Update your name and phone number.')}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onEditProfile} className="flex flex-col gap-4">
            <Field
              label={t('profile.firstNameLabel', 'First name')}
              error={editProfileForm.formState.errors.firstName?.message}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  autoComplete="given-name"
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  {...editProfileForm.register('firstName')}
                />
              )}
            </Field>
            <Field
              label={t('profile.lastNameLabel', 'Last name')}
              error={editProfileForm.formState.errors.lastName?.message}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  autoComplete="family-name"
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  {...editProfileForm.register('lastName')}
                />
              )}
            </Field>
            <Field
              label={t('profile.phoneLabel', 'Phone number')}
              hint={t('profile.phoneHint', 'Used for SMS two-factor codes if enabled.')}
              error={editProfileForm.formState.errors.phone?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="tel"
                  autoComplete="tel"
                  placeholder="+905XXXXXXXXX"
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  {...editProfileForm.register('phone')}
                />
              )}
            </Field>
            {/* Only shown when changing the phone on an SMS-2FA-armed account
                (or after the backend has told us it's required — see
                editProfileMutation.onError). Without this, that combination
                used to hit a bare 400 with nowhere to enter the password. */}
            {needsCurrentPassword && (
              <Field
                label={t(
                  'profile.currentPasswordLabel',
                  'Current password to change your phone number',
                )}
                error={editProfileForm.formState.errors.currentPassword?.message}
                required
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    {...editProfileForm.register('currentPassword')}
                  />
                )}
              </Field>
            )}
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={closeEditProfile}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" loading={editProfileMutation.isPending}>
                {t('common.save', 'Save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
