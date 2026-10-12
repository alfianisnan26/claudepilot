// The candidate: the newest Claude Code the npm registry offers (docs/prd/claude-version-pinning.md §12). Read from the registry's own dist-tags
// endpoint (a few hundred bytes), never guessed: offline, a refusal or an answer that is not what the registry says is `unavailable`, with why.
// ✅ 2026-10-12: `https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags` answered {"stable":"2.1.287","next":"2.1.296","latest":"2.1.296"}.

import { compareClaudeVersions, isExactClaudeVersion, type ClaudeCandidate } from '@portal/contracts';

export const REGISTRY_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

export type RegistryReading = { ok: true; channels: Record<string, string> } | { ok: false; reason: string };

/** Reads the registry's channels. Never throws. */
export async function readRegistry(fetchImpl: typeof fetch = fetch, url = REGISTRY_URL): Promise<RegistryReading> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) return { ok: false, reason: `The npm registry answered ${res.status}.` };
    const body = await res.text();
    if (body.length > MAX_BYTES) return { ok: false, reason: 'The npm registry’s answer was larger than expected.' };
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'The npm registry’s answer was not a list of channels.' };
    const channels: Record<string, string> = {};
    for (const [tag, v] of Object.entries(parsed as Record<string, unknown>)) if (/^[a-z][a-z0-9-]{0,30}$/i.test(tag) && isExactClaudeVersion(v)) channels[tag] = v;
    if (!channels.latest) return { ok: false, reason: 'The npm registry named no latest version.' };
    return { ok: true, channels };
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string }; message?: string };
    const why = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timed out' : (err.cause?.code ?? err.message ?? 'failed');
    return { ok: false, reason: `Could not reach the npm registry (${why}).` };
  }
}

/** The candidate against what is installed. */
export function candidateOf(reading: RegistryReading, installed: string | null, now: Date): ClaudeCandidate {
  const checkedAt = now.toISOString();
  if (!reading.ok) return { status: 'unavailable', version: null, channels: {}, checkedAt, reason: reading.reason };
  const version = reading.channels.latest!;
  const c = compareClaudeVersions(version, installed);
  const status: ClaudeCandidate['status'] = c === null ? 'unknown' : c === 0 ? 'same' : c > 0 ? 'newer' : 'older';
  return { status, version, channels: reading.channels, checkedAt, reason: null };
}
