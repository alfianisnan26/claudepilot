import type { ReporterAgentGrant, ReporterAgentGroup } from '@portal/contracts';

/*
 * WebMCP auto-approve in the panel (PILOT-1128): which grant answers an ask, what the indicator and the Settings list say. The server is
 * the authority (it checks every auto-approved call against the token, the person, the bucket, the origin and the caps); this only decides
 * whether to show the Allow sheet.
 */

export const GROUP_LABEL: Record<ReporterAgentGroup, string> = { file: 'file reports', attach: 'attach screenshots', comment: 'comment' };

/** What the person answered in the Allow sheet. */
export type AskAnswer = 'deny' | 'once' | 'session' | 'always';

const live = (g: ReporterAgentGrant, now: number) => Date.parse(g.expiresAt) > now;

/** The grants still in time, in the order the server gave them. */
export const liveGrants = (grants: readonly ReporterAgentGrant[], now = Date.now()) => grants.filter((g) => live(g, now));

/** The grant that auto-approves a group now, or null (then the sheet asks). */
export function grantFor(grants: readonly ReporterAgentGrant[], group: ReporterAgentGroup, now = Date.now()): ReporterAgentGrant | null {
  return grants.find((g) => g.group === group && live(g, now)) ?? null;
}

/** The indicator's words while any auto-approve is on ("Agent auto-approve on: file reports, comment"), else null. */
export function indicatorText(grants: readonly ReporterAgentGrant[], now = Date.now()): string | null {
  const groups = [...new Set(liveGrants(grants, now).map((g) => g.group))];
  return groups.length ? `Agent auto-approve on: ${groups.map((g) => GROUP_LABEL[g]).join(', ')}` : null;
}

const two = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "until 21:30" today, else "until 3 Dec" (local time). */
export function untilText(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? `until ${two(d.getHours())}:${two(d.getMinutes())}` : `until ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** One grant in Settings: "file reports · this session · until 21:30". */
export const grantLine = (g: ReporterAgentGrant, now = Date.now()) =>
  `${GROUP_LABEL[g.group]} · ${g.scope === 'session' ? 'this session' : 'this site'} · ${untilText(g.expiresAt, now)}`;
