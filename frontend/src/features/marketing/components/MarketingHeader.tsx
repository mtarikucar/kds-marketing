import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { BellIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { fmtDate } from '../utils/format';

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

export default function MarketingHeader() {
  const { user, logout } = useMarketingAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

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
  });

  const markOneReadMutation = useMutation({
    mutationFn: (id: string) => marketingApi.patch(`/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'notifications'] });
    },
  });

  // --- Change Password ---
  const changePasswordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      marketingApi.post('/auth/change-password', data),
    onSuccess: () => {
      toast.success('Password changed successfully');
      setShowChangePassword(false);
      setCurrentPassword('');
      setNewPassword('');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Failed to change password');
    },
  });

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      toast.error('Please fill in both fields');
      return;
    }
    changePasswordMutation.mutate({ currentPassword, newPassword });
  };

  const handleNotificationClick = (notification: Notification) => {
    if (!notification.read) {
      markOneReadMutation.mutate(notification.id);
    }
  };

  const userInitials = user
    ? `${user.firstName?.charAt(0) || ''}${user.lastName?.charAt(0) || ''}`.toUpperCase()
    : '?';

  const roleBadgeLabel =
    user?.role === 'OWNER' ? 'Owner' : user?.role === 'MANAGER' ? 'Manager' : 'Sales Rep';
  const roleBadgeClasses =
    user?.role === 'MANAGER' || user?.role === 'OWNER'
      ? 'bg-purple-100 text-purple-800'
      : 'bg-blue-100 text-blue-800';

  const count = typeof unreadCount === 'number' ? unreadCount : unreadCount?.count ?? 0;
  const notificationList: Notification[] = Array.isArray(notifications)
    ? notifications
    : notifications?.data ?? [];

  return (
    <>
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-gray-900 lg:hidden">Marketing Panel</h1>
        </div>

        <div className="flex items-center gap-3">
          {/* Notification Bell */}
          <div className="relative">
            <button
              onClick={() => {
                setShowNotifications((v) => !v);
                setShowProfile(false);
              }}
              className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <BellIcon className="h-5 w-5" />
              {count > 0 && (
                <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>

            {/* Notifications Dropdown */}
            {showNotifications && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowNotifications(false)} />
                <div className="absolute right-0 mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-40 max-h-96 flex flex-col">
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
                    {count > 0 && (
                      <button
                        onClick={() => markAllReadMutation.mutate()}
                        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {notificationList.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-gray-400">
                        No notifications
                      </div>
                    ) : (
                      notificationList.map((n) => (
                        <button
                          key={n.id}
                          onClick={() => handleNotificationClick(n)}
                          className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                            !n.read ? 'bg-blue-50/40' : ''
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {!n.read && (
                              <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 flex-shrink-0" />
                            )}
                            <div className={`flex-1 min-w-0 ${n.read ? 'ml-4' : ''}`}>
                              <p className="text-sm font-medium text-gray-900 truncate">
                                {n.title}
                              </p>
                              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                                {n.message}
                              </p>
                              <p className="text-[11px] text-gray-400 mt-1">
                                {formatTimeAgo(n.createdAt)}
                              </p>
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Profile Section */}
          <div className="relative">
            <button
              onClick={() => {
                setShowProfile((v) => !v);
                setShowNotifications(false);
              }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center text-white text-xs font-semibold">
                {userInitials}
              </div>
              <span className="text-sm font-medium text-gray-700 hidden sm:block">
                {user?.firstName} {user?.lastName}
              </span>
            </button>

            {/* Profile Dropdown */}
            {showProfile && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowProfile(false)} />
                <div className="absolute right-0 mt-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-40 py-1">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="text-sm font-medium text-gray-900">
                      {user?.firstName} {user?.lastName}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">{user?.email}</p>
                    <span
                      className={`inline-block mt-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full ${roleBadgeClasses}`}
                    >
                      {roleBadgeLabel}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      setShowProfile(false);
                      setShowChangePassword(true);
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Change Password
                  </button>
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                  >
                    Logout
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Change Password Modal */}
      {showChangePassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              setShowChangePassword(false);
              setCurrentPassword('');
              setNewPassword('');
            }}
          />
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Change Password</h2>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                  placeholder="Enter current password"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                  placeholder="Enter new password"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowChangePassword(false);
                    setCurrentPassword('');
                    setNewPassword('');
                  }}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={changePasswordMutation.isPending}
                  className="px-4 py-2 text-sm text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {changePasswordMutation.isPending ? 'Saving...' : 'Change Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
