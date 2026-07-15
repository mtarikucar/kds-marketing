import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CustomFieldsService } from './custom-fields.service';
import { TagsService } from './tags.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService,
  ClaimedJob,
} from '../scheduling/scheduled-job-runner.service';
import { normalizeEmail, normalizePhone, localMsisdnVariants } from '../utils/lead-normalize';
import { parseCsv } from '../utils/csv-parse';
import { LeadSource, LeadPriority, BUSINESS_TYPE_PATTERN } from '../dto/create-lead.dto';

const MAX_ROWS = 50_000;
const BATCH = 200;
const ERROR_SAMPLE_CAP = 50;

// `source` and `priority` are FIXED enums (@IsEnum) and `businessType` is an
// UPPER_SNAKE taxonomy key (@Matches) on the create/update Lead DTOs. A CSV can
// carry any free text in those columns; writing it verbatim used to mint leads
// that later FAIL to save from the UI (the Update DTO's @IsEnum/@Matches rejects
// the stored value → un-editable lead) and never match a source/priority/type
// filter. Coerce imported values to the same domain the API enforces, so an
// imported lead is a first-class, editable, filterable lead.
const LEAD_SOURCE_VALUES = new Set<string>(Object.values(LeadSource));
const LEAD_PRIORITY_VALUES = new Set<string>(Object.values(LeadPriority));

/** Fold a free-text businessType into the UPPER_SNAKE taxonomy key the DTO
 *  requires (e.g. "Cafe Restaurant" → "CAFE_RESTAURANT"); falls back to OTHER
 *  when nothing valid survives. */
function coerceBusinessType(v: string): string {
  const key = v
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return BUSINESS_TYPE_PATTERN.test(key) ? key : 'OTHER';
}

/** Native Lead columns an import may map a CSV column onto. */
const NATIVE_FIELDS = [
  'businessName',
  'contactPerson',
  'phone',
  'whatsapp',
  'email',
  'address',
  'city',
  'region',
  'businessType',
  'currentSystem',
  'source',
  'notes',
  'priority',
] as const;

/** Header synonyms → native field, for the suggested mapping. */
const SYNONYMS: Record<string, string> = {
  business: 'businessName',
  'business name': 'businessName',
  company: 'businessName',
  'company name': 'businessName',
  name: 'businessName',
  contact: 'contactPerson',
  'contact person': 'contactPerson',
  'contact name': 'contactPerson',
  person: 'contactPerson',
  phone: 'phone',
  tel: 'phone',
  telephone: 'phone',
  mobile: 'phone',
  whatsapp: 'whatsapp',
  wa: 'whatsapp',
  email: 'email',
  'e-mail': 'email',
  mail: 'email',
  address: 'address',
  city: 'city',
  town: 'city',
  region: 'region',
  state: 'region',
  province: 'region',
  type: 'businessType',
  'business type': 'businessType',
  category: 'businessType',
  source: 'source',
  notes: 'notes',
  note: 'notes',
  description: 'notes',
  priority: 'priority',
  tags: 'tags',
  tag: 'tags',
  labels: 'tags',
};

