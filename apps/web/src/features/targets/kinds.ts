import { CONNECT_KINDS, CONNECT_ROLE, type ConnectKind, type ConnectRole } from '@portal/contracts';

/**
 * The kinds the Add wizard offers. A seam: a later kind (a Codespace) registers here with `registerKind` and the wizard,
 * the row icon and the type select read this list; nothing else in the feature names a kind.
 */
export interface KindEntry {
  kind: ConnectKind | (string & {});
  role: ConnectRole;
  /** The select's option and the row's kind word. */
  label: string;
  /** What the row's muted line says first: `Docker`, `Host`. */
  word: string;
}

const BUILTIN: KindEntry[] = [
  { kind: 'docker', role: 'cluster', label: 'Docker', word: 'Docker' },
  { kind: 'swarm', role: 'cluster', label: 'Swarm', word: 'Swarm' },
  { kind: 'kubernetes', role: 'cluster', label: 'Kubernetes', word: 'Kubernetes' },
  { kind: 'container', role: 'single', label: 'Container', word: 'Container' },
  { kind: 'host', role: 'single', label: 'Host', word: 'Host' },
];

const extra: KindEntry[] = [];

export function registerKind(entry: KindEntry): void {
  if (![...BUILTIN, ...extra].some((k) => k.kind === entry.kind)) extra.push(entry);
}

export const kindEntries = (): KindEntry[] => [...BUILTIN, ...extra];
export const kindsOf = (role: ConnectRole): KindEntry[] => kindEntries().filter((k) => k.role === role);
export const kindLabel = (kind: string): string => kindEntries().find((k) => k.kind === kind)?.label ?? kind;
export const kindWord = (kind: string): string => kindEntries().find((k) => k.kind === kind)?.word ?? kind;

/** Every kind of the contract is built in: a guard for the one place that must stay in step. */
export const BUILTIN_KINDS_MATCH = BUILTIN.every((k) => CONNECT_ROLE[k.kind as ConnectKind] === k.role) && BUILTIN.length === CONNECT_KINDS.length;
