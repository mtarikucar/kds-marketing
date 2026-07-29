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
  // Author/draft campaign content (e.g. a social post) without the authority
  // to make it reach an audience — that stays on 'campaigns.send'. Held by
  // OWNER/MANAGER (both already hold 'campaigns.send', a strict superset of
  // authority) but withheld from REP, mirroring REP's existing exclusion from
  // 'campaigns.send': REP's set stays CRM-scoped (leads/tasks/contacts) plus
  // read-only campaign visibility. A workspace that wants a "REP who may
  // draft" persona can grant it via a custom role (Epic F) now that the
  // granular scope exists — it is not a legacy-role default.
  'campaigns.write',
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
