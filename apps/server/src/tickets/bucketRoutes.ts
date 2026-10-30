// T-2881: the bucket a ticket filed without one goes to, by its tags (`tickets.bucketRoutes`). Agents filed Konfersi tickets through the
// portal MCP without a bucket and they landed in PILOT (214 moved by hand on 2026-10-28). This is the first, strongest guess of the order in
// service.ts `#bucketFor`; it decides nothing when two buckets tie.

import { TICKET_BUCKET_KEY, TICKET_LIMITS, TICKET_TAG } from '@portal/contracts';

/** One rule: a bucket and the tags that send a ticket there; `prefixes` are the `prefix-*` patterns without their `*`. */
export interface BucketRoute {
  bucket: string;
  tags: string[];
  prefixes: string[];
}

const isTag = (w: string) => w.length <= TICKET_LIMITS.tag && TICKET_TAG.test(w);

/**
 * `KEY: tag, tag, prefix-*; KEY2: tag`. A rule without a valid key, or a word that is neither a tag nor `prefix*`, is dropped (an
 * unreadable rule routes nothing; it never blocks a create). Not a string: no rules.
 */
export function parseBucketRoutes(raw: unknown): BucketRoute[] {
  if (typeof raw !== 'string') return [];
  const out: BucketRoute[] = [];
  for (const rule of raw.split(';')) {
    const i = rule.indexOf(':');
    if (i < 0) continue;
    const bucket = rule.slice(0, i).trim().toUpperCase();
    if (!TICKET_BUCKET_KEY.test(bucket)) continue;
    const r: BucketRoute = out.find((x) => x.bucket === bucket) ?? { bucket, tags: [], prefixes: [] };
    for (const w of rule.slice(i + 1).split(/[,\s]+/)) {
      const word = w.trim().toLowerCase();
      if (!word) continue;
      if (word.endsWith('*')) {
        const p = word.slice(0, -1);
        if (p.length >= 2 && isTag(p) && !r.prefixes.includes(p)) r.prefixes.push(p);
      } else if (isTag(word) && !r.tags.includes(word)) r.tags.push(word);
    }
    if (!out.includes(r) && (r.tags.length || r.prefixes.length)) out.push(r);
  }
  return out;
}

/**
 * The bucket the tags point to, with the tag that decided it: the one bucket matched by an exact tag; else, when no bucket matched
 * exactly, the one bucket matched by a pattern. Two or more on the deciding kind: null (the next rule of the order decides).
 * `usable` leaves out buckets that do not exist or that the caller may not file in.
 */
export function routeByTags(routes: BucketRoute[], tags: string[], usable: (bucket: string) => boolean): { bucket: string; tag: string; rule: string } | null {
  const exact = new Map<string, { tag: string; rule: string }>();
  const pattern = new Map<string, { tag: string; rule: string }>();
  for (const r of routes) {
    if (!usable(r.bucket)) continue;
    const t = tags.find((x) => r.tags.includes(x));
    if (t) exact.set(r.bucket, { tag: t, rule: t });
    for (const x of tags) {
      const pre = r.prefixes.find((p) => x.startsWith(p) && x.length > p.length);
      if (pre) {
        pattern.set(r.bucket, { tag: x, rule: `${pre}*` });
        break;
      }
    }
  }
  const one = exact.size === 1 ? exact : exact.size === 0 && pattern.size === 1 ? pattern : null;
  if (!one) return null;
  const [bucket, hit] = [...one][0]!;
  return { bucket, ...hit };
}
