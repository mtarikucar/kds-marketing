import type { TFunction } from 'i18next';
import type { Permission } from '@/api/types';
import { formatRelative } from '@/lib/format';
import { capitalise, everyPhrase, wakeTime, wakeTimeIn } from '@/lib/wake';
import type { AgentCopy } from './copy';
import { DOES, DOES_SHOWN, MANAGES, type Agent } from './model';

/** `parts` read as one list: "a, b ve c". */
function list(copy: AgentCopy, parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} ${copy('and')} ${parts.at(-1)}`;
}

/**
 * What an agent with `scopes` does, in a sentence: the kinds of work it may take (three, then
 * "N more"), and whether it may also change settings; a setup key (most work and settings) and a
 * key that may only read say so.
 */
export function doesText(copy: AgentCopy, scopes: readonly Permission[]): string {
  const work = DOES.filter(([perms]) => perms.some((p) => scopes.includes(p))).map(([, key]) => copy(key));
  const manages = MANAGES.some((p) => scopes.includes(p));
  if (!work.length) {
    if (manages) return copy('doesManage');
    return scopes.length ? copy('doesReadOnly') : copy('doesNothing');
  }
  // A key that may do most kinds of work and change settings is a setup key: say that, not a list.
  if (manages && work.length > DOES_SHOWN + 1) return copy('doesAll');
  const shown = work.length > DOES_SHOWN + 1 ? [...work.slice(0, DOES_SHOWN), copy('doesMore', { n: work.length - DOES_SHOWN })] : work;
  const sentence = `${capitalise(list(copy, shown), copy.language)}.`;
  return manages ? `${sentence} ${copy('doesManage')}` : sentence;
}

/** The agent's state as one calm sentence, then how much work waits for it. */
export function stateText(copy: AgentCopy, t: TFunction, agent: Agent, now: number): string {
  const lang = copy.language;
  const rel = (iso: string) => formatRelative(iso, lang, new Date(now));
  const at = (iso: string) => wakeTimeIn(iso, lang, 'loc');
  const p = agent.presence;
  let text: string;
  switch (p.kind) {
    case 'working': text = copy('working'); break;
    case 'calling':
      text = p.waitingFor === 'settle' ? copy('settle') : copy(p.waitingFor === 'rate' ? 'rate' : 'retry', { at: at(p.dueAt) });
      break;
    case 'called': text = copy('called', { time: at(p.at) }); break;
    case 'never': text = p.old && p.issuedAt ? copy('neverOld', { when: rel(p.issuedAt) }) : copy('never'); break;
    case 'onSchedule':
      text = p.next && p.interval > 0
        ? copy('onSchedule', { when: rel(p.last), phrase: everyPhrase(t, p.interval), time: wakeTime(p.next, lang) })
        : copy('came', { when: rel(p.last) });
      break;
    case 'late': text = p.expected ? copy('late', { when: rel(p.last), at: at(p.expected) }) : copy('came', { when: rel(p.last) }); break;
    case 'away': text = copy('away', { n: p.days }); break;
    case 'revoked': text = p.at ? copy('revokedState', { when: rel(p.at) }) : ''; break;
  }
  text = capitalise(text, lang);
  if (agent.waitingTotal > 0 && p.kind !== 'working' && p.kind !== 'revoked') text = `${text} ${copy('waitingWork', { n: agent.waitingTotal })}`;
  return text;
}