@Injectable()
export class ImportService implements OnModuleInit {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private prisma: PrismaService,
    private customFields: CustomFieldsService,
    private tags: TagsService,
    private scheduledJob: ScheduledJobService,
    private runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(
      'import.batch',
      (job: ClaimedJob) => this.processBatch(job.payload.jobId, job.payload.offset ?? 0),
      // The batch job exhausted its retries (e.g. a DB blip mid-import):
      // without this the ImportJob stayed RUNNING forever and the wizard
      // polled "Import running…" indefinitely. Flip it terminal with a
      // visible reason; rows already imported stay imported.
      async (job: ClaimedJob, error: string) => {
        const jobId = job.payload?.jobId as string | undefined;
        if (!jobId) return;
        const imp = await this.prisma.importJob.findUnique({
          where: { id: jobId },
          select: { status: true, errors: true },
        });
        if (!imp || imp.status !== 'RUNNING') return;
        const prevErrors = (imp.errors as { row: number; message: string }[] | null) ?? [];
        await this.prisma.importJob.update({
          where: { id: jobId },
          data: {
            status: 'FAILED',
            errors: [
              ...prevErrors,
              { row: -1, message: `import aborted — batch job exhausted retries: ${error}` },
            ] as Prisma.InputJsonValue,
          },
        });
      },
    );
  }

  suggestMapping(headers: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of headers) {
      const key = h.trim().toLowerCase();
      if (SYNONYMS[key]) out[h] = SYNONYMS[key];
      else if ((NATIVE_FIELDS as readonly string[]).includes(key)) out[h] = key;
      else out[h] = '__skip';
    }
    return out;
  }

  async upload(
    workspaceId: string,
    filename: string,
    content: string,
    createdById?: string,
  ) {
    const { headers, rows } = parseCsv(content);
    if (headers.length === 0) {
      throw new BadRequestException('CSV has no header row');
    }
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(`CSV exceeds ${MAX_ROWS} rows`);
    }
    const job = await this.prisma.importJob.create({
      data: {
        workspaceId,
        filename,
        status: 'MAPPING',
        total: rows.length,
        createdById: createdById ?? null,
      },
      select: { id: true },
    });
    if (rows.length) {
      await this.prisma.importJobRow.createMany({
        data: rows.map((raw, i) => ({
          importJobId: job.id,
          rowIndex: i,
          raw: raw as Prisma.InputJsonValue,
        })),
      });
    }
    return {
      jobId: job.id,
      headers,
      suggestedMapping: this.suggestMapping(headers),
      total: rows.length,
    };
  }

  private async getOwned(workspaceId: string, jobId: string) {
    const job = await this.prisma.importJob.findFirst({
      where: { id: jobId, workspaceId },
    });
    if (!job) throw new NotFoundException('Import job not found');
    return job;
  }

  getStatus(workspaceId: string, jobId: string) {
    return this.getOwned(workspaceId, jobId);
  }

  list(workspaceId: string) {
    return this.prisma.importJob.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async commit(
    workspaceId: string,
    jobId: string,
    mapping: Record<string, string>,
    dedupePolicy: 'SKIP' | 'UPDATE' | 'CREATE',
  ) {
    const job = await this.getOwned(workspaceId, jobId);
    if (job.status !== 'MAPPING') {
      throw new BadRequestException(`Import job is ${job.status}, cannot commit`);
    }
    await this.prisma.importJob.update({
      where: { id: jobId },
      data: { mapping: mapping as Prisma.InputJsonValue, dedupePolicy, status: 'RUNNING' },
    });
    await this.scheduledJob.schedule({
      workspaceId,
      kind: 'import.batch',
      runAt: new Date(),
      payload: { jobId, offset: 0 },
      dedupKey: `import:${jobId}`,
    });
    return { jobId, status: 'RUNNING' };
  }

  private buildLeadData(mapping: Record<string, string>, raw: Record<string, string>) {
    const native: Record<string, string> = {};
    const cf: Record<string, unknown> = {};
    const tags: string[] = [];
    for (const [header, field] of Object.entries(mapping)) {
      if (!field || field === '__skip') continue;
      const val = (raw[header] ?? '').trim();
      if (val === '') continue;
      if (field === 'tags') {
        for (const t of val.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) tags.push(t);
      } else if (field.startsWith('cf:')) {
        cf[field.slice(3)] = val;
      } else if ((NATIVE_FIELDS as readonly string[]).includes(field)) {
        native[field] = val;
      }
    }
    // Coerce the validated-domain fields to what the Lead API enforces, so an
    // imported lead validates on later edit and matches source/type/priority
    // filters (a raw CSV value would otherwise mint an un-editable lead).
    if (native.source !== undefined) {
      const s = native.source.trim().toUpperCase();
      native.source = LEAD_SOURCE_VALUES.has(s) ? s : 'OTHER';
    }
    if (native.priority !== undefined) {
      const p = native.priority.trim().toUpperCase();
      native.priority = LEAD_PRIORITY_VALUES.has(p) ? p : 'MEDIUM';
    }
    if (native.businessType !== undefined) {
      native.businessType = coerceBusinessType(native.businessType);
    }
    return { native, cf, tags };
  }

  private findExisting(
    workspaceId: string,
    emailNormalized: string | null,
    phoneNormalized: string | null,
  ) {
    const or: Prisma.LeadWhereInput[] = [];
    if (emailNormalized) or.push({ emailNormalized });
    // Match a phone across ALL its stored spellings (bare / 0- / 90- / +90 / 00-),
    // exactly like İYS/telephony/voice/IVR resolution does — an exact-match on one
    // spelling silently misses (and thus DUPLICATES) a lead the same real number
    // was first stored under via a different ingest path.
    if (phoneNormalized) or.push({ phoneNormalized: { in: localMsisdnVariants(phoneNormalized) } });
    if (!or.length) return Promise.resolve(null);
    return this.prisma.lead.findFirst({
      // Skip tombstoned (merged) AND soft-deleted (bulk-deleted) leads: an
      // import row must not match — and thus update or be skipped against — a
      // hidden lead. A deleted contact in the CSV becomes a fresh visible lead.
      where: { workspaceId, mergedIntoId: null, deletedAt: null, OR: or },
      // emailNormalized + phoneNormalized are REQUIRED by the single-key-match
      // preservation in processBatch: it compares them to decide whether a row
      // matched on one identifier may overwrite the other. Omitting them here
      // makes both read `undefined` at runtime, collapsing the keep-flags to
      // false and silently clobbering the conflicting identifier.
      select: {
        id: true,
        customFields: true,
        status: true,
        convertedTenantId: true,
        emailNormalized: true,
        phoneNormalized: true,
      },
    });
  }

  async processBatch(jobId: string, offset: number): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'RUNNING') return;
    const rows = await this.prisma.importJobRow.findMany({
      where: { importJobId: jobId, status: 'PENDING' },
      orderBy: { rowIndex: 'asc' },
      take: BATCH,
    });
    if (rows.length === 0) {
      await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'DONE' } });
      return;
    }

    const mapping = (job.mapping as Record<string, string>) ?? {};
    const policy = job.dedupePolicy;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const errors: { row: number; message: string }[] = [];

    for (const row of rows) {
      try {
        const { native, cf, tags } = this.buildLeadData(mapping, row.raw as Record<string, string>);
        if (!native.businessName) throw new Error('missing businessName');
        const emailNormalized = normalizeEmail(native.email);
        const phoneNormalized = normalizePhone(native.phone);
        const existing = await this.findExisting(job.workspaceId, emailNormalized, phoneNormalized);

        let leadId: string | null = null;
        let rowStatus = 'DONE';
        // Decide the action up-front (no writes yet). A converted/WON customer
        // is never OVERWRITTEN from a CSV row — but that guard only applies to
        // the UPDATE write. Under the CREATE policy ("Always create") the user
        // explicitly asked for a new lead, so a match against a customer must
        // not silently skip the row (it contradicted the option's promise).
        const action: 'created' | 'updated' | 'skipped' =
          existing && policy === 'SKIP'
            ? 'skipped'
            : existing && policy === 'UPDATE'
              ? existing.convertedTenantId || existing.status === 'WON'
                ? 'skipped'
                : 'updated'
              : 'created';
        if (action === 'skipped') rowStatus = 'SKIPPED';

        // Validate custom fields in the action-appropriate mode: a CREATED lead
        // must satisfy `required` custom fields exactly like a POST /leads create
        // (the old code always used 'update', silently bypassing required on
        // imported leads); an UPDATE keeps the lenient partial mode.
        const customFields = await this.customFields.validateAndNormalize(
          job.workspaceId,
          'LEAD',
          cf,
          action === 'created' ? 'create' : 'update',
        );

        // The lead write AND the row outcome commit together, so a crash can
        // never leave an imported lead with a PENDING/FAILED row (or vice-versa).
        await this.prisma.$transaction(async (tx) => {
          if (action === 'updated' && existing) {
            // findExisting matches on email OR phone. A SINGLE-key match (phone
            // only / email only) must NOT silently overwrite the OTHER, conflicting
            // identifier — two different people can share a phone (or email), and
            // clobbering it corrupts contact identity. Preserve the existing key in
            // that case (fills-blanks + both-match updates still apply normally).
            const matchedEmail = !!emailNormalized && existing.emailNormalized === emailNormalized;
            // Variant-aware to stay consistent with findExisting's variant lookup:
            // a row that matched via a DIFFERENT spelling of the same number is a
            // phone match, so the preservation flags below must recognise it (else
            // a variant match would look like "no phone match" and clobber the
            // existing, differing email).
            const matchedPhone =
              !!phoneNormalized &&
              !!existing.phoneNormalized &&
              localMsisdnVariants(phoneNormalized).includes(existing.phoneNormalized);
            const keepEmail = matchedPhone && !matchedEmail && !!existing.emailNormalized && existing.emailNormalized !== emailNormalized;
            const keepPhone = matchedEmail && !matchedPhone && !!existing.phoneNormalized && existing.phoneNormalized !== phoneNormalized;
            const scalars = this.nativeScalars(native);
            if (keepEmail) delete scalars.email;
            if (keepPhone) delete scalars.phone;
            await tx.lead.update({
              where: { id: existing.id },
              data: {
                ...scalars,
                customFields: {
                  ...((existing.customFields as Record<string, unknown>) ?? {}),
                  ...customFields,
                } as Prisma.InputJsonValue,
                ...(keepPhone ? {} : { phoneNormalized }),
                ...(keepEmail ? {} : { emailNormalized }),
              },
            });
            leadId = existing.id;
          } else if (action === 'created') {
            const lead = await tx.lead.create({
              data: {
                workspaceId: job.workspaceId,
                businessName: native.businessName,
                contactPerson: native.contactPerson ?? '',
                businessType: native.businessType ?? 'OTHER',
                source: native.source ?? 'IMPORT',
                ...this.nativeScalars(native),
                customFields: customFields as Prisma.InputJsonValue,
                phoneNormalized,
                emailNormalized,
              },
            });
            leadId = lead.id;
          }
          await tx.importJobRow.update({
            where: { id: row.id },
            data: { status: rowStatus, leadId },
          });
        });

        // Only count AFTER the tx commits, so a rolled-back row isn't counted.
        if (action === 'created') created++;
        else if (action === 'updated') updated++;
        else skipped++;

        // Tags are best-effort AFTER the row committed — a tag failure must not
        // un-import the lead or flip the row to FAILED (the lead is in).
        if (tags.length && leadId) {
          await this.tags
            .assignToLead(job.workspaceId, leadId, tags)
            .catch((e) =>
              this.logger.warn(`import: tag assign failed for lead ${leadId}: ${(e as Error).message}`),
            );
        }
      } catch (e) {
        failed++;
        const message = (e as Error).message;
        if (errors.length < ERROR_SAMPLE_CAP) errors.push({ row: row.rowIndex, message });
        await this.prisma.importJobRow.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: message },
        });
      }
    }

    const prevErrors = (job.errors as { row: number; message: string }[] | null) ?? [];
    await this.prisma.importJob.update({
      where: { id: jobId },
      data: {
        processed: { increment: rows.length },
        created: { increment: created },
        updated: { increment: updated },
        skipped: { increment: skipped },
        failed: { increment: failed },
        ...(errors.length
          ? { errors: [...prevErrors, ...errors].slice(0, ERROR_SAMPLE_CAP) as Prisma.InputJsonValue }
          : {}),
      },
    });

    const remaining = await this.prisma.importJobRow.count({
      where: { importJobId: jobId, status: 'PENDING' },
    });
    if (remaining > 0) {
      await this.scheduledJob.schedule({
        workspaceId: job.workspaceId,
        kind: 'import.batch',
        runAt: new Date(),
        payload: { jobId, offset: offset + rows.length },
        dedupKey: `import:${jobId}`,
      });
    } else {
      await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'DONE' } });
    }
  }

  /** Only the writable native scalar fields present in the parsed row. */
  private nativeScalars(native: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of NATIVE_FIELDS) {
      if (native[f] !== undefined) out[f] = native[f];
    }
    return out;
  }
}
