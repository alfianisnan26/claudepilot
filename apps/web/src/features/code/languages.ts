/**
 * The grammars of the code viewer (T-148), each loaded on demand: a file opens with only its own language fetched, and none of them is in
 * the main bundle. A grammar that fails to load leaves the text plain (the viewer never waits on it to show the file).
 */
import { type Language, StreamLanguage } from '@codemirror/language';
import type { CodeLanguage } from './language';

const LOADERS: Record<Exclude<CodeLanguage, 'plain'>, () => Promise<Language>> = {
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yamlLanguage),
  json: () => import('@codemirror/lang-json').then((m) => m.jsonLanguage),
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascriptLanguage),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.jsxLanguage),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.typescriptLanguage),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.tsxLanguage),
  python: () => import('@codemirror/lang-python').then((m) => m.pythonLanguage),
  sql: () => import('@codemirror/lang-sql').then((m) => m.StandardSQL.language),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdownLanguage),
  html: () => import('@codemirror/lang-html').then((m) => m.htmlLanguage),
  css: () => import('@codemirror/lang-css').then((m) => m.cssLanguage),
  shell: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  dockerfile: () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => StreamLanguage.define(m.dockerFile)),
  toml: () => import('@codemirror/legacy-modes/mode/toml').then((m) => StreamLanguage.define(m.toml)),
  diff: () => import('@codemirror/legacy-modes/mode/diff').then((m) => StreamLanguage.define(m.diff)),
};

/** The grammar for a language, or null for plain text. */
export function loadLanguage(id: CodeLanguage): Promise<Language | null> {
  return id === 'plain' ? Promise.resolve(null) : LOADERS[id]();
}
