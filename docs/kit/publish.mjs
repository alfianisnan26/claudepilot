#!/usr/bin/env node
// Publishes the operating kit (docs/kit) into a pilot portal's pools. Idempotent: a pool that exists by name gets a new revision.
//   PORTAL=https://pilot.example PORTAL_SERVER_CODE=... node docs/kit/publish.mjs [--apply] [--only=contexts,persona,skills,mcp]
// Without --apply it only reads the portal and prints what it WOULD do. It never approves an MCP entry (a person reviews third-party servers: docs/kit/mcp/REVIEW.md),
// never creates a Secrets pool, never assigns anything to a workspace (that is a separate, owner-confirmed step), and never prints a credential.
// The mcp part: entries marked publish in docs/kit/mcp/manifest.json become DRAFTS in the catalog; a program set (isnan, konfersi, kohi-labs) is created only
// once every entry of it has an approved version (approved by a person in the portal), otherwise the run says the set is waiting.
// Skills are text only (no scripts): the script approves a skill version only when the scan shows no finding that needs an acknowledgement and no script.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTAL = process.env.PORTAL ?? 'https://pilot.ai.isnan.me';
const CODE = process.env.PORTAL_SERVER_CODE;
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? 'contexts,persona,skills,mcp').split(',');
const KIT_VERSION = readFileSync(join(HERE, 'VERSION'), 'utf8').trim();
// Where the ids go (default docs/kit/published.json; a trial against a throwaway portal points it elsewhere: PUBLISHED_FILE=/tmp/x.json).
const PUBLISHED_FILE = process.env.PUBLISHED_FILE ?? join(HERE, 'published.json');
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
  // Behind the TLS proxy Hono's csrf() compares a form-like (multipart) request's Origin with the http URL it sees, so an https Origin is refused
  // (a ticket is open: multipart csrf behind the proxy): until that is fixed the upload names the same host with http, which the portal's own host check accepts.
  const headers = { origin: raw ? PORTAL.replace(/^https:/, 'http:') : PORTAL, cookie, ...(raw ? {} : { 'content-type': 'application/json' }) };
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

// A run that skips a part keeps that part's ids from the last run (published.json is merged, never emptied).
const previous = (() => {
  try {
    const p = JSON.parse(readFileSync(PUBLISHED_FILE, 'utf8'));
    return p.portal === PORTAL ? p : {}; // ids of another portal mean nothing here
  } catch {
    return {};
  }
})();
const published = {
  kit: KIT_VERSION,
  at: new Date().toISOString(),
  portal: PORTAL,
  contexts: {},
  persona: null,
  skillset: null,
  skills: {},
  ...Object.fromEntries(Object.entries(previous).filter(([k]) => ['contexts', 'persona', 'skillset', 'skills', 'mcp'].includes(k) && !ONLY.includes(k === 'skillset' ? 'skills' : k))),
};

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
    // A re-publish adds a NEW version of a changed skill: take the newest version of each name (a set refuses two skills with one name).
    const newest = new Map();
    for (const v of library.versions.filter((x) => names.includes(x.name))) {
      const cur = newest.get(v.name);
      if (!cur || String(v.createdAt ?? '') > String(cur.createdAt ?? '')) newest.set(v.name, v);
    }
    const versions = [...newest.values()];
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

