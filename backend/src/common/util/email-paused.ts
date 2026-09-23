/**
 * `settings.email.paused` — the operator kill switch, read in ONE place.
 *
 * Absent means "not paused", for every existing row (PLAN G3): only an
 * explicit `true` stops anything, so arming the switch changed nothing for the
 * tenants who had never heard of it.
 *
 * It lived as four byte-identical private copies (the mail gateway, the
 * campaign sender, the ops snapshot and the platform admin panel), which is
 * three chances for the switch to mean something different from the panel that
 * sets it. `Workspace.settings` is untyped JSON, so the narrowing has to be
 * defensive: a row holding a string, a null or `{ email: "off" }` answers
 * "not paused" rather than throwing inside a send.
 */
export function emailPaused(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const email = (settings as Record<string, unknown>).email;
  if (!email || typeof email !== 'object') return false;
  return (email as Record<string, unknown>).paused === true;
}
