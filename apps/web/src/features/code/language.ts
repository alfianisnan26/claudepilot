/**
 * The language of a text file for the code viewer (T-148), from its name and then its media type. Pure and free of CodeMirror, so it is
 * in the main bundle at no cost and testable on its own; the grammar itself is loaded on demand (`languages.ts`).
 */
export type CodeLanguage =
  | 'yaml'
  | 'json'
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'shell'
  | 'sql'
  | 'markdown'
  | 'html'
  | 'css'
  | 'dockerfile'
  | 'toml'
  | 'diff'
  | 'plain';

/** What the viewer's label says. */
export const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  yaml: 'YAML',
  json: 'JSON',
  javascript: 'JavaScript',
  jsx: 'JSX',
  typescript: 'TypeScript',
  tsx: 'TSX',
  python: 'Python',
  shell: 'Shell',
  sql: 'SQL',
  markdown: 'Markdown',
  html: 'HTML',
  css: 'CSS',
  dockerfile: 'Dockerfile',
  toml: 'TOML',
  diff: 'Diff',
  plain: 'Text',
};

const BY_EXTENSION: Record<string, CodeLanguage> = {
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyi: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  env: 'shell',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  toml: 'toml',
  diff: 'diff',
  patch: 'diff',
};

/** Whole file names that say their language without an extension (or with a misleading one). */
const BY_NAME: Record<string, CodeLanguage> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  '.env': 'shell',
  'cargo.lock': 'toml',
  'pipfile': 'toml',
};

const BY_MEDIA_TYPE: Record<string, CodeLanguage> = {
  'application/json': 'json',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
  'text/x-yaml': 'yaml',
  'text/javascript': 'javascript',
  'application/javascript': 'javascript',
  'text/typescript': 'typescript',
  'application/typescript': 'typescript',
  'text/x-python': 'python',
  'text/x-shellscript': 'shell',
  'application/x-sh': 'shell',
  'application/sql': 'sql',
  'text/markdown': 'markdown',
  'text/html': 'html',
  'application/xml': 'html',
  'text/xml': 'html',
  'text/css': 'css',
  'application/toml': 'toml',
  'text/x-diff': 'diff',
  'text/x-patch': 'diff',
};

/** The language of a file: its name first (Dockerfile, .env, *.yaml), then its media type; anything else is plain text. */
export function languageFor(name: string, mediaType?: string): CodeLanguage {
  const base = (name.split(/[\\/]/).pop() ?? '').toLowerCase();
  const named = (Object.hasOwn(BY_NAME, base) ? BY_NAME[base] : undefined) ?? (base.startsWith('.env.') ? 'shell' : base.startsWith('dockerfile.') ? 'dockerfile' : undefined);
  if (named) return named;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1) : '';
  const byExt = Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : undefined;
  if (byExt) return byExt;
  const media = (mediaType ?? '').split(';')[0]!.trim().toLowerCase();
  return (Object.hasOwn(BY_MEDIA_TYPE, media) ? BY_MEDIA_TYPE[media] : undefined) ?? 'plain';
}
