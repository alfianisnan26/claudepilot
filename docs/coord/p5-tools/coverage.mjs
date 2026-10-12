import { readFileSync } from 'node:fs';
const types = ['platform','user','team','target','workspace','claude','session','repo','ci_repo','ci_run','terminal','browser','ticket','pool','account','endpoint','account_pool','vault','mcp_entry','skill_source','skill_version','proposal','trigger','budget','template','personal'];
const routes = readFileSync('policy-table.md','utf8').split('\n').filter((l)=>l.startsWith('| `'));
const tools = readFileSync('tools-table.md','utf8').split('\n').filter((l)=>l.startsWith('| `'));
const names = (access) => {
  const out = new Set();
  for (const m of access.matchAll(/\b([a-z_]+)\s+(?:view|operate|manage)\b/g)) out.add(m[1]);
  for (const m of access.matchAll(/(?:list|create)\(\s*([a-z_]+)/g)) out.add(m[1]);
  for (const m of access.matchAll(/platform\(/g)) out.add('platform');
  for (const m of access.matchAll(/filter ([a-z_]+)/g)) out.add(m[1]);
  return out;
};
const col = (rows, i) => rows.map((r) => r.split(/(?<!\\)\|/)[i] ?? '');
const ra = col(routes, 2).map(names), ta = col(tools, 3).map(names);
console.log('| Object type | Routes | Tools |');
console.log('| --- | --- | --- |');
for (const t of types) console.log(`| \`${t}\` | ${ra.filter((s) => s.has(t)).length} | ${ta.filter((s) => s.has(t)).length} |`);
