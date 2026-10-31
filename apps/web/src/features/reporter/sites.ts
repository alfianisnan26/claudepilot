import { REPORTER_LIMITS, REPORTER_ROUTES, type ReporterSessionTarget, type ReporterSite } from '@portal/contracts';

/*
 * The bucket's reporter sites as the owner edits them (rows of origin, environment, repo, branch, label), checked before saving. The
 * server checks again, including the one rule only it can see: an origin used by another bucket (409).
 */

export interface SiteRow {
  origin: string;
  environment: string;
  repo: string;
  branch: string;
  label: string;
}

export const emptyRow = (): SiteRow => ({ origin: '', environment: '', repo: '', branch: '', label: '' });

export const rowOf = (s: ReporterSite): SiteRow => ({ origin: s.origin, environment: s.environment, repo: s.repo, branch: s.branch ?? '', label: s.label ?? '' });

export const siteOf = (r: SiteRow): ReporterSite => ({
  origin: r.origin.trim(),
  environment: r.environment.trim().toLowerCase(),
  repo: r.repo.trim(),
  branch: r.branch.trim() || null,
  label: r.label.trim() || null,
});

const ENV = /^[a-z0-9][a-z0-9-]{0,19}$/;
const REPO = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/** "https://stg.konfersi.com/" is fixed to its origin; anything that is not an http(s) origin is refused. */
export function originError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Required.';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'A full origin, like https://stg.konfersi.com.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'http or https only.';
  if (v.includes('*')) return 'No wildcards.';
  if (u.origin !== v) return `Only the origin: ${u.origin}`;
  if (u.protocol === 'http:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return 'https, except for localhost.';
  return null;
}

export type RowErrors = Partial<Record<keyof SiteRow, string>>;

/** Errors per row (index -> field -> message); empty when every row is fine. */
export function siteErrors(rows: SiteRow[]): Record<number, RowErrors> {
  const out: Record<number, RowErrors> = {};
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const e: RowErrors = {};
    const o = originError(r.origin);
    if (o) e.origin = o;
    else {
      const prev = seen.get(r.origin.trim());
      if (prev !== undefined) e.origin = `Same origin as row ${prev + 1}.`;
      else seen.set(r.origin.trim(), i);
    }
    if (!ENV.test(r.environment.trim().toLowerCase())) e.environment = 'Lowercase, 1 to 20 (stg, uat, prod).';
    if (!REPO.test(r.repo.trim())) e.repo = 'owner/repo';
    if (r.branch.trim() && !BRANCH.test(r.branch.trim())) e.branch = 'Not a branch name.';
    if (r.label.length > 60) e.label = 'At most 60.';
    if (Object.keys(e).length) out[i] = e;
  });
  return out;
}

export const sitesValid = (rows: SiteRow[]) => rows.length <= REPORTER_LIMITS.sites && Object.keys(siteErrors(rows)).length === 0;

export function targetsValid(targets: ReporterSessionTarget[]): boolean {
  return targets.length <= REPORTER_LIMITS.sessionTargets && targets.every((t) => t.sessionId && t.label.trim()) && new Set(targets.map((t) => t.sessionId)).size === targets.length;
}

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The script tag for one site (the commit and branch come from the site's build; shown as placeholders to fill). */
export function snippet(portal: string, bucket: string, site: ReporterSite): string {
  return [
    `<script src="${attr(portal)}${REPORTER_ROUTES.script}" async`,
    `  data-portal="${attr(portal)}"`,
    `  data-bucket="${attr(bucket)}"`,
    `  data-repo="${attr(site.repo)}"`,
    `  data-env="${attr(site.environment)}"`,
    ...(site.branch ? [`  data-branch="${attr(site.branch)}"`] : []),
    `  data-commit="<build commit>"></script>`,
  ].join('\n');
}

/** The one-line deploy hook a pipeline runs after deploying (a portal token with operate on the bucket in PILOT_TOKEN). */
export function deployCurl(portal: string, site: ReporterSite): string {
  const body = JSON.stringify({ repo: site.repo, environment: site.environment, commit: '$COMMIT', ...(site.branch ? { branch: site.branch } : {}) }).replace('"$COMMIT"', '"\'"$COMMIT"\'"');
  return `curl -fsS -X POST ${portal}${REPORTER_ROUTES.deploymentsOwner} -H "Authorization: Bearer $PILOT_TOKEN" -H 'Content-Type: application/json' -d '${body}'`;
}
