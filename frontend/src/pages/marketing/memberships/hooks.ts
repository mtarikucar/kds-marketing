/**
 * TanStack Query hooks for the Memberships area (Epic C). Every queryFn /
 * mutationFn calls a real backend route (see types.ts for the route map). The
 * backend gates all writes behind the marketing roles guard; the routes are
 * manager-reachable via the App.tsx manager-gated realm.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type {
  Community,
  CommunityComment,
  CommunityMember,
  CommunityPost,
  Course,
  CourseWithModules,
  Enrollment,
  EnrollmentWithProgress,
} from './types';

/** Normalise either a bare array or a `{ data: [...] }` envelope to an array. */
function asArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const inner = (data as { data?: unknown })?.data;
  return Array.isArray(inner) ? (inner as T[]) : [];
}

// ── Courses ───────────────────────────────────────────────────────────────────

export const coursesKey = ['marketing', 'courses'] as const;
export const courseKey = (id: string) => ['marketing', 'courses', id] as const;

export function useCourses(): UseQueryResult<Course[]> {
  return useQuery({
    queryKey: coursesKey,
    queryFn: () => marketingApi.get('/courses').then((r) => asArray<Course>(r.data)),
  });
}

export function useCourse(id: string | undefined): UseQueryResult<CourseWithModules> {
  return useQuery({
    queryKey: courseKey(id ?? 'new'),
    enabled: !!id,
    queryFn: () => marketingApi.get(`/courses/${id}`).then((r) => r.data as CourseWithModules),
  });
}

