#!/usr/bin/env node
// Publishes the operating kit (docs/kit) into a pilot portal's pools. Idempotent: a pool that exists by name gets a new revision.
//   PORTAL=https://pilot.example PORTAL_SERVER_CODE=... node docs/kit/publish.mjs [--apply] [--only contexts,persona,skills]
// Without --apply it only reads the portal and prints what it WOULD do. It never approves an MCP entry (a person reviews third-party servers: docs/kit/mcp/REVIEW.md),
// never creates a Secrets pool, never assigns anything to a workspace (that is a separate, owner-confirmed step), and never prints a credential.
// Skills are text only (no scripts): the script approves a skill version only when the scan shows no finding that needs an acknowledgement and no script.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTAL = process.env.PORTAL ?? 'https://pilot.ai.isnan.me';
const CODE = process.env.PORTAL_SERVER_CODE;
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? 'contexts,persona,skills').split(',');
const KIT_VERSION = readFileSync(join(HERE, 'VERSION'), 'utf8').trim();
if (!CODE) {
  console.error('PORTAL_SERVER_CODE is not set');
  process.exit(1);
}
const log = (...a) => console.log(...a);

let cookie = '';
async function api(method, path, body, raw) {
  if (!cookie) {
    const l = await fetch(`${PORTAL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: PORTAL }, body: JSON.stringify({ code: CODE }) });
    if (!l.ok) throw new Error(`sign-in refused (${l.status})`);
    cookie = (l.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  }
  const headers = { origin: PORTAL, cookie, ...(raw ? {} : { 'content-type': 'application/json' }) };
  const res = await fetch(`${PORTAL}${path}`, { method, headers, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''} ${JSON.stringify(json?.error?.details ?? '').slice(0, 300)}`);
  return json?.data;
}

const descriptionOf = (name, text) => {
  const m = /^#\s.*\n+([^\n#][^\n]*)/.exec(text);
  return (m?.[1] ?? `Operating kit: ${name}`).slice(0, 300);
};

/** Create the pool or add a revision when it exists (by name). Returns the pool summary. */
async function upsertPool(type, name, description, content, note) {
  const list = await api('GET', `/api/pools/${type}`);
  const items = Array.isArray(list) ? list : (list?.items ?? []);
  const found = items.find((p) => p.name === name);
  if (!APPLY) {
    log(`[dry] ${type} "${name}": would ${found ? 'add a revision to' : 'create'} it`);
    return found ?? { id: `dry-${type}-${name}`, name };
  }
  if (found) {
    const r = await api('PUT', `/api/pools/${type}/${found.id}`, { name, description, content, note, baseRevision: found.currentRevision });
    log(`${type} "${name}": new revision`);
    return r?.pool ?? r ?? found;
  }
  const r = await api('POST', `/api/pools/${type}`, { name, description, content, note });
  log(`${type} "${name}": created`);
  return r?.pool ?? r;
}

const published = { kit: KIT_VERSION, at: new Date().toISOString(), portal: PORTAL, contexts: {}, persona: null, skillset: null, skills: {} };

/* ---------- contexts ---------- */
const ctxDir = join(HERE, 'contexts');
if (ONLY.includes('contexts')) {
  for (const f of readdirSync(ctxDir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md').sort()) {
    const name = f.slice(0, -3);
    const body = readFileSync(join(ctxDir, f), 'utf8');
    if (Buffer.byteLength(body) > 20 * 1024) throw new Error(`${f} is over 20 KB`);
    const pool = await upsertPool('context', name, descriptionOf(name, body), { body }, `operating kit ${KIT_VERSION}`);
    published.contexts[name] = pool.id;
  }
}

/* ---------- persona ---------- */
if (ONLY.includes('persona')) {
  const p = JSON.parse(readFileSync(join(HERE, 'persona/pilot-way.json'), 'utf8'));
  // the always-delivered contexts travel with the persona; the templates and the bootstrap are assigned on their own
  const WITH_PERSONA = ['charter-essentials', 'work-rhythm', 'safety-rules'];
  const ids = WITH_PERSONA.map((n) => published.contexts[n] ?? null);
  if (ids.every(Boolean)) p.content.contexts = ids;
  else if (APPLY) log(`persona: contexts not linked (${WITH_PERSONA.filter((n) => !published.contexts[n]).join(', ')} not published in this run: run with the contexts first)`);
  const pool = await upsertPool('persona', p.name, p.description, p.content, `operating kit ${KIT_VERSION}`);
  published.persona = pool.id;
}

/* ---------- skills ---------- */
if (ONLY.includes('skills')) {
  const dir = join(HERE, 'skills');
  const names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  for (const n of names) walk(join(dir, n));
  log(`skills: ${names.length} skills, ${files.length} files`);
  if (APPLY) {
    const form = new FormData();
    form.append('paths', JSON.stringify(files.map((f) => `kit-skills/${relative(dir, f)}`)));
    for (const f of files) form.append('files', new Blob([readFileSync(f)]), f.split('/').pop());
    const imp = await api('POST', '/api/skills/import', form, true);
    for (const s of imp.skills) log(`  ${s.name}: ${s.status}, ${s.review}, findings ${JSON.stringify(s.findings)}${s.scripted ? ', SCRIPTED' : ''}`);
    if (imp.refused?.length) throw new Error(`refused: ${JSON.stringify(imp.refused)}`);
    const library = await api('GET', '/api/skills/library');
    const versions = library.versions.filter((v) => names.includes(v.name));
    for (const v of versions) {
      if (v.scripted || v.hooks || v.network) throw new Error(`${v.name} is scripted or has hooks or network use: not approving a kit skill with those`);
      if (v.review !== 'approved') {
        const detail = await api('GET', `/api/skills/versions/${v.id}`);
        const needs = (detail.findings ?? []).filter((x) => x.needsAck);
        if (needs.length) throw new Error(`${v.name} has findings that need a person's acknowledgement: ${needs.map((x) => x.id).join(', ')}`);
        await api('POST', `/api/skills/versions/${v.id}/review`, { decision: 'approved', note: `operating kit ${KIT_VERSION}: text-only skill authored and independently reviewed (docs/kit/REVIEW-LOG.md)`, acknowledged: [], licenseConfirmed: true });
      }
      published.skills[v.name] = v.id;
    }
    const listing = versions.reduce((n, v) => n + (v.listingChars ?? 0), 0);
    log(`skills approved: ${versions.length}; listing size ${listing} characters`);
    const entries = versions.map((v) => ({ versionId: v.id, mode: 'on', stripAllowedTools: false }));
    const pool = await upsertPool('skillset', 'pilot-way', 'The operating kit skills: charter, decisions, tickets, git, CI, safety, QA, knowledge.', { prefix: 'pilot', skills: entries }, `operating kit ${KIT_VERSION}`);
    published.skillset = pool.id;
  } else log('[dry] skills: would import the folder, approve text-only versions and create the skillset "pilot-way" with prefix "pilot"');
}

if (APPLY) {
  writeFileSync(join(HERE, 'published.json'), JSON.stringify(published, null, 2) + '\n');
  log('written docs/kit/published.json (ids only)');
}
log(APPLY ? 'done' : 'dry run only: add --apply');
