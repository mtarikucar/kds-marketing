import { McpToolRegistry } from '../mcp-tool-registry';
import { registerCourseTools, type CourseToolDeps } from './courses.tools';

const WS = 'ws-1';
const ctx = { workspaceId: WS, grantedScopes: [] as string[] };

function build(features: Record<string, boolean> = { memberships: true }) {
  const deps = {
    courses: { list: jest.fn(async () => [{ id: 'c1' }]) },
    enrollments: { enroll: jest.fn(async () => ({ id: 'en1' })), list: jest.fn(async () => []) },
    entitlements: { getEffective: jest.fn(async () => ({ features })) },
  };
  const registry = new McpToolRegistry();
  registerCourseTools(registry, deps as unknown as CourseToolDeps);
  return { registry, deps };
}

describe('courses tools', () => {
  it('registers exactly the two course tools in the courses domain on courses.manage', () => {
    const { registry } = build();
    const tools = registry.list(['courses.manage']);
    expect(tools.map((t) => t.name).sort()).toEqual(['jeeta.enrol_lead', 'jeeta.list_courses']);
    for (const t of tools) {
      expect(t.domain).toBe('courses');
      expect(t.scopes).toEqual(['courses.manage']);
    }
  });

  it('is invisible to a caller without courses.manage', () => {
    const { registry } = build();
    expect(registry.list(['leads.read', 'settings.manage'])).toEqual([]);
  });

  it('advertises the catalogue read and defers the enrolment write', () => {
    const { registry } = build();
    expect(registry.get('jeeta.list_courses')!.defer).toBeFalsy();
    expect(registry.get('jeeta.enrol_lead')!.defer).toBe(true);
  });

  it('jeeta.list_courses reads the caller workspace', async () => {
    const { registry, deps } = build();
    await expect(registry.get('jeeta.list_courses')!.handler(ctx, {})).resolves.toEqual([{ id: 'c1' }]);
    expect(deps.courses.list).toHaveBeenCalledWith(WS);
  });
});

/**
 * The classification question the wave asked out loud: what does enrolling
 * actually trigger?
 *
 * The answer, read off `EnrollmentService.enroll`, is: nothing. Its whole body
 * is two workspace-scoped existence checks and a `prisma.enrollment.upsert`
 * with `update: {}`. No welcome email — the service does not inject a mailer,
 * an outbox or a message sender at all. No account, no credentials, no magic
 * link. No "access grant" row either: access is DERIVED at read time from the
 * enrolment plus `resolveLessonAccess`'s drip/sequential rules. No domain
 * event, so no workflow fires. Re-enrolling the same pair is a no-op.
 *
 * So it is a plain, idempotent, reversible `WRITE` and gating it would be
 * theatre — the same call D1 made for `jeeta.add_lead_note`. Side effects in
 * this module only begin at lesson COMPLETION (gamification awards, then a
 * certificate + a `CertificateIssued` event), and completing a lesson on a
 * learner's behalf is not a tool.
 */
describe('jeeta.enrol_lead — classified on what it does, not what it sounds like', () => {
  it('is an unattended WRITE, because enrolment sends nothing and grants nothing', () => {
    const { registry } = build();
    const tool = registry.get('jeeta.enrol_lead')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.approvalKind).toBeUndefined();
  });

  it('says in its description that the learner is not notified', () => {
    const { registry } = build();
    expect(registry.get('jeeta.enrol_lead')!.description).toMatch(/not (be )?notif|no.*email/i);
  });

  it('enrols through EnrollmentService with the caller workspace', async () => {
    const { registry, deps } = build();
    await registry.get('jeeta.enrol_lead')!.handler(ctx, { courseId: 'c1', leadId: 'l1' });
    expect(deps.enrollments.enroll).toHaveBeenCalledWith(WS, 'c1', 'l1');
  });

  it('requires both ids', () => {
    const { registry } = build();
    const schema = registry.get('jeeta.enrol_lead')!.inputSchema;
    expect(schema.safeParse({ courseId: 'c1' }).success).toBe(false);
    expect(schema.safeParse({ leadId: 'l1' }).success).toBe(false);
    expect(schema.safeParse({ courseId: 'c1', leadId: 'l1' }).success).toBe(true);
  });
});

/**
 * `memberships` is a Settings > Modules toggle that new workspaces start with
 * switched OFF (`DEFAULT_ACTIVATED_MODULES`), and its own comment in
 * entitlements.service.ts says it is "nav-gating only, no API gate" — the REST
 * courses/enrolment controllers carry no `@RequiresFeature`. Gating here makes
 * MCP STRICTER than REST, deliberately and for the same reason D4 gave for
 * `research`: a workspace that switched the module off has said it does not
 * want this surface, and an agent should hear that as a sentence rather than
 * quietly writing rows into a module nobody has enabled.
 */
describe('courses feature gate', () => {
  it.each([
    ['jeeta.list_courses', {}],
    ['jeeta.enrol_lead', { courseId: 'c1', leadId: 'l1' }],
  ])('%s refuses cleanly without the memberships module', async (name, args) => {
    const { registry, deps } = build({});
    await expect(registry.get(name)!.handler(ctx, args)).rejects.toMatchObject({
      response: { code: 'FEATURE_NOT_IN_PACKAGE', feature: 'memberships' },
    });
    expect(deps.courses.list).not.toHaveBeenCalled();
    expect(deps.enrollments.enroll).not.toHaveBeenCalled();
  });
});