export function useCourseMutations(courseId?: string) {
  const qc = useQueryClient();
  const invalidateList = () => qc.invalidateQueries({ queryKey: coursesKey });
  const invalidateOne = () => {
    invalidateList();
    if (courseId) qc.invalidateQueries({ queryKey: courseKey(courseId) });
  };

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/courses', payload).then((r) => r.data as Course),
    onSuccess: invalidateList,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/courses/${id}`, data).then((r) => r.data as Course),
    onSuccess: invalidateOne,
  });
  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/courses/${id}`).then((r) => r.data),
    onSuccess: invalidateList,
  });
  const publish = useMutation({
    mutationFn: (id: string) =>
      marketingApi.post(`/courses/${id}/publish`).then((r) => r.data as Course),
    onSuccess: invalidateOne,
  });

  // ── modules ──
  const addModule = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      marketingApi.post(`/courses/${id}/modules`, { title }).then((r) => r.data),
    onSuccess: invalidateOne,
  });
  const updateModule = useMutation({
    mutationFn: ({ moduleId, title }: { moduleId: string; title: string }) =>
      marketingApi.patch(`/courses/modules/${moduleId}`, { title }).then((r) => r.data),
    onSuccess: invalidateOne,
  });
  const removeModule = useMutation({
    mutationFn: (moduleId: string) =>
      marketingApi.delete(`/courses/modules/${moduleId}`).then((r) => r.data),
    onSuccess: invalidateOne,
  });
  const reorderModules = useMutation({
    mutationFn: ({ id, ids }: { id: string; ids: string[] }) =>
      marketingApi.post(`/courses/${id}/modules/reorder`, { ids }).then((r) => r.data),
    onSuccess: invalidateOne,
  });

  // ── lessons ──
  const addLesson = useMutation({
    mutationFn: ({ moduleId, data }: { moduleId: string; data: Record<string, unknown> }) =>
      marketingApi.post(`/courses/modules/${moduleId}/lessons`, data).then((r) => r.data),
    onSuccess: invalidateOne,
  });
  const updateLesson = useMutation({
    mutationFn: ({ lessonId, data }: { lessonId: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/courses/lessons/${lessonId}`, data).then((r) => r.data),
    onSuccess: invalidateOne,
  });
  const removeLesson = useMutation({
    mutationFn: (lessonId: string) =>
      marketingApi.delete(`/courses/lessons/${lessonId}`).then((r) => r.data),
    onSuccess: invalidateOne,
  });

  return {
    create,
    update,
    remove,
    publish,
    addModule,
    updateModule,
    removeModule,
    reorderModules,
    addLesson,
    updateLesson,
    removeLesson,
  };
}

// ── Enrollment / progress ─────────────────────────────────────────────────────

export const enrollmentsKey = (courseId?: string) =>
  ['marketing', 'enrollments', { courseId: courseId ?? null }] as const;
export const enrollmentKey = (id: string) => ['marketing', 'enrollments', 'one', id] as const;

export function useEnrollments(courseId?: string): UseQueryResult<Enrollment[]> {
  return useQuery({
    queryKey: enrollmentsKey(courseId),
    queryFn: () =>
      marketingApi
        .get('/enrollments', { params: { courseId: courseId || undefined } })
        .then((r) => asArray<Enrollment>(r.data)),
  });
}

export function useEnrollmentProgress(id: string | undefined): UseQueryResult<EnrollmentWithProgress> {
  return useQuery({
    queryKey: enrollmentKey(id ?? 'none'),
    enabled: !!id,
    queryFn: () =>
      marketingApi.get(`/enrollments/${id}`).then((r) => r.data as EnrollmentWithProgress),
  });
}

export function useEnrollmentMutations(courseId?: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['marketing', 'enrollments'] });
  };

  const enroll = useMutation({
    mutationFn: (payload: { courseId: string; leadId: string }) =>
      marketingApi.post('/enrollments', payload).then((r) => r.data as Enrollment),
    onSuccess: invalidate,
  });
  const unenroll = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/enrollments/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });
  const completeLesson = useMutation({
    mutationFn: ({ id, lessonId }: { id: string; lessonId: string }) =>
      marketingApi
        .post(`/enrollments/${id}/complete-lesson`, { lessonId })
        .then((r) => r.data as Enrollment),
    onSuccess: (_data, vars) => {
      invalidate();
      qc.invalidateQueries({ queryKey: enrollmentKey(vars.id) });
    },
  });

  // eslint keeps courseId referenced for callers that want a scoped invalidate.
  void courseId;
  return { enroll, unenroll, completeLesson };
}

// ── Communities ───────────────────────────────────────────────────────────────

export const communitiesKey = ['marketing', 'communities'] as const;
export const communityKey = (id: string) => ['marketing', 'communities', id] as const;
export const communityPostsKey = (id: string) => ['marketing', 'communities', id, 'posts'] as const;
export const communityMembersKey = (id: string) =>
  ['marketing', 'communities', id, 'members'] as const;
export const postCommentsKey = (postId: string) =>
  ['marketing', 'communities', 'post', postId, 'comments'] as const;

export function useCommunities(): UseQueryResult<Community[]> {
  return useQuery({
    queryKey: communitiesKey,
    queryFn: () => marketingApi.get('/communities').then((r) => asArray<Community>(r.data)),
  });
}

export function useCommunity(id: string | undefined): UseQueryResult<Community> {
  return useQuery({
    queryKey: communityKey(id ?? 'none'),
    enabled: !!id,
    queryFn: () => marketingApi.get(`/communities/${id}`).then((r) => r.data as Community),
  });
}

export function useCommunityPosts(id: string | undefined): UseQueryResult<CommunityPost[]> {
  return useQuery({
    queryKey: communityPostsKey(id ?? 'none'),
    enabled: !!id,
    queryFn: () =>
      marketingApi.get(`/communities/${id}/posts`).then((r) => asArray<CommunityPost>(r.data)),
  });
}

export function useCommunityMembers(id: string | undefined): UseQueryResult<CommunityMember[]> {
  return useQuery({
    queryKey: communityMembersKey(id ?? 'none'),
    enabled: !!id,
    queryFn: () =>
      marketingApi.get(`/communities/${id}/members`).then((r) => asArray<CommunityMember>(r.data)),
  });
}

export function usePostComments(postId: string | undefined): UseQueryResult<CommunityComment[]> {
  return useQuery({
    queryKey: postCommentsKey(postId ?? 'none'),
    enabled: !!postId,
    queryFn: () =>
      marketingApi
        .get(`/communities/posts/${postId}/comments`)
        .then((r) => asArray<CommunityComment>(r.data)),
  });
}

export function useCommunityMutations(communityId?: string) {
  const qc = useQueryClient();
  const invalidateList = () => qc.invalidateQueries({ queryKey: communitiesKey });
  const invalidateDetail = () => {
    if (communityId) {
      qc.invalidateQueries({ queryKey: communityKey(communityId) });
      qc.invalidateQueries({ queryKey: communityPostsKey(communityId) });
      qc.invalidateQueries({ queryKey: communityMembersKey(communityId) });
    }
  };

  const create = useMutation({
    mutationFn: (payload: { name: string; description?: string }) =>
      marketingApi.post('/communities', payload).then((r) => r.data as Community),
    onSuccess: invalidateList,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/communities/${id}`, data).then((r) => r.data),
    onSuccess: () => {
      invalidateList();
      invalidateDetail();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/communities/${id}`).then((r) => r.data),
    onSuccess: invalidateList,
  });

  const join = useMutation({
    mutationFn: ({ id, leadId, role }: { id: string; leadId: string; role?: string }) =>
      marketingApi.post(`/communities/${id}/join`, { leadId, role }).then((r) => r.data),
    onSuccess: invalidateDetail,
  });
  const leave = useMutation({
    mutationFn: ({ id, leadId }: { id: string; leadId: string }) =>
      marketingApi.post(`/communities/${id}/leave`, { leadId }).then((r) => r.data),
    onSuccess: invalidateDetail,
  });

  const createPost = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title?: string; body: string } }) =>
      marketingApi.post(`/communities/${id}/posts`, data).then((r) => r.data as CommunityPost),
    onSuccess: invalidateDetail,
  });
  const pinPost = useMutation({
    mutationFn: ({ postId, pinned }: { postId: string; pinned: boolean }) =>
      marketingApi.post(`/communities/posts/${postId}/pin`, { pinned }).then((r) => r.data),
    onSuccess: invalidateDetail,
  });
  const removePost = useMutation({
    mutationFn: (postId: string) =>
      marketingApi.delete(`/communities/posts/${postId}`).then((r) => r.data),
    onSuccess: invalidateDetail,
  });

  const addComment = useMutation({
    mutationFn: ({ postId, body }: { postId: string; body: string }) =>
      marketingApi
        .post(`/communities/posts/${postId}/comments`, { body })
        .then((r) => r.data as CommunityComment),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: postCommentsKey(vars.postId) }),
  });

  return {
    create,
    update,
    remove,
    join,
    leave,
    createPost,
    pinPost,
    removePost,
    addComment,
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Lightweight lead lookup for the enroll / join pickers (reuses /leads). */
export interface LeadOption {
  id: string;
  businessName: string;
  contactPerson: string;
}

export function useLeadOptions(search: string): UseQueryResult<LeadOption[]> {
  return useQuery({
    queryKey: ['marketing', 'leads', 'options', search],
    queryFn: () =>
      marketingApi
        .get('/leads', { params: { search: search || undefined, limit: 20 } })
        .then((r) => asArray<LeadOption>(r.data)),
  });
}
