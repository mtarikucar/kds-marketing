import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { plainToInstance } from 'class-transformer';
import { CreateWorkflowDto, UpdateWorkflowDto } from './workflow.dto';
import { CreateCampaignDto, UpdateCampaignDto } from './campaign.dto';

/**
 * Free-shape-array tripwire.
 *
 * The global pipe runs with `enableImplicitConversion: true` (app.config.ts).
 * For an array property whose ELEMENT type reflects as `Object` — which is what
 * `unknown[]`, `any[]` and `Record<string, unknown>[]` all produce — class
 * transformer "converts" each element into an EMPTY ARRAY. The declared type is
 * still `Array`, `@IsArray()` still passes, and the request sails through to the
 * service with its contents destroyed.
 *
 * This shipped in two places and neither had a failing test:
 *   - CreateWorkflowDto.steps  → every step became `[]`, the Zod DSL rejected it
 *     with "steps.0 — expected object, received array", and creating an
 *     automation through the API could not succeed at all.
 *   - CreateCampaignDto.audienceFilter → every filter became `[]`. Worse than an
 *     error: an empty audience filter means EVERYONE, so a campaign aimed at one
 *     segment would go to the whole lead list, silently.
 *
 * Unit tests could not see either one: they call the services directly and skip
 * the DTO layer. Only a request through the pipe reproduces it — which is why
 * this file transforms the DTOs the way the pipe does, rather than trusting a
 * decorator to be present.
 */

const IMPLICIT = { enableImplicitConversion: true } as const;

describe('DTO free-shape arrays survive the global pipe', () => {
  it('CreateWorkflowDto keeps step objects intact', () => {
    const steps = [
      { type: 'create_task', title: 'Follow up', dueInHours: 24 },
      { type: 'wait', mode: 'duration', seconds: 60 },
    ];
    const dto = plainToInstance(
      CreateWorkflowDto,
      { name: 'n', trigger: { type: 'lead.created', filters: [] }, steps },
      IMPLICIT,
    );
    expect(dto.steps).toEqual(steps);
  });

  it('UpdateWorkflowDto keeps step objects intact', () => {
    const steps = [{ type: 'add_tag', tag: 'vip' }];
    const dto = plainToInstance(UpdateWorkflowDto, { steps }, IMPLICIT);
    expect(dto.steps).toEqual(steps);
  });

  it('CreateCampaignDto keeps the audience filter intact', () => {
    const audienceFilter = [{ field: 'lead.status', op: 'eq', value: 'WON' }];
    const dto = plainToInstance(
      CreateCampaignDto,
      { name: 'n', channel: 'EMAIL', body: 'hi', audienceFilter },
      IMPLICIT,
    );
    // An emptied filter targets EVERYONE — the failure mode that must never
    // return, because nothing downstream errors on it.
    expect(dto.audienceFilter).toEqual(audienceFilter);
  });

  it('UpdateCampaignDto keeps the audience filter intact', () => {
    const audienceFilter = [{ field: 'lead.city', op: 'eq', value: 'İzmir' }];
    const dto = plainToInstance(UpdateCampaignDto, { audienceFilter }, IMPLICIT);
    expect(dto.audienceFilter).toEqual(audienceFilter);
  });

  /**
   * The class-wide guard. A NEW free-shape array on any DTO must pin its
   * element type, or it ships broken in exactly the same way — and, as both
   * cases above show, without a failing unit test to warn anyone.
   */
  it('every free-shape array on a DTO pins its element type with @Type', () => {
    const dtoDir = __dirname;
    const offenders: string[] = [];

    for (const file of fs.readdirSync(dtoDir)) {
      if (!file.endsWith('.dto.ts')) continue;
      const lines = fs.readFileSync(path.join(dtoDir, file), 'utf8').split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const decl = lines[i].match(
          /^\s*(\w+)\??:\s*(unknown\[\]|any\[\]|object\[\]|Record<string,\s*(unknown|any)>\[\])/,
        );
        if (!decl) continue;

        // Decorators sit directly above the property.
        const decorators = lines.slice(Math.max(0, i - 8), i).join('\n');
        if (!/@IsArray|@IsOptional/.test(decorators)) continue; // not a validated field
        if (/@Type\(/.test(decorators)) continue; // pinned — fine

        offenders.push(`${file}:${i + 1} — ${decl[1]} needs @Type(() => Object)`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
