# Epic A1 — Custom Fields — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace-scoped, typed custom fields to Leads — a `CustomFieldDef` registry + a validated `Lead.customFields` JSONB column — following existing `marketing` module conventions.

**Architecture:** Hybrid storage: typed definitions in `custom_field_defs`; values in `leads.customFields` (JSONB + GIN). A `CustomFieldsService` owns def CRUD and a `validateAndNormalize()` seam that `MarketingLeadsService.create/update` call before persisting. Read responses include `customFields`. A domain event fires on value change for later workflow triggers.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL, hand-authored SQL migrations), Jest + `jest-mock-extended` (`mockPrismaClient()`), class-validator DTOs.

---

## File structure

- Create `backend/prisma/migrations/20260615190000_custom_fields/migration.sql` — `custom_field_defs` table + `leads.customFields` column + GIN index.
- Modify `backend/prisma/schema.prisma` — add `CustomFieldDef` model + `Lead.customFields` + GIN `@@index`.
- Create `backend/src/modules/marketing/dto/custom-field.dto.ts` — DTOs + `CustomFieldType` enum.
- Create `backend/src/modules/marketing/services/custom-fields.service.ts` — def CRUD + `validateAndNormalize`.
- Create `backend/src/modules/marketing/services/custom-fields.service.spec.ts` — unit tests.
- Create `backend/src/modules/marketing/controllers/marketing-custom-fields.controller.ts` — REST + `@Audit`.
- Modify `backend/src/modules/marketing/marketing.module.ts` — register provider + controller.
- Modify `backend/src/modules/marketing/dto/create-lead.dto.ts` — optional `customFields`.
- Modify `backend/src/modules/marketing/services/marketing-leads.service.ts` — inject `CustomFieldsService`, validate on create/update, emit event.
- Modify existing leads specs that positionally construct `MarketingLeadsService` — add the new constructor arg.

---

## Task 1: Prisma schema + migration

**Files:** Modify `backend/prisma/schema.prisma`; Create `backend/prisma/migrations/20260615190000_custom_fields/migration.sql`

- [ ] **Step 1: Add the `CustomFieldDef` model + `Lead.customFields`** to `schema.prisma`

```prisma
model CustomFieldDef {
  id          String   @id @default(uuid())
  workspaceId String
  entity      String   @default("LEAD")
  key         String
  label       String
  type        String   // TEXT|TEXTAREA|NUMBER|DATE|DATETIME|BOOL|SELECT|MULTISELECT|URL|PHONE|EMAIL
  options     Json?
  required    Boolean  @default(false)
  position    Int      @default(0)
  archived    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([workspaceId, entity, key])
  @@index([workspaceId, entity, archived])
  @@map("custom_field_defs")
}
```
In `model Lead`, add (near `notes`): `customFields Json @default("{}")` and in the index block add `@@index([customFields], type: Gin)`.

- [ ] **Step 2: Write the migration SQL**

```sql
-- Migration: custom field definitions + leads.customFields (Epic A1)
CREATE TABLE "custom_field_defs" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "entity"      TEXT NOT NULL DEFAULT 'LEAD',
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "options"     JSONB,
  "required"    BOOLEAN NOT NULL DEFAULT false,
  "position"    INTEGER NOT NULL DEFAULT 0,
  "archived"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_field_defs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "custom_field_defs_workspaceId_entity_key_key"
  ON "custom_field_defs" ("workspaceId", "entity", "key");
CREATE INDEX "custom_field_defs_workspaceId_entity_archived_idx"
  ON "custom_field_defs" ("workspaceId", "entity", "archived");

ALTER TABLE "leads" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX "leads_customFields_gin" ON "leads" USING GIN ("customFields" jsonb_path_ops);
```

- [ ] **Step 3: Regenerate the Prisma client** (offline — no DB needed)

Run: `npx prisma generate`
Expected: "Generated Prisma Client" — `customFieldDef` now exists on the client + `Lead.customFields` typed.

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260615190000_custom_fields/
git commit -m "feat(custom-fields): schema + migration (custom_field_defs, leads.customFields JSONB+GIN)"
```

---

## Task 2: DTOs + `CustomFieldType` enum

**Files:** Create `backend/src/modules/marketing/dto/custom-field.dto.ts`

- [ ] **Step 1: Write the DTOs**

```typescript
import {
  IsBoolean, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional,
  IsString, MaxLength, Matches, ArrayNotEmpty, IsArray,
} from 'class-validator';

