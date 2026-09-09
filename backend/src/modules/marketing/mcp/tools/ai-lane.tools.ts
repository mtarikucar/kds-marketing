import { z } from 'zod';
import { AI_EXECUTION_MODES, type AiExecutionMode } from '../../ai/ai-execution';
import { AiReplyLeaseService } from '../../ai/ai-reply-lease.service';
import { MarketingAuthService } from '../../services/marketing-auth.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface AiLaneToolDeps {
  lease: AiReplyLeaseService;
  auth: MarketingAuthService;
}

/**
 * The lane that lets a workspace's OWN Claude do its thinking.
 *
 * The platform's Anthropic key is the fallback here, not the default. That is
 * a product decision: the thing is meant to be usable by someone who already
 * has a Claude account, with the platform carrying the durable half — channels,
 * state, scheduling, sending — while their own Claude does the reasoning.
 *
 * MCP is client-to-server only. There is no `sampling` capability on this
 * server and none is coming, so nothing here can WAKE a connector; the queue
 * can only be PULLED. Every design decision in this file follows from that one
 * fact:
 *
 *  - The work waits in `scheduled_jobs` rather than being pushed anywhere.
 *  - `claim_reply_job` is a poll, so a connector needs a scheduled task to be
 *    a reliable drainer, and no amount of server-side code can supply one.
 *  - `MCP_ONLY` is therefore a promise the OWNER makes, which is why the queue
 *    depth is reported rather than assumed to be zero.
 *
 * These tools do not send. A claimed reply is composed with what the connector
 * already has (`read_conversation`, `get_agent`, `search_brand_knowledge`) and
 * sent through `jeeta.send_message`, which carries the quota, channel
 * resolution and audit trail every other reply gets. A second, thinner path to
 * messaging a customer is precisely what this must not become.
 */
export function registerAiLaneTools(registry: McpToolRegistry, deps: AiLaneToolDeps): void {
  registry.register({
    name: 'jeeta.claim_reply_job',
    description:
      'Take the next message this workspace owes a customer, and hold it while you write one. ' +
      'Returns the conversation id, how long it has been queued, and WHY — read `reason` before you ' +
      'write a word. reason "inbound" means a customer wrote and is waiting: answer them. reason ' +
      '"followup" means NOBODY wrote — the thread went quiet and the policy on that agent says ' +
      'chase it, so write one short, friendly nudge that moves the sale on, never a reply to a ' +
      'question nobody asked. Returns nothing when the queue is empty. THIS IS A POLL: the server ' +
      'cannot wake you, so a workspace that relies on its own Claude needs a scheduled task calling ' +
      'this, and one that does not have one will simply accumulate unanswered customers. Compose with ' +
      'jeeta.read_conversation and jeeta.get_agent (its persona and guardrails are what the customer ' +
      'expects to hear), send with jeeta.send_message, then close the job with ' +
      'jeeta.complete_reply_job — a lease you never close returns to the queue after a couple of ' +
      'minutes and someone answers twice.',
    domain: 'inbox',
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    // Leasing sends nothing. The gate that matters is on send_message, which
    // is where this lane's reply actually goes out.
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      const claimed = await deps.lease.claim(ctx.workspaceId);
      if (!claimed) {
        const { waiting } = await deps.lease.pending(ctx.workspaceId);
        return { job: null, waiting, reason: waiting === 0 ? 'queue-empty' : 'all-leased' };
      }
      return {
        job: claimed,
        waitedMs: Date.now() - claimed.queuedAt.getTime(),
        next:
          claimed.reason === 'followup'
            ? 'Nobody wrote — this thread went quiet. Read it, then send ONE short, friendly nudge as the attached agent that moves the sale on (a concrete next step, not a repeat of the last message), and call jeeta.complete_reply_job.'
            : 'Read the thread, write the reply as the attached agent, send it with jeeta.send_message, then call jeeta.complete_reply_job.',
      };
    },
  });

  registry.register({
    name: 'jeeta.complete_reply_job',
    description:
      'Close a reply you claimed. Pass handled: false to put it back in the queue instead — the ' +
      'honest answer when you decided NOT to write to this customer, and better than holding the ' +
      'lease until it expires. Closing does not send anything; jeeta.send_message does that. ' +
      'Closing a HANDLED job also lines up the next follow-up on the policy of that agent, so a ' +
      'customer who goes quiet after your reply still gets chased — which is why closing honestly ' +
      'matters more than it looks.',
    domain: 'inbox',
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      jobId: z.string().min(1).describe('The job id from jeeta.claim_reply_job.'),
      handled: z
        .boolean()
        .describe('true when you answered the customer; false returns the job to the queue.'),
    }),
    handler: async (ctx, args) => {
      const ok = await deps.lease.complete(
        ctx.workspaceId,
        String(args.jobId),
        args.handled === true,
      );
      return { closed: ok, reason: ok ? null : 'not-leased-by-this-workspace-or-already-closed' };
    },
  });

  registry.register({
    name: 'jeeta.get_ai_reply_queue',
    description:
      'How many customer messages are waiting for an answer, and how long the oldest has waited. ' +
      'Read this to know whether a connector-first workspace is actually being drained: under ' +
      'MCP_ONLY nothing else will ever answer these, so a number that keeps climbing is the ' +
      'symptom of a drainer that is not running. Read-only.',
    domain: 'inbox',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.lease.pending(ctx.workspaceId),
  });

  registry.register({
    name: 'jeeta.set_ai_execution',
    description:
      "Choose who does this workspace's AI work. SERVER: the platform's own key, immediately — " +
      'today\'s behaviour. AUTO (the default): your connected Claude while one is actually ' +
      'connected, the platform otherwise. MCP: your Claude gets first refusal and the platform takes ' +
      'over after a short grace window. MCP_ONLY: the platform key is NEVER used — work waits for ' +
      'your Claude for as long as that takes. MCP_ONLY is a guarantee rather than a preference, and ' +
      'the only mode that can leave a customer unanswered: nothing on the server can verify that a ' +
      'drainer exists on your side, so pair it with a scheduled task calling jeeta.claim_reply_job ' +
      'and watch jeeta.get_ai_reply_queue.',
    domain: 'workspace',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    // Same authority the panel gives an owner, reversible by setting it back,
    // and it sends nothing. What it CAN do is stop the platform answering, so
    // the description says that in the same breath as naming the mode.
    requiresApproval: false,
    inputSchema: z.object({
      mode: z
        .enum(AI_EXECUTION_MODES)
        .describe('SERVER, AUTO, MCP or MCP_ONLY. See the tool description before choosing.'),
    }),
    handler: async (ctx, args) =>
      deps.auth.setAiExecution(ctx.workspaceId, args.mode as AiExecutionMode),
  });
}