/* ---------- mcp: catalog drafts, then the program sets once a person approved their entries ---------- */
// Never approves: the only way out of draft is the portal's review page (POST .../approve is not called anywhere in this file).
// Never assigns a set to a workspace and never touches a Secrets pool: the sets only NAME secrets as {{secret-file:NAME}}.
if (ONLY.includes('mcp')) {
  const mcpDir = join(HERE, 'mcp');
  const manifest = JSON.parse(readFileSync(join(mcpDir, 'manifest.json'), 'utf8'));
  const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const SECRET_REF = /^\{\{secret-file:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\}\}$/;
  const problems = [];
  const read = (file) => JSON.parse(readFileSync(join(mcpDir, file), 'utf8'));

  // 1. validate the files (the portal checks again, and is the authority)
  const entries = manifest.entries.filter((e) => e.publish === true).map((m) => ({ ...m, body: read(m.file) }));
  const entryKeys = new Set(manifest.entries.map((e) => e.key));
  for (const e of entries) {
    if (e.body.key !== e.key) problems.push(`${e.file}: key "${e.body.key}" is not the manifest's "${e.key}"`);
    if (e.key.length > 16 || !KEY.test(e.key)) problems.push(`${e.file}: key must be [a-z0-9-], at most 16`);
  }
  const sets = manifest.sets.filter((s) => s.publish !== false).map((m) => ({ ...m, body: read(m.file) }));
  for (const s of sets) {
    const { slug, servers } = s.body;
    if (slug !== s.slug) problems.push(`${s.file}: slug "${slug}" is not the manifest's "${s.slug}"`);
    if (slug.length > 12 || !KEY.test(slug)) problems.push(`${s.file}: slug must be [a-z0-9-], at most 12`);
    const seen = new Set();
    for (const v of servers) {
      if (v.key.length > 16 || !KEY.test(v.key) || seen.has(v.key)) problems.push(`${s.file}: server key "${v.key}" is invalid or used twice`);
      seen.add(v.key);
      const k = /^@(.+)$/.exec(v.entry)?.[1];
      if (!k || !entryKeys.has(k)) problems.push(`${s.file}: server ${v.key} names entry "${v.entry}", which the manifest does not list`);
      else if (!entries.some((e) => e.key === k)) problems.push(`${s.file}: server ${v.key} needs entry ${k}, which is not marked publish`);
      else if (!s.entries.includes(k)) problems.push(`${s.file}: server ${v.key} uses entry ${k}, which the manifest's set row does not list`);
      if (v.version !== '@approved') problems.push(`${s.file}: server ${v.key} version must be "@approved"`);
      for (const [slot, ref] of Object.entries(v.secrets ?? {})) {
        const name = SECRET_REF.exec(ref)?.[1];
        if (!name) problems.push(`${s.file}: server ${v.key} secret ${slot} must be {{secret-file:NAME}}`);
        else if (!s.secretNames.includes(name)) problems.push(`${s.file}: server ${v.key} uses secret name ${name}, which the manifest's set row does not list`);
      }
    }
  }
  if (problems.length) throw new Error(`mcp files do not validate:\n  ${problems.join('\n  ')}`);
  log(`mcp: ${entries.length} entries to publish as drafts, ${sets.length} sets (${sets.map((s) => s.slug).join(', ')}); not published by choice: ${manifest.entries.filter((e) => e.publish !== true).map((e) => e.key).join(', ')}`);
  for (const p of manifest.prerequisites ?? []) log(`mcp prerequisite (not checked by this script; for ${p.for.join(', ')}): ${p.what.slice(0, 160)}...`);

  // What the portal stores for a version, so "the same spec" is compared in the portal's own normal form.
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  const specOf = (kind, s) => {
    if (kind === 'remote')
      return { url: new URL(s.url).href, transport: s.transport === 'sse' ? 'sse' : 'http', auth: s.auth === 'headers' || s.auth === 'oauth' ? s.auth : 'none', ...(s.auth === 'oauth' && s.oauth ? { oauth: s.oauth } : {}), ...(s.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}) };
    if (kind === 'command') return { path: s.path, args: s.args ?? [] };
    return { package: s.package, args: s.args ?? [], ...(s.bin ? { bin: s.bin } : {}), ...(s.allowScripts === true ? { allowScripts: true } : {}) };
  };
  const slotsOf = (list) =>
    (list ?? []).map((x) => {
      const target = x.target === 'header' || x.target === 'path' ? x.target : 'env';
      const secret = target === 'path' ? true : x.secret === true;
      return {
        name: x.name,
        target,
        secret,
        required: x.required === true,
        ...(x.description?.trim() ? { description: x.description.trim() } : {}),
        ...(x.docUrl?.trim() ? { docUrl: x.docUrl.trim() } : {}),
        ...(!secret && x.default !== undefined && x.default !== null && x.default !== '' ? { default: x.default } : {}),
        ...(target === 'header' && x.template && x.template !== '{value}' ? { template: x.template } : {}),
      };
    });
  const sameVersion = (kind, body, v) =>
    canon(specOf(kind, body.spec)) === canon(specOf(kind, v.spec)) && canon(slotsOf(body.slots)) === canon(slotsOf(v.slots)) && (kind !== 'npm' || body.version === v.version);

  // 2. entries: a draft where the key is new; a new draft version where the spec changed; nothing where it is the same
  let catalog = await api('GET', '/api/mcp/catalog');
  const entryId = {};
  for (const e of entries) {
    const found = catalog.find((c) => c.key === e.key);
    const review = (id) => `${PORTAL}/admin/pools/mcp/catalog/${id}`;
    if (!found) {
      if (!APPLY) {
        log(`[dry] mcp entry ${e.key}: would create it as a draft (${e.reason})`);
        continue;
      }
      const made = await api('POST', '/api/mcp/catalog', e.body);
      entryId[e.key] = made.id;
      log(`mcp entry ${e.key}: created as a DRAFT, waiting for the owner's approval: ${review(made.id)}\n  why: ${e.reason}`);
      continue;
    }
    entryId[e.key] = found.id;
    if (found.kind !== e.body.kind) throw new Error(`mcp entry ${e.key} is a ${found.kind} entry in the portal and a ${e.body.kind} entry here: not touching it`);
    const same = found.versions.find((v) => sameVersion(e.body.kind, e.body, v));
    if (same) {
      log(`mcp entry ${e.key}: unchanged (${same.version} is ${same.reviewState})${same.reviewState === 'draft' ? `: waiting for the owner's approval: ${review(found.id)}` : ''}`);
      continue;
    }
    const waiting = found.versions.find((v) => v.reviewState === 'draft');
    if (waiting) {
      log(`mcp entry ${e.key}: the file differs from every version, and ${waiting.version} still waits as a draft with another spec: not adding a second draft; delete or approve that one first: ${review(found.id)}`);
      continue;
    }
    if (!APPLY) {
      log(`[dry] mcp entry ${e.key}: the spec differs from every version: would add a new draft version`);
      continue;
    }
    const { version, spec, slots } = e.body;
    const next = await api('POST', `/api/mcp/catalog/${found.id}/versions`, { ...(version ? { version } : {}), spec, slots });
    log(`mcp entry ${e.key}: spec changed, new DRAFT version ${next.versions[0]?.version}, waiting for the owner's approval: ${review(found.id)}`);
  }
  if (APPLY) catalog = await api('GET', '/api/mcp/catalog');

  // 3. sets: only when every entry of the set has an approved version
  const approvedOf = (key) => {
    const c = catalog.find((x) => x.key === key);
    const v = c?.versions.find((x) => x.reviewState === 'approved'); // newest first
    return c && v ? { id: c.id, version: v.version } : null;
  };
  const poolList = await api('GET', '/api/pools/mcpset');
  const pools = Array.isArray(poolList) ? poolList : (poolList?.items ?? []);
  published.mcp = { entries: {}, sets: {} };
  for (const [k, id] of Object.entries(entryId)) published.mcp.entries[k] = id;
  for (const s of sets) {
    const missing = s.entries.filter((k) => !approvedOf(k));
    if (missing.length) {
      log(`set ${s.slug}: waiting for the owner's approval of ${missing.join(', ')}`);
      continue;
    }
    const content = {
      slug: s.body.slug,
      servers: s.body.servers.map((v) => {
        const a = approvedOf(v.entry.slice(1));
        return { key: v.key, entry: a.id, version: a.version, enabled: v.enabled !== false, config: v.config ?? {}, secrets: v.secrets ?? {} };
      }),
    };
    const found = pools.find((p) => p.name === s.name);
    const note = `operating kit ${KIT_VERSION}`;
    const description = `Operating kit: the ${s.name} program's Gitea and Outline (${s.secretNames.join(', ')}).`;
    try {
      if (!found) {
        if (!APPLY) log(`[dry] set ${s.slug}: would create the pool mcpset "${s.name}"`);
        else {
          const r = await api('POST', '/api/pools/mcpset', { name: s.name, description, content, note });
          published.mcp.sets[s.slug] = r.id;
          log(`set ${s.slug}: created the pool mcpset "${s.name}" (revision ${r.latestRevision}, ${r.status}); assign it to workspaces by hand`);
        }
      } else if (found.content?.slug !== content.slug) {
        throw new Error(`the pool "${s.name}" holds the slug "${found.content?.slug}", not "${content.slug}": tool names depend on the slug, so it is not changed here`);
      } else {
        published.mcp.sets[s.slug] = found.id;
        if (canon(found.content) === canon(content)) log(`set ${s.slug}: unchanged (pool "${s.name}", revision ${found.latestRevision})`);
        else if (!APPLY) log(`[dry] set ${s.slug}: would add a revision to "${s.name}"`);
        else {
          const r = await api('PUT', `/api/pools/mcpset/${found.id}`, { name: s.name, description, content, note, baseRevision: found.latestRevision });
          log(`set ${s.slug}: new revision ${r.latestRevision} of "${s.name}" (${r.status})`);
        }
      }
    } catch (e) {
      log(`set ${s.slug}: REFUSED: ${e.message}`);
      process.exitCode = 1;
    }
  }
  for (const s of sets) log(`set ${s.slug}: secret names it needs (Secrets & env, by a person): ${s.secretNames.join(', ')}; tool rules: mcp/tool-rules.json, permissions.${s.slug}`);
}

if (APPLY) {
  writeFileSync(PUBLISHED_FILE, JSON.stringify(published, null, 2) + '\n');
  log(`written ${PUBLISHED_FILE === join(HERE, 'published.json') ? 'docs/kit/published.json' : PUBLISHED_FILE} (ids only)`);
}
log(APPLY ? 'done' : 'dry run only: add --apply');
