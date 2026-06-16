/**
 * Types + permission-catalog presentation metadata for the Roles & permissions
 * editor. The 14-permission catalog is fetched live from GET /roles/catalog;
 * this map only supplies human labels + grouping for display. Any permission the
 * backend returns that is missing here falls back to its raw key.
 */

export interface CustomRole {
  id: string;
  workspaceId: string;
  name: string;
  permissions: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface RoleAssignTarget {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  status: string;
}

export interface PermissionMeta {
  group: string;
  label: string;
  description: string;
}

/** Display metadata for the backend permission catalog (roles/permissions.ts). */
export const PERMISSION_META: Record<string, PermissionMeta> = {
  'leads.read': { group: 'Leads', label: 'View leads', description: 'See leads and their details.' },
  'leads.write': { group: 'Leads', label: 'Edit leads', description: 'Create and update leads.' },
  'leads.manage': {
    group: 'Leads',
    label: 'Administer leads',
    description: 'Assign, convert and delete leads.',
  },
  'tasks.read': { group: 'Tasks', label: 'View tasks', description: 'See tasks.' },
  'tasks.write': { group: 'Tasks', label: 'Edit tasks', description: 'Create and update tasks.' },
  'contacts.read': { group: 'Contacts', label: 'View contacts', description: 'See contact records.' },
  'contacts.write': {
    group: 'Contacts',
    label: 'Edit contacts',
    description: 'Create and update contacts, tags and fields.',
  },
  'campaigns.read': { group: 'Campaigns', label: 'View campaigns', description: 'See campaigns.' },
  'campaigns.send': {
    group: 'Campaigns',
    label: 'Send campaigns',
    description: 'Launch and send campaigns.',
  },
  'reports.read': { group: 'Reports', label: 'View reports', description: 'Access reports and analytics.' },
  'courses.manage': {
    group: 'Memberships',
    label: 'Manage courses',
    description: 'Create and edit courses and communities.',
  },
  'automations.manage': {
    group: 'Automations',
    label: 'Manage automations',
    description: 'Build and edit workflows.',
  },
  'users.manage': {
    group: 'Administration',
    label: 'Manage team',
    description: 'Invite, edit and deactivate team members.',
  },
  'billing.manage': {
    group: 'Administration',
    label: 'Manage billing',
    description: 'Change plan, payment methods and invoices.',
  },
  'settings.manage': {
    group: 'Administration',
    label: 'Manage settings',
    description: 'Edit workspace settings, roles and configuration.',
  },
};

export function permissionMeta(key: string): PermissionMeta {
  return (
    PERMISSION_META[key] ?? {
      group: 'Other',
      label: key,
      description: '',
    }
  );
}
