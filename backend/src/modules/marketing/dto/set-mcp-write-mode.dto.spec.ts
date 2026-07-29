import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetMcpWriteModeDto } from './set-mcp-write-mode.dto';

/**
 * MCP write-surface activation — the DTO gate in front of the OWNER-only
 * mcp-write-mode endpoint. `McpInvokerService.writeModeFor()` already fails
 * safe on any stored value that isn't exactly 'AUTONOMOUS', but this DTO is
 * what stops a bad value from ever being written in the first place.
 */
describe('SetMcpWriteModeDto', () => {
  it('accepts APPROVAL', async () => {
    const dto = plainToInstance(SetMcpWriteModeDto, { mode: 'APPROVAL' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts AUTONOMOUS', async () => {
    const dto = plainToInstance(SetMcpWriteModeDto, { mode: 'AUTONOMOUS' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an unrecognised value', async () => {
    const dto = plainToInstance(SetMcpWriteModeDto, { mode: 'YOLO' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'mode')).toBe(true);
  });

  it('rejects a missing value', async () => {
    const dto = plainToInstance(SetMcpWriteModeDto, {});
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'mode')).toBe(true);
  });

  it('rejects lowercase (case-sensitive)', async () => {
    const dto = plainToInstance(SetMcpWriteModeDto, { mode: 'autonomous' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'mode')).toBe(true);
  });
});
