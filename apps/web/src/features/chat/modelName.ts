// Model names as people read them, shared by the model picker and the Sessions list (T-375). No React, so the tests run it as is.

const FAMILY = /\b(fable|opus|sonnet|haiku)\b/i;
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i;

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "claude-opus-4-6" → opus, 4.6; null for an alias or anything else. */
export function parseModelId(id: string | null | undefined): { family: string; version: string } | null {
  const m = id ? MODEL_ID.exec(id) : null;
  return m ? { family: m[1]!.toLowerCase(), version: m[3] ? `${m[2]}.${m[3]}` : m[2]! } : null;
}

/** The family a model value names ("opus" for "claude-opus-5-5", "opus[1m]" or "Opus 5.5"), or null. */
export const familyOf = (value: string): string | null => FAMILY.exec(value)?.[1]?.toLowerCase() ?? null;

/** A family and version anywhere in an id ("us.anthropic.claude-haiku-4-5-20251001-v1:0"); a date after the version is not a minor one. */
const EMBEDDED = /claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i;

/**
 * A model in a few characters: "claude-opus-5-5" → "Opus 5.5", the alias "sonnet" → "Sonnet". An id the portal cannot read is shown as it
 * is (it is what Claude Code reported, never a guess); null before the first report.
 */
export function modelShortName(model: string | null | undefined): string | null {
  const v = model?.trim();
  if (!v) return null;
  const m = EMBEDDED.exec(v);
  if (m) return `${cap(m[1]!.toLowerCase())} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
  const family = familyOf(v);
  return family ? cap(family) : v;
}