export enum CustomFieldType {
  TEXT = 'TEXT', TEXTAREA = 'TEXTAREA', NUMBER = 'NUMBER',
  DATE = 'DATE', DATETIME = 'DATETIME', BOOL = 'BOOL',
  SELECT = 'SELECT', MULTISELECT = 'MULTISELECT',
  URL = 'URL', PHONE = 'PHONE', EMAIL = 'EMAIL',
}

export class CreateCustomFieldDefDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  label: string;

  // optional explicit slug; else derived from label. lower snake/kebab only.
  @IsOptional() @IsString() @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'key must be lower_snake_case' })
  key?: string;

  @IsEnum(CustomFieldType)
  type: CustomFieldType;

  @IsOptional() @IsArray()
  options?: { value: string; label: string }[];

  @IsOptional() @IsBoolean()
  required?: boolean;

  @IsOptional() @IsInt()
  position?: number;
}

// key + type are immutable; only label/options/required/position update.
export class UpdateCustomFieldDefDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80)
  label?: string;
  @IsOptional() @IsArray()
  options?: { value: string; label: string }[];
  @IsOptional() @IsBoolean()
  required?: boolean;
  @IsOptional() @IsInt()
  position?: number;
}

export class ReorderCustomFieldsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  ids: string[];
}
```

- [ ] **Step 2: Verify it compiles** — Run: `npx tsc --noEmit -p backend/tsconfig.json` (or rely on the next task's test run). Expected: no errors in this file.

---

## Task 3: `CustomFieldsService` — value validation (TDD core)

**Files:** Create `backend/src/modules/marketing/services/custom-fields.service.ts`; Create `backend/src/modules/marketing/services/custom-fields.service.spec.ts`

- [ ] **Step 1: Write the failing test for `validateAndNormalize`**

```typescript
import { BadRequestException } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';
const defs = [
  { id: 'd1', workspaceId: WS, entity: 'LEAD', key: 'budget', type: 'NUMBER', options: null, required: false, archived: false },
  { id: 'd2', workspaceId: WS, entity: 'LEAD', key: 'tier', type: 'SELECT', options: [{ value: 'gold', label: 'Gold' }], required: true, archived: false },
  { id: 'd3', workspaceId: WS, entity: 'LEAD', key: 'signed', type: 'BOOL', options: null, required: false, archived: false },
];

