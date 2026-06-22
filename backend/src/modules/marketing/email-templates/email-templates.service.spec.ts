import { NotFoundException } from '@nestjs/common';
import { EmailTemplatesService } from './email-templates.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    emailTemplate: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'et1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const svc = new EmailTemplatesService(prisma as any);
  return { svc, prisma };
}

describe('EmailTemplatesService', () => {
  it('compiles compiledHtml from the blocks on create', async () => {
    const { svc } = makeSvc();
    const res: any = await svc.create(WS, { name: 'Welcome', blocks: [{ type: 'heading', text: 'Hi' }] });
    expect(res.compiledHtml).toContain('<table');
    expect(res.compiledHtml).toContain('Hi');
    expect(res.workspaceId).toBe(WS);
  });

  it('escapes block content in the compiled HTML (no script injection)', async () => {
    const { svc } = makeSvc();
    const res: any = await svc.create(WS, { name: 'X', blocks: [{ type: 'text', text: '<script>x</script>' }] });
    expect(res.compiledHtml).not.toContain('<script>x</script>');
    expect(res.compiledHtml).toContain('&lt;script&gt;');
  });

  it('recompiles compiledHtml when blocks change on update', async () => {
    const { svc, prisma } = makeSvc();
    prisma.emailTemplate.findFirst.mockResolvedValue({ id: 'et1', workspaceId: WS, name: 'X', blocks: [], theme: null });
    await svc.update(WS, 'et1', { blocks: [{ type: 'heading', text: 'New' }] });
    const data = prisma.emailTemplate.updateMany.mock.calls[0][0].data;
    expect(data.compiledHtml).toContain('New');
  });

  it('does NOT recompile when only the name changes', async () => {
    const { svc, prisma } = makeSvc();
    prisma.emailTemplate.findFirst.mockResolvedValue({ id: 'et1', workspaceId: WS, name: 'X', blocks: [], theme: null });
    await svc.update(WS, 'et1', { name: 'Renamed' });
    const data = prisma.emailTemplate.updateMany.mock.calls[0][0].data;
    expect(data.compiledHtml).toBeUndefined();
    expect(data.name).toBe('Renamed');
  });

  it('get 404s an unknown template', async () => {
    const { svc, prisma } = makeSvc();
    prisma.emailTemplate.findFirst.mockResolvedValue(null);
    await expect(svc.get(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes all queries by workspaceId', async () => {
    const { svc, prisma } = makeSvc();
    await svc.list(WS);
    expect(prisma.emailTemplate.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS });
    await svc.remove(WS, 'et1');
    expect(prisma.emailTemplate.deleteMany.mock.calls[0][0].where).toEqual({ id: 'et1', workspaceId: WS });
  });
});
