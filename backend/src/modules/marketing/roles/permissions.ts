/** Epic F — the granular permission catalog + legacy-role fallback mapping. */
export const PERMISSIONS = [
  'leads.read',
  'leads.write',
  // Manager-tier lead administration (assign/reassign, convert, delete) — held
  // by OWNER/MANAGER but NOT REP, mirroring the legacy @MarketingRoles('MANAGER')
  // gate on those lead/task/offer/activity admin actions.
  'leads.manage',
  'tasks.read',
  'tasks.write',
  'contacts.read',
  'contacts.write',
  'campaigns.read',
  'campaigns.send',
  'reports.read',
  'courses.manage',
  'automations.manage',
  'users.manage',
  'billing.manage',
  'settings.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const LEGACY_ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: [...PERMISSIONS],
  MANAGER: PERMISSIONS.filter((p) => p !== 'billing.manage' && p !== 'users.manage'),
  REP: [
    'leads.read',
    'leads.write',
    'tasks.read',
    'tasks.write',
    'contacts.read',
    'contacts.write',
    'campaigns.read',
    'reports.read',
  ],
  SYSTEM: [],
};
