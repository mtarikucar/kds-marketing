# Epic C — Memberships / Courses / Communities — design

**Date:** 2026-06-16
**Status:** approved-direction (user: autonomous, no-ask) — decisions controller-made
**Program:** GoHighLevel feature-parity, Epic C (independent of A/B — branches off main)

## Goal

The largest GHL product area kds-marketing lacks: a **course/membership platform**
and **community spaces**. Workspaces author courses (modules → lessons), enroll
their contacts (Leads), track lesson progress, and run community spaces with
posts/comments. Built backend-first; the member-facing consumption portal (member
login realm) is a deliberate follow-up — this epic delivers the full management +
data model + enrollment/progress + community APIs, all workspace-realm.

## Decisions (controller-made)
- A **member is a Lead** (soft ref `leadId`) — contacts are the audience, matching
  GHL. No new auth realm in this epic; a member-portal login is a later unit.
- Registered as **marketing-module controllers/services** under a new
  `memberships/` folder (consistent with the codebase's Phase-F pattern), guarded
  by `MarketingGuard`/`MarketingRolesGuard`, workspace-scoped.
- Money fields are integer minor units + currency (matches `Invoice`).
- Hand-authored SQL migrations; everything workspace-isolated (arch-fitness green).

## Units (one PR-worth each; this branch holds all of Epic C)

### C1 — Courses & content (structure)
- `Course { workspaceId, title, slug, description?, status(DRAFT|PUBLISHED|ARCHIVED), priceCents?, currency?, coverImageUrl?, position }`
- `CourseModule { courseId, title, position }`
- `Lesson { moduleId, title, type(VIDEO|TEXT|PDF|QUIZ), content?, videoUrl?, durationSec?, position, isPreview }`
- `CoursesService` CRUD + nested module/lesson management + reorder; controller
  `/marketing/courses`. Publishing requires ≥1 lesson.

### C2 — Enrollment & progress
- `Enrollment { workspaceId, courseId, leadId, status(ACTIVE|COMPLETED|CANCELLED), progressPct, enrolledAt, completedAt? }` `@@unique([courseId, leadId])`
- `LessonProgress { enrollmentId, lessonId, completed, completedAt? }` `@@unique([enrollmentId, lessonId])`
- `EnrollmentService`: enroll/unenroll a Lead, `markLessonComplete` (recomputes
  `progressPct` = completed/total lessons; flips status COMPLETED at 100%),
  list enrollments per course / per lead. Controller endpoints under courses.

### C3 — Communities
- `Community { workspaceId, name, slug, description?, status(ACTIVE|ARCHIVED) }`
- `CommunityMember { communityId, leadId, role(MEMBER|MODERATOR), joinedAt }` `@@unique([communityId, leadId])`
- `CommunityPost { communityId, workspaceId, authorUserId?, authorLeadId?, title?, body, pinned }`
- `CommunityComment { postId, workspaceId, authorUserId?, authorLeadId?, body }`
- `CommunitiesService`: community CRUD, join/leave, post + comment + feed (paginated,
  pinned-first). Controller `/marketing/communities`.

## Non-goals (this epic)
- Member-facing portal + member auth realm (login/consume) — follow-up unit.
- Drip scheduling, quizzes grading logic, certificates, paid-course checkout
  (reuses existing payments later), video hosting (store URLs only).

## Testing
- Unit: courses CRUD + publish guard + reorder; enroll + progress recompute +
  complete-at-100%; community post/comment/feed + join idempotency.
- E2E: course create→add module→add lesson→publish; enroll a lead→mark lesson→
  progress; community create→post→comment.
- Arch-fitness + full existing suite stay green.

## Delivery sequence
C1 → C2 → C3, each schema → service (TDD) → controller → e2e → green regression →
commit. Pushed as one Epic-C PR against main.
