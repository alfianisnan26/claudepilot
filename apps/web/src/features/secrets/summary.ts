import type { PoolSummary, SecretsContent } from '@portal/contracts';

/** What a set holds, for its card and the Add-ons notes. */
export function setCounts(p: PoolSummary) {
  const entries = (p.content as SecretsContent | null)?.entries ?? [];
  const secrets = entries.filter((e) => e.kind === 'secret');
  return {
    variables: entries.length - secrets.length,
    secrets: secrets.length,
    needsValue: secrets.filter((e) => !e.secret?.stored).length,
  };
}

const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** "4 variables · 2 secrets · 1 needs a value" (PRD §12). */
export function setSummary(p: PoolSummary): string {
  const c = setCounts(p);
  if (c.variables + c.secrets === 0) return 'Empty';
  return [c.variables && n(c.variables, 'variable'), c.secrets && n(c.secrets, 'secret'), c.needsValue && `${c.needsValue} need${c.needsValue === 1 ? 's' : ''} a value`]
    .filter(Boolean)
    .join(' · ');
}
