import type { Lead } from '../../../features/marketing/types';

/**
 * Who the person surface has open.
 *
 * An id and AS MUCH of the person as whoever handed them over happened to know.
 * That used to be `Lead` outright, because the only thing that could hand one
 * over was `PeopleList`, which had just rendered the whole row from
 * `GET /leads`. Since the left column switches views (2026-09-01, stage 2) the
 * other three hand over what their own payloads carry: a board card has a name
 * and a phone, a task row has a business name and nothing else.
 *
 * The type is deliberately PARTIAL rather than the narrow intersection of the
 * four payloads. The surface resolves the rest against `['marketing','lead',id]`
 * — the same key the record card is already reading for its Görevler and
 * Teklifler sections, so it costs no request — and a partial that fills in is
 * exactly what that produces.
 *
 * The consequence a reader must hold on to: **absent is not empty here.** A
 * missing `assignedTo` means "nobody has said", not "nobody owns them"; the
 * record card is held to that distinction by a test, because "Atanmamış" is an
 * ANSWER on this surface — it is what the Atanmamış queue one column over is
 * about — and not a blank.
 */
export type SurfacePerson = Pick<Lead, 'id'> & Partial<Lead>;
