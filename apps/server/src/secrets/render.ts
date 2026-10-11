import { SECRETS_DIR, type SecretValueInfo } from '@portal/contracts';
import { dropInPath } from '../delivery/ownership.js';

/**
 * Single-quoted for sh, bash and dash: `'` is written as `'\''` (PRD §10.1), the one character single
 * quotes can't hold. Everything else, `$`, backquotes, backslashes and `!` included, stays literal.
 */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One `env.sh` line: a plain value, or a secret read from its file when the shell starts. */
export type ShellVariable = { name: string; value: string } | { name: string; file: string };

/**
 * `/etc/claudepilot/secrets/env.sh`, sourced by login and interactive shells through the image hooks
 * (§10.3): one `export` per variable, pointer and exposed secret marked "Terminals need it". An exposed
 * secret is read from its file (`"$(cat …)"`) instead of being written here, so this file never holds a
 * secret value and "Preview files" can show it whole. Names are checked variable names, so they need no
 * quoting. Sorted, so the same sets always give the same file.
 */
export function renderEnvSh(variables: ShellVariable[]): string {
  const lines = [...variables]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((v) => ('value' in v ? `export ${v.name}=${shellQuote(v.value)}` : `export ${v.name}="$(cat ${shellQuote(v.file)} 2>/dev/null)"`));
  return [
    '# Written by claudepilot (Secrets & env). Changes here are overwritten.',
    '# Login and interactive shells read it through /etc/profile.d/claudepilot.sh and /etc/bash.bashrc;',
    '# an open shell picks up changes with: . /etc/claudepilot/secrets/env.sh',
    ...lines,
    '',
  ].join('\n');
}

/**
 * The drop-in's deny rules (A1, FR25): Claude's Read and Edit tools on everything this pool delivers, plus
 * other processes' environments while a secret is exposed as a variable. Always the absolute `//` form: a
 * single leading `/` is anchored to the settings file's folder and would protect nothing (§10.4).
 */
export function denyRules(exposed: boolean): string[] {
  const own = `/${dropInPath('secrets')}`;
  return [
    `Read(/${SECRETS_DIR}/**)`,
    `Edit(/${SECRETS_DIR}/**)`,
    `Read(${own})`,
    `Edit(${own})`,
    ...(exposed ? ['Read(//proc/**/environ)'] : []),
  ];
}

/** What "Preview files" shows where a secret value would go (PRD §12): `«secret NAME v3 · 3f9a1c2e»`. */
export const placeholder = (name: string, info: SecretValueInfo | null) => `«secret ${name}${info ? ` v${info.version} · ${info.fingerprint}` : ''}»`;
