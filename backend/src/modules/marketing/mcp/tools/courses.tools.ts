import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { CoursesService } from '../../memberships/courses.service';
import { EnrollmentService } from '../../memberships/enrollment.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface CourseToolDeps {
  courses: CoursesService;
  enrollments: EnrollmentService;
  entitlements: EntitlementsService;
}

/**
 * Faz 5 D5 — courses / memberships.
 *
 * ## `jeeta.enrol_lead` is classified on what it DOES
 *
 * The name suggests onboarding: a welcome email, credentials, an access grant.
 * `EnrollmentService.enroll`'s entire body is two workspace-scoped existence
 * checks and one `prisma.enrollment.upsert` with `update: {}`. Concretely:
 *
 *  - **No message of any kind.** The service injects `PrismaService`,
 *    `CertificateService` and `GamificationService` — no mailer, no message
 *    sender, no outbox. Nothing is emailed or texted to the learner.
 *  - **No account and no credentials.** Nothing is minted; the learner is a
 *    `Lead`, not a login.
 *  - **No access-grant row.** Access is DERIVED at read time from the enrolment
 *    plus `resolveLessonAccess`'s drip/sequential rules.
 *  - **No domain event**, so no workflow fires off the back of it.
 *  - **Idempotent** — re-enrolling the same pair is a no-op.
 *
 * So it is an unattended `WRITE`, like `jeeta.add_lead_note`: internal,
 * reversible (`unenroll`), and invisible to the learner until someone actually
 * sends them the link. Gating it would put an approval card in front of an
 * action nobody outside the workspace can observe.
 *
 * Side effects in this module start at lesson COMPLETION — gamification awards,
 * then a certificate and a `CertificateIssued` outbox event that DOES trigger
 * workflows. Marking a lesson complete on a learner's behalf is therefore not a
 * tool: it fabricates a record of learning that did not happen and can mint a
 * certificate in the learner's name.
 *
 * ## The module gate is stricter than REST, on purpose
 *
 * `CoursesController`/`EnrollmentController` carry no `@RequiresFeature`; the
 * `memberships` key's own comment calls it "nav-gating only, no API gate". But
 * it is a Settings > Modules toggle that new workspaces start with switched OFF
 * (`DEFAULT_ACTIVATED_MODULES` excludes it), and "this workspace turned the
 * module off" is a clear statement that it does not want an agent writing here.
 * Same call D4 made for `research`. The refusal names the feature so an agent
 * can tell the user which toggle to flip.
 *
 * ## Authoring courses is not exposed
 * There is no `create_course`/`add_lesson`/`publish_course`. A course is a
 * structured content product a human builds in the editor; an agent minting
 * half-built published courses would put unfinished material in front of paying
 * learners. Reading the catalogue and enrolling a known contact into an
 * existing course is the useful half.
 */
export function registerCourseTools(registry: McpToolRegistry, deps: CourseToolDeps): void {
  registry.register({
    name: 'jeeta.list_courses',
    description:
      "List the workspace's courses — title, status (DRAFT/PUBLISHED/ARCHIVED), price and how lessons unlock (all at once, sequential, or dripped). Use a course id with jeeta.enrol_lead. Read-only.",
    domain: 'courses',
    scopes: ['courses.manage'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'memberships');
      return deps.courses.list(ctx.workspaceId);
    },
  });

  registry.register({
    name: 'jeeta.enrol_lead',
    description:
      'Enrol a contact in a course. This is an internal record only: the learner is NOT notified — no welcome email, no credentials, no account is created — and nothing is charged. Access to lessons is worked out when they open the course, following its drip/sequential rules. Enrolling the same contact twice changes nothing. Send them the course link yourself afterwards if you want them to know.',
    domain: 'courses',
    // Deferred (spec §3): `jeeta.list_courses` is the domain's advertised read;
    // enrolment is a follow-up verb a model reaches for by name.
    defer: true,
    scopes: ['courses.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      courseId: z.string().min(1).describe('Course id, from jeeta.list_courses.'),
      leadId: z.string().min(1).describe('Contact/lead id to enrol.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'memberships');
      return deps.enrollments.enroll(
        ctx.workspaceId,
        String(args.courseId ?? ''),
        String(args.leadId ?? ''),
      );
    },
  });
}
