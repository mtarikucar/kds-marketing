import { MarketingOffersService } from "./marketing-offers.service";
import { mockPrismaClient, MockPrismaClient } from "../../../common/test/prisma-mock.service";

/**
 * Step E: offer-create snapshots the plan's display facts via the port, so the
 * offer stays self-contained once the plan FK is dropped. Marketing never reads
 * SubscriptionPlan — it asks the port.
 */
describe("MarketingOffersService.create — plan snapshot", () => {
  let prisma: MockPrismaClient;
  let provisioning: { describePlan: jest.Mock };
  let svc: MarketingOffersService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    provisioning = { describePlan: jest.fn() };
    svc = new MarketingOffersService(prisma as any, provisioning as any);
    // create() resolves the lead via a workspace-scoped findFirst.
    prisma.lead.findFirst.mockResolvedValue({
      id: "lead-1",
      workspaceId: "ws-1",
      assignedToId: "rep-1",
    } as any);
    prisma.leadOffer.create.mockResolvedValue({ id: "offer-1" } as any);
  });

  it("snapshots plan display facts from the port onto the offer", async () => {
    provisioning.describePlan.mockResolvedValue({
      planCode: "PRO",
      planName: "Profesyonel",
      monthlyPrice: 1299,
      currency: "TRY",
    });

    await svc.create(
      "ws-1",
      { leadId: "lead-1", planId: "plan-pro", customPrice: 999 } as any,
      "rep-1",
      "REP",
    );

    expect(prisma.lead.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "lead-1", workspaceId: "ws-1" }),
      }),
    );
    expect(provisioning.describePlan).toHaveBeenCalledWith("plan-pro");
    expect(prisma.leadOffer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          planId: "plan-pro",
          planCode: "PRO",
          planName: "Profesyonel",
          planMonthlyPrice: 1299,
          planCurrency: "TRY",
          customPrice: 999,
        }),
      }),
    );
  });

  it("stores null snapshot fields and skips the port when no planId is given", async () => {
    await svc.create("ws-1", { leadId: "lead-1", customPrice: 500 } as any, "rep-1", "REP");

    expect(provisioning.describePlan).not.toHaveBeenCalled();
    expect(prisma.leadOffer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          planCode: null,
          planName: null,
          planMonthlyPrice: null,
          planCurrency: null,
        }),
      }),
    );
  });

  it("stores nulls when the port cannot resolve the plan", async () => {
    provisioning.describePlan.mockResolvedValue(null);

    await svc.create("ws-1", { leadId: "lead-1", planId: "unknown" } as any, "rep-1", "REP");

    expect(prisma.leadOffer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          planId: "unknown",
          planCode: null,
          planMonthlyPrice: null,
        }),
      }),
    );
  });
});

/**
 * update() uses an explicit field allow-list and DELIBERATELY drops `status`:
 * offer state transitions are owned by markSent()/convert(), so a client must
 * not be able to flip an offer's status through the generic PATCH and bypass
 * those guarded flows.
 */
describe("MarketingOffersService.update — status is not mass-assigned", () => {
  let prisma: MockPrismaClient;
  let provisioning: { describePlan: jest.Mock };
  let svc: MarketingOffersService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    provisioning = { describePlan: jest.fn() };
    svc = new MarketingOffersService(prisma as any, provisioning as any);
    // update() resolves the offer via a workspace-scoped findFirst.
    prisma.leadOffer.findFirst.mockResolvedValue({
      id: "offer-1",
      workspaceId: "ws-1",
      createdById: "rep-1",
      status: "DRAFT",
    } as any);
    prisma.leadOffer.update.mockResolvedValue({ id: "offer-1" } as any);
  });

  it("ignores a client-supplied status (no `status` key reaches prisma.update)", async () => {
    await svc.update(
      "ws-1",
      "offer-1",
      { notes: "revised", status: "ACCEPTED" } as any,
      "rep-1",
      "REP",
    );

    expect(prisma.leadOffer.update).toHaveBeenCalledTimes(1);
    const updateArgs = (prisma.leadOffer.update as any).mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty("status");
    // Allowed fields still flow through.
    expect(updateArgs.data).toMatchObject({ notes: "revised" });
  });

  // Changing an offer's plan must RE-SNAPSHOT its display facts, exactly as
  // create() does. Otherwise the offer keeps the OLD plan's name/price/currency
  // while pointing at a different planId — the customer is shown stale terms.
  it("re-snapshots plan facts from the port when planId changes", async () => {
    provisioning.describePlan.mockResolvedValue({
      planCode: "ENT",
      planName: "Kurumsal",
      monthlyPrice: 4999,
      currency: "TRY",
    });

    await svc.update("ws-1", "offer-1", { planId: "plan-ent" } as any, "rep-1", "REP");

    expect(provisioning.describePlan).toHaveBeenCalledWith("plan-ent");
    const data = (prisma.leadOffer.update as any).mock.calls[0][0].data;
    expect(data).toMatchObject({
      planId: "plan-ent",
      planCode: "ENT",
      planName: "Kurumsal",
      planMonthlyPrice: 4999,
      planCurrency: "TRY",
    });
  });

  // Clearing the plan (planId → '') must null the snapshot, mirroring create's
  // no-plan path — not leave the previous plan's facts dangling.
  it("nulls the snapshot when the plan is cleared", async () => {
    await svc.update("ws-1", "offer-1", { planId: "" } as any, "rep-1", "REP");

    expect(provisioning.describePlan).not.toHaveBeenCalled();
    const data = (prisma.leadOffer.update as any).mock.calls[0][0].data;
    expect(data).toMatchObject({
      planId: "",
      planCode: null,
      planName: null,
      planMonthlyPrice: null,
      planCurrency: null,
    });
  });

  // When planId is NOT part of the patch, the snapshot must be left untouched
  // (no port call, no snapshot keys that would overwrite the stored facts).
  it("leaves the snapshot untouched when planId is omitted", async () => {
    await svc.update("ws-1", "offer-1", { notes: "x" } as any, "rep-1", "REP");

    expect(provisioning.describePlan).not.toHaveBeenCalled();
    const data = (prisma.leadOffer.update as any).mock.calls[0][0].data;
    expect(data).not.toHaveProperty("planId");
    expect(data).not.toHaveProperty("planName");
  });
});
