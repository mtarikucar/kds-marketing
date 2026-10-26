import { request } from './client';
import type { OpsHealthOut } from './types';
/** Sanitized operator projection; never request tenant bodies or connector credentials. */
export function getHealth(): Promise<OpsHealthOut> { return request('GET', '/api/platform/health'); }
