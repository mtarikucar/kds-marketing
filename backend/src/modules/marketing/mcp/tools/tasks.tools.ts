import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { CreateTaskDto } from '../../dto/create-task.dto';
import { TaskFilterDto } from '../../dto/task-filter.dto';
import { MarketingTasksService } from '../../services/marketing-tasks.service';
import { McpPrincipalService, visibilityPrincipal } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface TasksToolDeps {
  tasks: MarketingTasksService;
  principals: McpPrincipalService;
}

const TASK_TYPES = ['CALL', 'VISIT', 'DEMO', 'FOLLOW_UP', 'MEETING', 'OTHER'] as const;
const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

/**
 * Faz 5 D1 — follow-up work items.
 *
 * Everything delegates to `MarketingTasksService`, so REP row-level ownership,
 * the workspace-timezone due-date handling, the assignee notification and the
 * `task.completed` outbox event (with its "only on a real transition" guard,
 * which is why completion goes through `complete()` and not `update()`) all
 * behave exactly as they do in the panel.
 *
 * Two attribution rules:
 *
 * - `list_tasks` is a pure read, so it uses the cheap `visibilityPrincipal()`
 *   placeholder on an API-key session — the same identity `jeeta.search_leads`
 *   has always used. It only ever reaches a `where` clause.
 * - `create_task`/`complete_task` write `MarketingTask.assignedToId`, a
 *   non-null FK, so they resolve a REAL actor.
 *
 * `create_task` adds one guard the service does not have. `MarketingTasksService`
 * checks an explicit assignee is IN the workspace but not that they are ACTIVE,
 * and it silently defaults the assignee to the actor. On an API-key session that
 * actor is the automation principal, which can never authenticate — the task
 * would sit in a queue no human ever opens. So the tool requires an explicit
 * assignee when there is no human caller, and requires that assignee to be
 * active.
 */
export function registerTasksTools(registry: McpToolRegistry, deps: TasksToolDeps): void {
  registry.register({
    name: 'jeeta.list_tasks',
    description:
      'List follow-up tasks in this workspace — filter by status, type, priority, assignee, related lead or due-date range. Read-only.',
    scopes: ['tasks.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      status: z.enum(TASK_STATUSES).optional().describe('Task status filter.'),
      type: z.enum(TASK_TYPES).optional().describe('Task type filter.'),
      priority: z.enum(TASK_PRIORITIES).optional().describe('Task priority filter.'),
      assignedToId: z.string().optional().describe('Only tasks assigned to this user id.'),
      leadId: z.string().optional().describe('Only tasks attached to this lead.'),
      dateFrom: z.string().optional().describe('Inclusive due-date start, ISO 8601 (YYYY-MM-DD).'),
      dateTo: z.string().optional().describe('Inclusive due-date end, ISO 8601 (YYYY-MM-DD).'),
      sortBy: z
        .enum(['createdAt', 'updatedAt', 'dueDate', 'title', 'type', 'status', 'priority'])
        .optional()
        .describe('Field to sort by. Defaults to dueDate.'),
      sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
      page: z.number().int().min(1).optional().describe('Page number, 1-based (default 1).'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, max 100 (default 20).'),
    }),
    handler: async (ctx, args) => {
      const actor = visibilityPrincipal(ctx);
      return deps.tasks.findAll(
        ctx.workspaceId,
        args as unknown as TaskFilterDto,
        actor.userId,
        actor.role,
      );
    },
  });

  registry.register({
    name: 'jeeta.create_task',
    description:
      'Create a follow-up task (call, visit, demo, meeting...) with a due date, optionally attached to a lead. The assignee is notified.',
    scopes: ['tasks.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      title: z.string().min(1).describe('What has to be done.'),
      type: z.enum(TASK_TYPES).describe('Kind of task.'),
      dueDate: z.string().min(1).describe('When it is due, ISO 8601 (YYYY-MM-DD or full timestamp).'),
      description: z.string().optional().describe('Longer detail / context.'),
      priority: z.enum(TASK_PRIORITIES).optional().describe('Task priority. Defaults to MEDIUM.'),
      leadId: z.string().optional().describe('Lead this task relates to.'),
      assignedToId: z
        .string()
        .optional()
        .describe(
          'User who should do the task. Required when calling with an API key; defaults to the calling user otherwise.',
        ),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      const assignedToId = typeof args.assignedToId === 'string' && args.assignedToId.length > 0 ? args.assignedToId : undefined;
      if (assignedToId) {
        await deps.principals.assertActiveMember(ctx.workspaceId, assignedToId);
      } else if (!ctx.userId) {
        // No human caller and no explicit owner: the service would default the
        // task onto the automation principal, which can never log in to do it.
        throw new BadRequestException(
          'assignedToId is required on an API-key session: there is no human caller for the task to default to',
        );
      }
      return deps.tasks.create(ctx.workspaceId, args as unknown as CreateTaskDto, actor.id);
    },
  });

  registry.register({
    name: 'jeeta.complete_task',
    description:
      'Mark a follow-up task as done. Re-completing an already-completed task is a no-op and preserves the original completion time.',
    scopes: ['tasks.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      taskId: z.string().min(1).describe('Id of the task to complete.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      return deps.tasks.complete(ctx.workspaceId, String(args.taskId), actor.id, actor.role);
    },
  });
}
