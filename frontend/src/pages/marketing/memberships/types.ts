/**
 * Epic C — Memberships (courses · enrollment/progress · communities) shared types.
 *
 * These mirror the backend Prisma shapes / DTO contracts so a payload that
 * passes the frontend always round-trips through the API. Backend remains the
 * source of truth; these exist to type the TanStack Query layer and the forms.
 *
 * Routes (all under `marketingApi` baseURL `${API_URL}/marketing`):
 *   courses      GET/POST   /courses                 GET/PATCH/DELETE /courses/:id
 *                POST /courses/:id/publish           POST /courses/:id/modules
 *                POST /courses/:id/modules/reorder
 *                PATCH/DELETE /courses/modules/:moduleId
 *                POST /courses/modules/:moduleId/lessons
 *                PATCH/DELETE /courses/lessons/:lessonId
 *   enrollments  GET/POST   /enrollments            GET/DELETE /enrollments/:id
 *                POST /enrollments/:id/complete-lesson
 *   communities  GET/POST   /communities            GET/PATCH/DELETE /communities/:id
 *                POST /communities/:id/join          POST /communities/:id/leave
 *                GET  /communities/:id/members
 *                GET/POST /communities/:id/posts
 *                POST /communities/posts/:postId/pin
 *                DELETE /communities/posts/:postId
 *                GET/POST /communities/posts/:postId/comments
 */

// ── Courses ───────────────────────────────────────────────────────────────────

export type CourseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type LessonType = 'VIDEO' | 'TEXT' | 'PDF' | 'QUIZ';

export type Gating = 'FREE' | 'SEQUENTIAL' | 'DRIP';

export interface Lesson {
  id: string;
  moduleId: string;
  title: string;
  type: LessonType;
  content: string | null;
  videoUrl: string | null;
  durationSec: number | null;
  isPreview: boolean;
  // Epic 10a drip / gating.
  gating: Gating;
  dripDays: number | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CourseModule {
  id: string;
  courseId: string;
  title: string;
  position: number;
  lessons: Lesson[];
  createdAt: string;
  updatedAt: string;
}

export interface Course {
  id: string;
  workspaceId: string;
  title: string;
  slug: string;
  description: string | null;
  status: CourseStatus;
  priceCents: number | null;
  currency: string | null;
  coverImageUrl: string | null;
  /** Course-level default lesson gating (Epic 10a drip). */
  dripMode: Gating | null;
  /** Completion certificates (Epic 10b). */
  certificateEnabled: boolean;
  certificateTemplate: CertificateTemplate | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CertificateTemplate {
  title?: string;
  signature?: string;
  logoUrl?: string;
}

/** A course-completion certificate (Epic 10b). */
export interface Certificate {
  id: string;
  workspaceId: string;
  enrollmentId: string;
  courseId: string;
  leadId: string;
  serial: string;
  issuedAt: string;
  pdfUrl: string | null;
}

/** GET /courses/:id eagerly includes ordered modules → lessons. */
export interface CourseWithModules extends Course {
  modules: CourseModule[];
}

// ── Enrollment / progress ─────────────────────────────────────────────────────

export type EnrollmentStatus = 'ACTIVE' | 'COMPLETED';

export interface LessonProgress {
  id: string;
  enrollmentId: string;
  lessonId: string;
  completed: boolean;
  completedAt: string | null;
}

export interface Enrollment {
  id: string;
  workspaceId: string;
  courseId: string;
  leadId: string;
  status: EnrollmentStatus;
  progressPct: number;
  enrolledAt: string;
  completedAt: string | null;
}

/** Per-lesson access state (Epic 10a drip) returned alongside progress. */
export interface LessonAccessState {
  lessonId: string;
  completed: boolean;
  locked: boolean;
  unlockAt: string | null;
  lockReason: 'SEQUENTIAL' | 'DRIP' | null;
}

/** GET /enrollments/:id returns the enrollment + its per-lesson progress rows. */
export interface EnrollmentWithProgress extends Enrollment {
  progress: LessonProgress[];
  /** Per-lesson lock state for the member view (Epic 10a). */
  lessons: LessonAccessState[];
}

// ── Communities ───────────────────────────────────────────────────────────────

export type CommunityStatus = 'ACTIVE' | 'ARCHIVED';
export type CommunityRole = 'MEMBER' | 'MODERATOR';

export interface Community {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  status: CommunityStatus;
  createdAt: string;
  updatedAt: string;
  /** Present on the detail (GET /communities/:id) response. */
  _count?: { members: number; posts: number };
}

export interface CommunityMember {
  id: string;
  communityId: string;
  leadId: string;
  role: CommunityRole;
  joinedAt: string;
}

export interface CommunityPost {
  id: string;
  communityId: string;
  workspaceId: string;
  authorUserId: string;
  title: string | null;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present on the list (GET /communities/:id/posts) response. */
  _count?: { comments: number };
}

export interface CommunityComment {
  id: string;
  postId: string;
  workspaceId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}
