import { LinkedinLeadformPollService, mapLeadFormResponse } from './linkedin-leadform-poll.service';

/**
 * Lead Gen Form ingestion is a DEFERRED follow-up: it rides the Phase 2 ads
 * token + the partner-gated Advertising API (/rest/leadFormResponses) and is NOT
 * registered as a live @Cron yet. These tests pin the documented InboundMessage
 * mapping and prove the poller is inert until enabled, so the contract is locked
 * even though the live wiring is deferred.
 */
describe('LinkedinLeadformPollService (deferred stub)', () => {
  it('mapLeadFormResponse flattens answers into an InboundMessage tagged LINKEDIN', () => {
    const inbound = mapLeadFormResponse({
      id: 'lead-42',
      formId: 'form-1',
      submittedAt: 1,
      formResponse: {
        answers: [
          { questionId: 'q-email', answerDetails: { textQuestionAnswer: { answer: 'a@b.com' } } },
          { questionId: 'q-msg', answerDetails: { textQuestionAnswer: { answer: 'Interested!' } } },
        ],
      },
    } as any);
    expect(inbound).toMatchObject({
      externalUserId: 'urn:li:lead:lead-42',
      kind: 'LINKEDIN',
      externalMessageId: 'lead-42',
    });
    expect(inbound.text).toContain('a@b.com');
    expect(inbound.text).toContain('Interested!');
  });

  it('poll() is INERT until lead-sync is enabled (returns {ingested:0}, no HTTP)', async () => {
    const prisma = { workspace: { findMany: jest.fn().mockResolvedValue([]) } } as any;
    const ingress = { ingest: jest.fn() } as any;
    const service = new LinkedinLeadformPollService(prisma, ingress);
    const out = await service.poll();
    expect(out).toEqual({ ingested: 0 });
    expect(ingress.ingest).not.toHaveBeenCalled();
  });
});
