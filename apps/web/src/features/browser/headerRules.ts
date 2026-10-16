import type { BrowserHeaderRule } from '@portal/contracts';

// The header rules of a browser pool (browser PRD §24, T-623, T-856). Pure helpers, so the editor and its test share one
// edit path: a rule is only ever copied and changed in one field, so a field the editor does not touch (a `key` set through
// the API or MCP, or a future one) survives every edit and every save. The pool holds NAMES, never a secret's value.

/** The server's limit (apps/server/src/browser/headers.ts MAX_HEADERS). */
export const MAX_HEADER_RULES = 10;

export type HeaderRuleField = 'hosts' | 'name' | 'secret' | 'key';

export const blankRule = (): BrowserHeaderRule => ({ hosts: [], name: '', secret: '' });

/** Hosts typed as free text: split on new lines, commas and spaces, empties dropped. */
export const parseHosts = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

/**
 * The rule list with one field of one rule changed. Everything else is copied as it is. An empty `key` removes the property (the
 * entry's whole value is then the header's value); the server refuses an empty string as a variable name.
 */
export function editRule(rules: BrowserHeaderRule[], index: number, field: HeaderRuleField, text: string): BrowserHeaderRule[] {
  return rules.map((rule, i) => {
    if (i !== index) return rule;
    const next: BrowserHeaderRule = { hosts: rule.hosts, name: rule.name, secret: rule.secret };
    if (field === 'hosts') next.hosts = parseHosts(text);
    else if (field === 'key') {
      const key = text.trim();
      if (key) next.key = key;
      else delete next.key;
    } else next[field] = text.trim();
    return next;
  });
}

export const addRule = (rules: BrowserHeaderRule[]): BrowserHeaderRule[] => (rules.length >= MAX_HEADER_RULES ? rules : [...rules, blankRule()]);

export const removeRule = (rules: BrowserHeaderRule[], index: number): BrowserHeaderRule[] => rules.filter((_, i) => i !== index);