describe('CustomFieldsService.validateAndNormalize', () => {
  let prisma: MockPrismaClient;
  let svc: CustomFieldsService;
  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new CustomFieldsService(prisma as any, { append: jest.fn() } as any);
    prisma.customFieldDef.findMany.mockResolvedValue(defs as any);
  });

  it('coerces NUMBER + BOOL and passes through valid SELECT', async () => {
    const out = await svc.validateAndNormalize(WS, 'LEAD', { budget: '1500', tier: 'gold', signed: 'true' }, 'create');
    expect(out).toEqual({ budget: 1500, tier: 'gold', signed: true });
  });

  it('rejects a SELECT value not in options', async () => {
    await expect(svc.validateAndNormalize(WS, 'LEAD', { tier: 'platinum' }, 'create'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-numeric NUMBER', async () => {
    await expect(svc.validateAndNormalize(WS, 'LEAD', { budget: 'abc', tier: 'gold' }, 'create'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces required on create, but not on update', async () => {
    await expect(svc.validateAndNormalize(WS, 'LEAD', { budget: 10 }, 'create'))
      .rejects.toBeInstanceOf(BadRequestException); // tier missing
    await expect(svc.validateAndNormalize(WS, 'LEAD', { budget: 10 }, 'update'))
      .resolves.toEqual({ budget: 10 });
  });

  it('drops unknown keys', async () => {
    const out = await svc.validateAndNormalize(WS, 'LEAD', { tier: 'gold', bogus: 'x' }, 'create');
    expect(out).toEqual({ tier: 'gold' });
  });

  it('returns {} for empty/undefined input on update', async () => {
    expect(await svc.validateAndNormalize(WS, 'LEAD', undefined, 'update')).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx jest src/modules/marketing/services/custom-fields.service.spec.ts` Expected: FAIL (module not found).

- [ ] **Step 3: Implement `CustomFieldsService`**

```typescript
import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { CreateCustomFieldDefDto, UpdateCustomFieldDefDto } from '../dto/custom-field.dto';

const URL_RE = /^https?:\/\/.+/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Injectable()
export class CustomFieldsService {
  constructor(private prisma: PrismaService, private outbox: OutboxService) {}

  async list(workspaceId: string, includeArchived = false) {
    return this.prisma.customFieldDef.findMany({
      where: { workspaceId, entity: 'LEAD', ...(includeArchived ? {} : { archived: false }) },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private slugify(label: string) {
    return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'field';
  }

  async create(workspaceId: string, dto: CreateCustomFieldDefDto) {
    const key = dto.key ?? this.slugify(dto.label);
    const dupe = await this.prisma.customFieldDef.findUnique({
      where: { workspaceId_entity_key: { workspaceId, entity: 'LEAD', key } },
    });
    if (dupe) throw new ConflictException(`Custom field key "${key}" already exists`);
    if ((dto.type === 'SELECT' || dto.type === 'MULTISELECT') && !(dto.options?.length))
      throw new BadRequestException('SELECT/MULTISELECT requires options');
    return this.prisma.customFieldDef.create({
      data: { workspaceId, entity: 'LEAD', key, label: dto.label, type: dto.type,
        options: dto.options ?? undefined, required: dto.required ?? false, position: dto.position ?? 0 },
    });
  }

  private async getOwned(workspaceId: string, id: string) {
    const def = await this.prisma.customFieldDef.findFirst({ where: { id, workspaceId } });
    if (!def) throw new NotFoundException('Custom field not found');
    return def;
  }

  async update(workspaceId: string, id: string, dto: UpdateCustomFieldDefDto) {
    await this.getOwned(workspaceId, id);
    return this.prisma.customFieldDef.update({
      where: { id },
      data: { ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.options !== undefined && { options: dto.options }),
        ...(dto.required !== undefined && { required: dto.required }),
        ...(dto.position !== undefined && { position: dto.position }) },
    });
  }

  async archive(workspaceId: string, id: string) {
    await this.getOwned(workspaceId, id);
    return this.prisma.customFieldDef.update({ where: { id }, data: { archived: true } });
  }
  async restore(workspaceId: string, id: string) {
    await this.getOwned(workspaceId, id);
    return this.prisma.customFieldDef.update({ where: { id }, data: { archived: false } });
  }

  async reorder(workspaceId: string, ids: string[]) {
    await this.prisma.$transaction(
      ids.map((id, i) => this.prisma.customFieldDef.updateMany({ where: { id, workspaceId }, data: { position: i } })),
    );
    return this.list(workspaceId, true);
  }

  private coerce(def: { key: string; type: string; options: any }, raw: unknown): unknown {
    const bad = (msg: string) => { throw new BadRequestException(`"${def.key}": ${msg}`); };
    switch (def.type) {
      case 'NUMBER': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (raw === '' || raw === null || Number.isNaN(n)) bad('must be a number');
        return n;
      }
      case 'BOOL':
        if (typeof raw === 'boolean') return raw;
        if (raw === 'true' || raw === 'false') return raw === 'true';
        return bad('must be a boolean');
      case 'DATE': case 'DATETIME': {
        const d = new Date(raw as string);
        if (Number.isNaN(d.getTime())) bad('must be a valid date');
        return (d as Date).toISOString();
      }
      case 'SELECT': {
        const opts = (def.options as { value: string }[] | null) ?? [];
        if (!opts.some((o) => o.value === raw)) bad('value not in options');
        return raw;
      }
      case 'MULTISELECT': {
        const opts = (def.options as { value: string }[] | null) ?? [];
        const arr = Array.isArray(raw) ? raw : bad('must be an array');
        for (const v of arr as unknown[]) if (!opts.some((o) => o.value === v)) bad(`value "${v}" not in options`);
        return arr;
      }
      case 'URL': if (!URL_RE.test(String(raw))) bad('must be a URL'); return String(raw);
      case 'EMAIL': if (!EMAIL_RE.test(String(raw))) bad('must be an email'); return String(raw);
      default: return String(raw); // TEXT, TEXTAREA, PHONE
    }
  }

  async validateAndNormalize(
    workspaceId: string, entity: string,
    input: Record<string, unknown> | undefined | null,
    mode: 'create' | 'update',
  ): Promise<Record<string, unknown>> {
    const defs = await this.prisma.customFieldDef.findMany({ where: { workspaceId, entity, archived: false } });
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input ?? {})) {
      const def = byKey.get(k);
      if (!def) continue; // drop unknown
      if (v === null || v === undefined || v === '') continue;
      out[k] = this.coerce(def as any, v);
    }
    if (mode === 'create') {
      for (const d of defs) if (d.required && out[d.key] === undefined)
        throw new BadRequestException(`Custom field "${d.key}" is required`);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run tests** — Run: `npx jest src/modules/marketing/services/custom-fields.service.spec.ts` Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/dto/custom-field.dto.ts backend/src/modules/marketing/services/custom-fields.service.ts backend/src/modules/marketing/services/custom-fields.service.spec.ts
git commit -m "feat(custom-fields): CustomFieldsService def CRUD + validateAndNormalize (tested)"
```

---

## Task 4: Controller + module wiring

**Files:** Create `backend/src/modules/marketing/controllers/marketing-custom-fields.controller.ts`; Modify `backend/src/modules/marketing/marketing.module.ts`

- [ ] **Step 1: Write the controller**

```typescript
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-route.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import type { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { CustomFieldsService } from '../services/custom-fields.service';
import { CreateCustomFieldDefDto, UpdateCustomFieldDefDto, ReorderCustomFieldsDto } from '../dto/custom-field.dto';

@MarketingRoute()
@Controller('marketing/custom-fields')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class MarketingCustomFieldsController {
  constructor(private readonly svc: CustomFieldsService) {}

  @Get()
  list(@Query('includeArchived') inc: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId, inc === 'true');
  }
  @Post() @Audit({ action: 'custom-field.create', resourceType: 'custom-field' })
  create(@Body() dto: CreateCustomFieldDefDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, dto);
  }
  @Post('reorder') @Audit({ action: 'custom-field.reorder', resourceType: 'custom-field' })
  reorder(@Body() dto: ReorderCustomFieldsDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.reorder(u.workspaceId, dto.ids);
  }
  @Patch(':id') @Audit({ action: 'custom-field.update', resourceType: 'custom-field', resourceIdParam: 'id' })
  update(@Param('id') id: string, @Body() dto: UpdateCustomFieldDefDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, dto);
  }
  @Delete(':id') @Audit({ action: 'custom-field.archive', resourceType: 'custom-field', resourceIdParam: 'id' })
  archive(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.archive(u.workspaceId, id);
  }
  @Post(':id/restore') @Audit({ action: 'custom-field.restore', resourceType: 'custom-field', resourceIdParam: 'id' })
  restore(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.restore(u.workspaceId, id);
  }
}
```
NOTE: confirm the real import paths for `MarketingRoute`, `CurrentMarketingUser`, `MarketingUserPayload`, and the guards by reading `marketing-tasks.controller.ts` — copy its imports verbatim.

- [ ] **Step 2: Register in `marketing.module.ts`** — add `CustomFieldsService` to `providers`, `MarketingCustomFieldsController` to `controllers`, and add `CustomFieldsService` to `exports` (the leads service in this same module uses it via DI, so export is not strictly required, but keep it consistent).

- [ ] **Step 3: Build to verify wiring** — Run: `npx jest src/modules/marketing/services/custom-fields.service.spec.ts && npx tsc --noEmit -p backend/tsconfig.json` Expected: PASS + no type errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/marketing/controllers/marketing-custom-fields.controller.ts backend/src/modules/marketing/marketing.module.ts
git commit -m "feat(custom-fields): REST controller + module wiring"
```

---

## Task 5: Lead integration (create/update validate + read; event)

**Files:** Modify `backend/src/modules/marketing/dto/create-lead.dto.ts`, `backend/src/modules/marketing/services/marketing-leads.service.ts`, and existing leads specs.

- [ ] **Step 1: Add `customFields` to `CreateLeadDto`**

```typescript
@IsOptional()
@IsObject()
customFields?: Record<string, unknown>;
```
(`UpdateLeadDto extends PartialType(CreateLeadDto)` inherits it automatically — confirm.)

- [ ] **Step 2: Write the failing leads-integration test** (`marketing-leads.custom-fields.spec.ts`)

```typescript
import { CustomFieldsService } from './custom-fields.service';
import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('MarketingLeadsService — customFields validation on create', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingLeadsService;
  let cf: CustomFieldsService;
  beforeEach(() => {
    prisma = mockPrismaClient();
    cf = { validateAndNormalize: jest.fn().mockResolvedValue({ budget: 1500 }) } as any;
    svc = new MarketingLeadsService(prisma as any, {} as any, { resolve: jest.fn() } as any, {} as any, { append: jest.fn() } as any, cf);
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.lead.create.mockResolvedValue({ id: 'lead-1', customFields: { budget: 1500 } } as any);
  });

  it('runs customFields through validateAndNormalize and persists the normalized map', async () => {
    await svc.create('ws-1', { businessName: 'X', contactPerson: 'Y', businessType: 'CAFE', source: 'WEBSITE', customFields: { budget: '1500' } } as any, 'u1', 'OWNER');
    expect(cf.validateAndNormalize).toHaveBeenCalledWith('ws-1', 'LEAD', { budget: '1500' }, 'create');
    expect(prisma.lead.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customFields: { budget: 1500 } }) }));
  });
});
```

- [ ] **Step 3: Run to verify it fails** — Run: `npx jest src/modules/marketing/services/marketing-leads.custom-fields.spec.ts` Expected: FAIL (constructor arity / missing logic).

- [ ] **Step 4: Wire `CustomFieldsService` into `MarketingLeadsService`**
  - Add constructor param `private customFields: CustomFieldsService` (last position).
  - In `create()`, before `prisma.lead.create`, compute `const customFields = await this.customFields.validateAndNormalize(workspaceId, 'LEAD', dto.customFields, 'create');` and remove `customFields` from the `...dto` spread, adding `customFields` explicitly to `data`.
  - In `update()`, if `dto.customFields !== undefined`: load existing lead's `customFields`, compute `validated = validateAndNormalize(..., 'update')`, set `data.customFields = { ...existing, ...validated }`, and `outbox.append({ type: 'marketing.lead.customField.changed.v1', idempotencyKey: \`lead-cf:${id}:${Date.now()}\`, payload: { leadId: id, keys: Object.keys(validated) } })` (best-effort; not in a tx unless update already runs in one — match existing update()).

- [ ] **Step 5: Fix existing leads-spec constructors** — grep for `new MarketingLeadsService(` across specs; each call must add a trailing arg. Use a no-op stub: `{ validateAndNormalize: jest.fn().mockResolvedValue({}) } as any`.

Run: `grep -rn "new MarketingLeadsService(" backend/src` to find all call sites.

- [ ] **Step 6: Run the full leads + custom-fields test set** — Run: `npx jest src/modules/marketing/services/marketing-leads --maxWorkers=2 && npx jest src/modules/marketing/services/custom-fields.service.spec.ts` Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/marketing/dto/create-lead.dto.ts backend/src/modules/marketing/services/marketing-leads.service.ts backend/src/modules/marketing/services/marketing-leads.custom-fields.spec.ts
git commit -m "feat(custom-fields): validate+persist Lead.customFields on create/update; change event"
```

---

## Task 6: E2E + full regression

**Files:** Create `backend/test/e2e/custom-fields.e2e-spec.ts` (mirror an existing e2e — read `backend/test/e2e/audit.e2e-spec.ts` for the bootstrap + auth helper pattern).

- [ ] **Step 1: Write the e2e** — authenticate as a workspace owner, `POST /marketing/custom-fields` (NUMBER + required SELECT), `GET` returns them ordered, create a lead with valid `customFields`, assert echoed back; create a lead with an out-of-options SELECT → 400.

- [ ] **Step 2: Run the new e2e** — Run: `npm run test:e2e -- custom-fields` Expected: PASS.

- [ ] **Step 3: Full regression** — Run: `npm test` then `npm run test:e2e` Expected: existing 85 unit + 13 e2e still green, plus the new specs.

- [ ] **Step 4: Commit**

```bash
git add backend/test/e2e/custom-fields.e2e-spec.ts
git commit -m "test(custom-fields): e2e CRUD + lead value validation; full regression green"
```

---

## Self-review notes (done)
- **Spec coverage:** A1 schema, def CRUD, `validateAndNormalize`, lead create/update integration, read echo, change event, archive/hard-delete (hard-delete deferred to A-cleanup; archive covered), reorder, e2e + regression — all have tasks. (Hard-delete `DELETE /:id/hard` from the spec is intentionally deferred — archive satisfies the v1 need; tracked for a follow-up.)
- **Type consistency:** `validateAndNormalize(workspaceId, entity, input, mode)` signature identical across Tasks 3 & 5; `CustomFieldType` enum single source.
- **Placeholders:** none — all steps carry real code or exact commands.
- **Frontend** (Custom Fields settings page) ships in a follow-up task within this PR after backend is green; it is additive and does not block the API.
