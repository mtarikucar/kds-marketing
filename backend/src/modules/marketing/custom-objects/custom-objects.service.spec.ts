import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { CustomObjectsService } from './custom-objects.service';

const WS = 'ws-1';

function makePrisma() {
  const p: any = {
    customObjectDef: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    customObjectRecord: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    customObjectLink: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    lead: { findFirst: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn((arr: Promise<unknown>[]) => Promise.all(arr)),
  };
  return p;
}

const DEF = { id: 'def-1', workspaceId: WS, key: 'property', primaryField: 'name', labelSingular: 'Property' };

describe('CustomObjectsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let customFields: { list: jest.Mock; create: jest.Mock; update: jest.Mock; archive: jest.Mock; reorder: jest.Mock; validateAndNormalize: jest.Mock };
  let svc: CustomObjectsService;

  beforeEach(() => {
    prisma = makePrisma();
    customFields = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'f1' }),
      update: jest.fn().mockResolvedValue({ id: 'f1' }),
      archive: jest.fn().mockResolvedValue({ id: 'f1' }),
      reorder: jest.fn().mockResolvedValue([]),
      validateAndNormalize: jest.fn(),
    };
    svc = new CustomObjectsService(prisma as any, customFields as any);
  });

  describe('createObject', () => {
    it('rejects a duplicate key', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(DEF);
      await expect(
        svc.createObject(WS, { key: 'property', labelSingular: 'P', labelPlural: 'Ps' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates with inline workspaceId and default primaryField', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(null);
      prisma.customObjectDef.create.mockResolvedValue(DEF);
      await svc.createObject(WS, { key: 'property', labelSingular: 'Property', labelPlural: 'Properties' } as any);
      const arg = prisma.customObjectDef.create.mock.calls[0][0];
      expect(arg.data.workspaceId).toBe(WS);
      expect(arg.data.key).toBe('property');
      expect(arg.data.primaryField).toBe('name');
    });

    // TOCTOU: two concurrent same-key creates both pass findUnique; the 2nd
    // insert trips the (workspaceId, key) unique → P2002. Map to a 409, not 500.
    it('maps a P2002 race to a 409', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(null);
      prisma.customObjectDef.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      await expect(
        svc.createObject(WS, { key: 'property', labelSingular: 'P', labelPlural: 'Ps' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each(['records', 'contacts'])('rejects the reserved key "%s" (route collision)', async (key) => {
      await expect(
        svc.createObject(WS, { key, labelSingular: 'X', labelPlural: 'Xs' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.customObjectDef.create).not.toHaveBeenCalled();
    });
  });

  describe('getObject', () => {
    it('404s a missing object', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(null);
      await expect(svc.getObject(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s an object owned by another workspace (defense in depth)', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue({ ...DEF, workspaceId: 'other' });
      await expect(svc.getObject(WS, 'property')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('fields', () => {
    it('namespaces field defs by OBJ:<key> when listing/creating/reordering', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(DEF);
      await svc.listFields(WS, 'property');
      expect(customFields.list).toHaveBeenCalledWith(WS, true, 'OBJ:property');

      await svc.createField(WS, 'property', { label: 'Size', type: 'NUMBER' } as any);
      expect(customFields.create).toHaveBeenCalledWith(WS, expect.any(Object), 'OBJ:property');

      await svc.reorderFields(WS, 'property', ['a', 'b']);
      expect(customFields.reorder).toHaveBeenCalledWith(WS, ['a', 'b'], 'OBJ:property');
    });

    it('threads the OBJ:<key> entity into update/archive so a foreign field id 404s', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(DEF);
      await svc.updateField(WS, 'property', 'f9', { label: 'X' } as any);
      expect(customFields.update).toHaveBeenCalledWith(WS, 'f9', expect.any(Object), 'OBJ:property');

      await svc.archiveField(WS, 'property', 'f9');
      expect(customFields.archive).toHaveBeenCalledWith(WS, 'f9', 'OBJ:property');
    });
  });

  describe('updateObject', () => {
    it('backfills record displayNames when primaryField changes', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue({ ...DEF, primaryField: 'name' });
      prisma.customObjectDef.update.mockResolvedValue({ ...DEF, primaryField: 'code' });
      prisma.customObjectRecord.findMany
        .mockResolvedValueOnce([{ id: 'r1', values: { name: 'Old', code: 'ABC' } }])
        .mockResolvedValueOnce([]);
      prisma.customObjectRecord.update.mockResolvedValue({});

      await svc.updateObject(WS, 'property', { primaryField: 'code' } as any);

      // the record's displayName is recomputed from the NEW primary field
      const upd = prisma.customObjectRecord.update.mock.calls[0][0];
      expect(upd.data.displayName).toBe('ABC');
      // backfill query is workspace-scoped
      expect(prisma.customObjectRecord.findMany.mock.calls[0][0].where.workspaceId).toBe(WS);
    });

    it('does NOT backfill when primaryField is unchanged', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue({ ...DEF, primaryField: 'name' });
      prisma.customObjectDef.update.mockResolvedValue({ ...DEF, primaryField: 'name' });
      await svc.updateObject(WS, 'property', { labelSingular: 'Prop' } as any);
      expect(prisma.customObjectRecord.findMany).not.toHaveBeenCalled();
    });
  });

  describe('createRecord', () => {
    it('validates values, derives displayName from the primary field, inlines workspaceId', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(DEF);
      customFields.validateAndNormalize.mockResolvedValue({ name: 'Lakeview 12', size: 90 });
      prisma.customObjectRecord.create.mockResolvedValue({ id: 'r1' });

      await svc.createRecord(WS, 'property', { values: { name: 'Lakeview 12', size: 90 } } as any);

      expect(customFields.validateAndNormalize).toHaveBeenCalledWith(WS, 'OBJ:property', expect.any(Object), 'create');
      const arg = prisma.customObjectRecord.create.mock.calls[0][0];
      expect(arg.data.workspaceId).toBe(WS);
      expect(arg.data.objectDefId).toBe('def-1');
      expect(arg.data.displayName).toBe('Lakeview 12');
    });

    it('falls back to (untitled) when the primary field is empty', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(DEF);
      customFields.validateAndNormalize.mockResolvedValue({ size: 90 });
      prisma.customObjectRecord.create.mockResolvedValue({ id: 'r1' });
      await svc.createRecord(WS, 'property', { values: { size: 90 } } as any);
      expect(prisma.customObjectRecord.create.mock.calls[0][0].data.displayName).toBe('(untitled)');
    });
  });

  describe('updateRecord', () => {
    it('merges the partial values onto existing and recomputes displayName', async () => {
      prisma.customObjectRecord.findFirst.mockResolvedValue({
        id: 'r1',
        workspaceId: WS,
        values: { name: 'Old', size: 90 },
        objectDef: DEF,
      });
      customFields.validateAndNormalize.mockResolvedValue({ name: 'New' });
      prisma.customObjectRecord.update.mockResolvedValue({ id: 'r1' });

      await svc.updateRecord(WS, 'r1', { values: { name: 'New' } } as any);

      const arg = prisma.customObjectRecord.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'r1' });
      expect(arg.data.values).toEqual({ name: 'New', size: 90 }); // merged, not replaced
      expect(arg.data.displayName).toBe('New');
    });

    it('404s a record in another workspace', async () => {
      prisma.customObjectRecord.findFirst.mockResolvedValue(null);
      await expect(svc.updateRecord(WS, 'r1', { values: {} } as any)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listRecords', () => {
    it('scopes by workspace + object and applies a case-insensitive search', async () => {
      prisma.customObjectDef.findUnique.mockResolvedValue(DEF);
      prisma.customObjectRecord.findMany.mockResolvedValue([{ id: 'r1' }]);
      prisma.customObjectRecord.count.mockResolvedValue(1);

      const res = await svc.listRecords(WS, 'property', { search: 'lake' } as any);
      expect(res).toEqual({ rows: [{ id: 'r1' }], total: 1 });
      const where = prisma.customObjectRecord.findMany.mock.calls[0][0].where;
      expect(where.workspaceId).toBe(WS);
      expect(where.objectDefId).toBe('def-1');
      expect(where.displayName).toEqual({ contains: 'lake', mode: 'insensitive' });
    });
  });

  describe('linkContact', () => {
    it('rejects linking a Contact from another workspace', async () => {
      prisma.customObjectRecord.findFirst.mockResolvedValue({ id: 'r1', workspaceId: WS, objectDef: DEF });
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(
        svc.linkContact(WS, 'r1', { leadId: 'lead-x' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.customObjectLink.upsert).not.toHaveBeenCalled();
    });

    it('idempotently upserts the link with an inline workspaceId', async () => {
      prisma.customObjectRecord.findFirst.mockResolvedValue({ id: 'r1', workspaceId: WS, objectDef: DEF });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' });
      prisma.customObjectLink.upsert.mockResolvedValue({ id: 'lnk-1' });

      await svc.linkContact(WS, 'r1', { leadId: 'lead-1', label: 'owner' } as any);
      const arg = prisma.customObjectLink.upsert.mock.calls[0][0];
      expect(arg.where.recordId_leadId).toEqual({ recordId: 'r1', leadId: 'lead-1' });
      expect(arg.create.workspaceId).toBe(WS);
      expect(arg.create.label).toBe('owner');
    });
  });

  describe('listRecordContacts', () => {
    it('resolves linked leads and returns null contact for a deleted lead', async () => {
      prisma.customObjectLink.findMany.mockResolvedValue([
        { id: 'lnk-1', leadId: 'lead-1', label: 'owner' },
        { id: 'lnk-2', leadId: 'gone', label: null },
      ]);
      prisma.lead.findMany.mockResolvedValue([
        { id: 'lead-1', businessName: 'Acme', contactPerson: 'Jo', phone: null, email: null },
      ]);
      const res = await svc.listRecordContacts(WS, 'r1');
      expect(res[0].contact).toMatchObject({ businessName: 'Acme' });
      expect(res[1].contact).toBeNull();
      // leads are fetched scoped to the workspace
      expect(prisma.lead.findMany.mock.calls[0][0].where.workspaceId).toBe(WS);
    });

    it('short-circuits with no DB lead lookup when there are no links', async () => {
      prisma.customObjectLink.findMany.mockResolvedValue([]);
      const res = await svc.listRecordContacts(WS, 'r1');
      expect(res).toEqual([]);
      expect(prisma.lead.findMany).not.toHaveBeenCalled();
    });
  });

  describe('unlinkContact', () => {
    it('404s a link not owned by the workspace/record', async () => {
      prisma.customObjectLink.findFirst.mockResolvedValue(null);
      await expect(svc.unlinkContact(WS, 'r1', 'lnk-x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
