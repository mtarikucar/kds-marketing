import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ConversationIngressService } from './conversation-ingress.service';
import { InboundMessage } from './channel-adapter.interface';

/**
 * DEFERRED FOLLOW-UP — LinkedIn Lead Gen Form ingestion.
 *
 * Lead responses are fetched from the Advertising API lead-sync endpoint:
 *   GET /rest/leadFormResponses
 *       ?q=owner
 *       &owner=(sponsoredAccount:urn:li:sponsoredAccount:{adAccountId})
 *   (paginated by start/count; element:
 *    { id, formId, submittedAt, formResponse:{ answers:[{ questionId,
 *      answerDetails:{ textQuestionAnswer:{ answer } } }] } })
 *
 * This rides the PHASE 2 ADS token (NOT the social-app token used by the
 * comment poller) + the partner-gated r_marketing_leadgen_automation scope, so
 * it is shipped as a documented STUB behind the same capability flag and is NOT
 * registered as a live @Cron. poll() is inert until lead-sync is wired.
 */
@Injectable()
export class LinkedinLeadformPollService {
  private readonly logger = new Logger(LinkedinLeadformPollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingress: ConversationIngressService,
  ) {}

  /** Inert until lead-sync (Advertising API partner access) is enabled. */
  async poll(): Promise<{ ingested: number }> {
    // Deferred: when enabled, for each workspace ads account with the leadgen
    // scope, GET /rest/leadFormResponses (paginated), map each element via
    // mapLeadFormResponse, and ingress.ingest({...,type:'LINKEDIN'}, inbound).
    // ingest()'s externalMessageId dedup (response.id) makes re-polling safe.
    return { ingested: 0 };
  }
}

/**
 * Map one LinkedIn lead-form response into a transport-agnostic InboundMessage.
 * Pure + exported so the documented mapping is unit-locked even while the live
 * poller is deferred.
 */
export function mapLeadFormResponse(response: any): InboundMessage {
  const answers: any[] = response?.formResponse?.answers ?? [];
  const text = answers
    .map((a) => {
      const ans = a?.answerDetails?.textQuestionAnswer?.answer ?? '';
      return `${a?.questionId ?? 'q'}: ${ans}`;
    })
    .join('\n');
  // First answer that looks like an email is used to name the lead, else null.
  const email = answers
    .map((a) => a?.answerDetails?.textQuestionAnswer?.answer ?? '')
    .find((v) => typeof v === 'string' && v.includes('@'));
  return {
    externalUserId: `urn:li:lead:${response?.id ?? ''}`,
    kind: 'LINKEDIN',
    externalMessageId: response?.id != null ? String(response.id) : null,
    text,
    displayName: email || null,
    raw: response,
  };
}
