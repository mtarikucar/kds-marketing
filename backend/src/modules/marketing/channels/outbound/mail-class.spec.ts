import { GATE_MATRIX, GateSet, MAIL_CLASSES, MailClass, gateApplies } from './mail-class';

/**
 * The gate matrix is the contract.
 *
 * There is deliberately no single `send()` every mail passes through: an
 * invoice must reach a customer who unticked marketing mail, a booking
 * confirmation must never acquire a `List-Unsubscribe` header, and a password
 * reset must never carry a tenant's Reply-To. Those are five different
 * policies, so the mail is TYPED and the table below is the policy — read as
 * data by the guard, asserted here cell by cell.
 *
 * A test that restates the table is usually noise. This one is not: every ❌ in
 * it is a verifier's explicit warning about a working sibling path, and the
 * cheapest way to break one is to "tidy up" the matrix.
 */
describe('MailClass / GATE_MATRIX', () => {
  it('covers exactly the five classes, and MAIL_CLASSES lists them', () => {
    expect(MAIL_CLASSES).toEqual(['AUTH', 'INTERNAL', 'TRANSACTIONAL', 'CONVERSATIONAL', 'BULK']);
    expect(Object.keys(GATE_MATRIX).sort()).toEqual([...MAIL_CLASSES].sort());
  });

  const table: Array<[MailClass, GateSet]> = [
    [
      'AUTH',
      {
        // Account/security mail. Platform identity only: it is blocked by
        // nothing a tenant or a recipient can set, because a password reset
        // that a stale bounce row suppresses locks the owner out for good
        // (no-password-recovery).
        singleRecipient: 'always',
        erasure: 'always',
        hardBounce: 'never',
        optOut: 'never',
        complaint: 'never',
        iysEposta: 'never',
        unsubscribe: 'never',
        replyTo: 'never',
        viaDisplayName: 'never',
        threading: 'never',
        autoSubmitted: 'never',
        messageQuota: 'never',
        workspaceActive: 'never',
        sendingPaused: 'never',
        dailyCap: 'never',
        quietHours: 'never',
        leadActivity: 'never',
        mailLog: 'always',
      },
    ],
    [
      'INTERNAL',
      {
        // Mail to OUR OWN users about the product: digest, host reminder, team
        // invite. Not a lead, so no suppression and no trace; not the tenant's
        // mail, so it is NOT metered against messagesMonthly.
        singleRecipient: 'always',
        erasure: 'never',
        hardBounce: 'never',
        optOut: 'never',
        complaint: 'never',
        iysEposta: 'never',
        unsubscribe: 'never',
        replyTo: 'never',
        viaDisplayName: 'never',
        threading: 'never',
        autoSubmitted: 'never',
        messageQuota: 'never',
        workspaceActive: 'never',
        sendingPaused: 'never',
        dailyCap: 'never',
        quietHours: 'never',
        leadActivity: 'never',
        mailLog: 'always',
      },
    ],
    [
      'TRANSACTIONAL',
      {
        // The tenant's business mail to one named customer. It must reach a
        // customer who unticked marketing mail, and it must never carry an
        // unsubscribe header.
        singleRecipient: 'always',
        erasure: 'always',
        hardBounce: 'always',
        optOut: 'never',
        complaint: 'never',
        iysEposta: 'never',
        unsubscribe: 'never',
        replyTo: 'always',
        viaDisplayName: 'always',
        threading: 'never',
        autoSubmitted: 'never',
        messageQuota: 'always',
        workspaceActive: 'always',
        sendingPaused: 'always',
        dailyCap: 'always',
        quietHours: 'never',
        leadActivity: 'always',
        mailLog: 'always',
      },
    ],
    [
      'CONVERSATIONAL',
      {
        // Thread-bound 1:1. The consent gates apply only when WE reach out
        // first: an address that just sent us a message is demonstrably live
        // and demonstrably talking to us, so refusing to answer it would be
        // the regression (replies-skip-consent).
        singleRecipient: 'always',
        erasure: 'always',
        hardBounce: 'proactive',
        optOut: 'proactive',
        complaint: 'proactive',
        iysEposta: 'never',
        unsubscribe: 'never',
        replyTo: 'n/a',
        viaDisplayName: 'n/a',
        threading: 'always',
        autoSubmitted: 'ai',
        messageQuota: 'always',
        workspaceActive: 'always',
        sendingPaused: 'always',
        dailyCap: 'always',
        quietHours: 'proactive',
        leadActivity: 'message',
        mailLog: 'always',
      },
    ],
    [
      'BULK',
      {
        // Marketing to a list. Everything applies, and the unsubscribe is fail
        // closed: no token, no send.
        singleRecipient: 'always',
        erasure: 'always',
        hardBounce: 'always',
        optOut: 'always',
        complaint: 'always',
        iysEposta: 'ticari',
        unsubscribe: 'always',
        replyTo: 'always',
        viaDisplayName: 'always',
        threading: 'never',
        autoSubmitted: 'never',
        messageQuota: 'always',
        workspaceActive: 'always',
        sendingPaused: 'always',
        dailyCap: 'always',
        quietHours: 'always',
        leadActivity: 'always',
        mailLog: 'always',
      },
    ],
  ];

  it.each(table)('pins the gate set for %s', (mailClass, gates) => {
    expect(GATE_MATRIX[mailClass]).toEqual(gates);
  });

  it('never lets a mail out to more than one address, whatever its class', () => {
    for (const cls of MAIL_CLASSES) expect(GATE_MATRIX[cls].singleRecipient).toBe('always');
  });

  it('writes a ledger row for every class, including a refusal-prone one', () => {
    // `LeadActivity.leadId` is NOT NULL, so digests, host reminders, invites
    // and AUTH mail leave no queryable row at all without MailLog — and that
    // is exactly the mail an operator gets paged about.
    for (const cls of MAIL_CLASSES) expect(GATE_MATRIX[cls].mailLog).toBe('always');
  });

  it('requires the unsubscribe pair on BULK and on nothing else', () => {
    // A one-to-one reply that acquires `List-Unsubscribe` is telling Gmail it
    // is a mailing list; a campaign without it is what Gmail and Yahoo have
    // refused from bulk senders since February 2024.
    for (const cls of MAIL_CLASSES) {
      expect(GATE_MATRIX[cls].unsubscribe).toBe(cls === 'BULK' ? 'always' : 'never');
    }
  });

  it('keeps AUTH unblockable and unbranded', () => {
    const auth = GATE_MATRIX.AUTH;
    // A tenant Reply-To on a password reset is a phishing shape, and a
    // "<Marka> via Jeeta" display name on one relabels platform security mail
    // as the tenant's.
    expect(auth.replyTo).toBe('never');
    expect(auth.viaDisplayName).toBe('never');
    for (const gate of ['optOut', 'hardBounce', 'complaint', 'workspaceActive', 'sendingPaused', 'dailyCap', 'messageQuota'] as const) {
      expect(auth[gate]).toBe('never');
    }
    // The one thing that does stop it: a KVKK erasure tombstone.
    expect(auth.erasure).toBe('always');
  });

  it('does not meter INTERNAL mail against the tenant plan', () => {
    // Metering the daily digest against messagesMonthly would spend a paying
    // customer's quota on mail we send to ourselves.
    expect(GATE_MATRIX.INTERNAL.messageQuota).toBe('never');
    expect(GATE_MATRIX.INTERNAL.replyTo).toBe('never');
  });

  describe('gateApplies', () => {
    it('reads always/never without context', () => {
      expect(gateApplies('always', {})).toBe(true);
      expect(gateApplies('never', { proactive: true, ticari: true, aiAuthored: true })).toBe(false);
    });

    it('turns the proactive gates on only when we reach out first', () => {
      expect(gateApplies('proactive', { proactive: true })).toBe(true);
      expect(gateApplies('proactive', { proactive: false })).toBe(false);
      expect(gateApplies('proactive', {})).toBe(false);
    });

    it('applies the İYS gate to commercial mail only', () => {
      expect(gateApplies('ticari', { ticari: true })).toBe(true);
      expect(gateApplies('ticari', { ticari: false })).toBe(false);
    });

    it('adds Auto-Submitted for an AI author and never for a human', () => {
      expect(gateApplies('ai', { aiAuthored: true })).toBe(true);
      expect(gateApplies('ai', { aiAuthored: false })).toBe(false);
    });

    it('treats n/a and message as "not this path", so neither can be read as truthy', () => {
      // 'message' means the conversation's own Message row is the trace — the
      // gateway must not write a second LeadActivity beside it.
      expect(gateApplies('message', { proactive: true })).toBe(false);
      // 'n/a' means the class never reaches the platform transport where that
      // gate lives, not that the gate was considered and declined.
      expect(gateApplies('n/a', { proactive: true })).toBe(false);
    });

    it('answers for a whole class the way the guard will ask', () => {
      const bulk = GATE_MATRIX.BULK;
      expect(gateApplies(bulk.optOut, {})).toBe(true);
      const convo = GATE_MATRIX.CONVERSATIONAL;
      expect(gateApplies(convo.optOut, { proactive: false })).toBe(false);
      expect(gateApplies(convo.optOut, { proactive: true })).toBe(true);
    });
  });
});
