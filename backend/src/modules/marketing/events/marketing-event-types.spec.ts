import { MarketingEventTypes } from './marketing-event-types';

describe('MarketingEventTypes — booking lifecycle', () => {
  it('defines booking lifecycle event names under the marketing prefix', () => {
    expect(MarketingEventTypes.BookingCancelled).toBe('marketing.booking.cancelled.v1');
    expect(MarketingEventTypes.BookingUpdated).toBe('marketing.booking.updated.v1');
    expect(MarketingEventTypes.BookingRescheduled).toBe('marketing.booking.rescheduled.v1');
  });

  it('keeps all booking events under the allowlisted marketing.booking. prefix', () => {
    for (const t of [
      MarketingEventTypes.BookingCreated,
      MarketingEventTypes.BookingCancelled,
      MarketingEventTypes.BookingUpdated,
      MarketingEventTypes.BookingRescheduled,
    ]) {
      expect(t.startsWith('marketing.booking.')).toBe(true);
    }
  });
});
