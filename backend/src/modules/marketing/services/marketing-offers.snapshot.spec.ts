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
