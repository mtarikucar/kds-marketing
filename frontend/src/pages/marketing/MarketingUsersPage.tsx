import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PlusIcon, PencilIcon, KeyIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import { fmtDateTime } from '../../features/marketing/utils/format';
import { DistributionConfigCard } from '../../features/marketing/components';
import {
  marketingUserSchema,
  passwordSchema,
  collectZodErrors,
} from '../../features/marketing/schemas';

export default function MarketingUsersPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    phone: '',
    role: 'REP',
  });
  const [error, setError] = useState('');

  // Edit user state
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    role: 'REP',
  });

  // Reset password state
  const [resetPasswordUserId, setResetPasswordUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetError, setResetError] = useState('');

  const { data: users, isLoading } = useQuery({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => marketingApi.post('/users', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
      setShowForm(false);
      setForm({ email: '', password: '', firstName: '', lastName: '', phone: '', role: 'REP' });
      setError('');
      toast.success('User created');
    },
    onError: (err: any) => {
      setError(err.response?.data?.message || 'Failed to create user');
      toast.error('Failed to create user');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/users/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
      toast.success('User deactivated');
    },
    onError: () => {
      toast.error('Failed to deactivate user');
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      marketingApi.patch(`/users/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
      setEditingUserId(null);
      toast.success('User updated');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Failed to update user');
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) =>
      marketingApi.patch(`/users/${id}`, { status: 'ACTIVE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'users'] });
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
      setResetPasswordUserId(null);
      setNewPassword('');
      toast.success('Password reset successfully');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.message || 'Failed to reset password');
    },
  });

  // The shared zod schemas emit i18n keys as messages; this page renders a
  // plain English error string, so map the few keys we can surface here.
  const SCHEMA_MESSAGES: Record<string, string> = {
    required: 'Please fill in all required fields.',
    emailInvalid: 'Please enter a valid email address.',
    passwordMin: 'Password must be at least 8 characters.',
    passwordWeak: 'Password must include upper, lower case letters and a number.',
    passwordMismatch: 'Passwords do not match.',
    phoneInvalid: 'Please enter a valid phone number.',
  };
  const messageFor = (key: string) => SCHEMA_MESSAGES[key] ?? 'Invalid input.';

  const handleCreate = () => {
    // Validate before hitting the API so password/email mistakes surface
    // instantly instead of bouncing off the backend 400.
    const parsed = marketingUserSchema.safeParse({
      firstName: form.firstName,
      lastName: form.lastName,
      email: form.email,
      phone: form.phone || undefined,
      role: form.role,
      password: form.password,
      passwordConfirm: form.password,
    });
    if (!parsed.success) {
      const errors = collectZodErrors(parsed);
      const firstKey = errors.password || errors.email || Object.values(errors)[0];
      setError(messageFor(firstKey));
      return;
    }
    setError('');
    createMutation.mutate(form);
  };

  const handleResetPassword = (id: string) => {
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) {
      setResetError(messageFor(parsed.error.issues[0]?.message ?? ''));
      return;
    }
    setResetError('');
    resetPasswordMutation.mutate({ id, password: newPassword });
  };

  const startEditing = (u: any) => {
    setEditingUserId(u.id);
    setEditForm({
      firstName: u.firstName || '',
      lastName: u.lastName || '',
      phone: u.phone || '',
      role: u.role || 'REP',
    });
    setResetPasswordUserId(null);
    setNewPassword('');
  };

  const cancelEditing = () => {
    setEditingUserId(null);
  };

  const startResetPassword = (id: string) => {
    setResetPasswordUserId(id);
    setNewPassword('');
    setResetError('');
    setEditingUserId(null);
  };

  const cancelResetPassword = () => {
    setResetPasswordUserId(null);
    setNewPassword('');
    setResetError('');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Sales Team</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          <PlusIcon className="w-4 h-4" />
          Add Member
        </button>
      </div>

      {/* Auto-distribution rule — sits above the team list so the
          manager sees both the policy and the rep pool it operates on. */}
      <DistributionConfigCard />

      {/* Create Form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900">New Team Member</h3>
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="First Name"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <input
              type="text"
              placeholder="Last Name"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <input
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <input
              type="password"
              placeholder="Password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <input
              type="tel"
              placeholder="Phone (optional)"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            >
              <option value="REP">Sales Rep</option>
              <option value="MANAGER">Sales Manager</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!form.email || !form.password || !form.firstName || !form.lastName || createMutation.isPending}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button onClick={() => { setShowForm(false); setError(''); }} className="px-4 py-2 border rounded-lg text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Status</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Leads</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Last Login</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">Loading...</td>
                </tr>
              ) : !users || users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">No team members</td>
                </tr>
              ) : (
                users.map((u: any) => (
                  <tr key={u.id} className="hover:bg-gray-50">
                    {editingUserId === u.id ? (
                      <>
                        <td className="px-4 py-3" colSpan={7}>
                          <div className="space-y-3">
                            <h4 className="text-xs font-semibold text-gray-500 uppercase">Edit User</h4>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                              <input
                                type="text"
                                placeholder="First Name"
                                value={editForm.firstName}
                                onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                                className="px-3 py-2 border rounded-lg text-sm"
                              />
                              <input
                                type="text"
                                placeholder="Last Name"
                                value={editForm.lastName}
                                onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                                className="px-3 py-2 border rounded-lg text-sm"
                              />
                              <input
                                type="tel"
                                placeholder="Phone"
                                value={editForm.phone}
                                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                                className="px-3 py-2 border rounded-lg text-sm"
                              />
                              <select
                                value={editForm.role}
                                onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                                className="px-3 py-2 border rounded-lg text-sm"
                              >
                                <option value="REP">Sales Rep</option>
                                <option value="MANAGER">Sales Manager</option>
                              </select>
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => editMutation.mutate({ id: u.id, data: editForm })}
                                disabled={!editForm.firstName || !editForm.lastName || editMutation.isPending}
                                className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                              >
                                {editMutation.isPending ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                onClick={cancelEditing}
                                className="px-4 py-2 border rounded-lg text-sm"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </>
                    ) : resetPasswordUserId === u.id ? (
                      <>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {u.firstName} {u.lastName}
                        </td>
                        <td className="px-4 py-3" colSpan={5}>
                          <div className="flex items-center gap-2">
                            <input
                              type="password"
                              placeholder="New password"
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              className="px-3 py-2 border rounded-lg text-sm w-48"
                            />
                            <button
                              onClick={() => handleResetPassword(u.id)}
                              disabled={!newPassword || resetPasswordMutation.isPending}
                              className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                            >
                              {resetPasswordMutation.isPending ? 'Resetting...' : 'Confirm'}
                            </button>
                            <button
                              onClick={cancelResetPassword}
                              className="px-3 py-1.5 border rounded-lg text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                          {resetError && (
                            <p className="text-xs text-red-600 mt-1">{resetError}</p>
                          )}
                        </td>
                        <td className="px-4 py-3" />
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {u.firstName} {u.lastName}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{u.email}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            u.role === 'OWNER' ? 'bg-amber-100 text-amber-800' : u.role === 'MANAGER' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                          }`}>
                            {u.role === 'OWNER' ? 'Owner' : u.role === 'MANAGER' ? 'Manager' : 'Sales Rep'}
                          </span>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            u.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                          }`}>
                            {u.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">{u._count?.leads || 0}</td>
                        <td className="px-4 py-3 hidden lg:table-cell text-gray-400 text-xs">
                          {u.lastLogin ? fmtDateTime(u.lastLogin) : 'Never'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => startEditing(u)}
                              className="text-gray-400 hover:text-primary"
                              title="Edit user"
                            >
                              <PencilIcon className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => startResetPassword(u.id)}
                              className="text-gray-400 hover:text-primary"
                              title="Reset password"
                            >
                              <KeyIcon className="w-4 h-4" />
                            </button>
                            {u.status === 'ACTIVE' ? (
                              <button
                                onClick={() => {
                                  if (confirm('Deactivate this user?')) {
                                    deleteMutation.mutate(u.id);
                                  }
                                }}
                                className="text-xs text-red-600 hover:text-red-800"
                              >
                                Deactivate
                              </button>
                            ) : (
                              <button
                                onClick={() => {
                                  if (confirm('Reactivate this user?')) {
                                    reactivateMutation.mutate(u.id);
                                  }
                                }}
                                disabled={reactivateMutation.isPending}
                                className="text-xs text-green-600 hover:text-green-800 disabled:opacity-50"
                              >
                                Reactivate
                              </button>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
