// FR19 (T-356): a Portal MCP tool with no declared access policy is refused at registration; and the portal's real tools are held to it: each is
// declared, or is on the closed list of tools that predate the rule (undeclaredTools.ts), which only shrinks.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { declareToolPolicies, toolPolicyFor } from '../authz/seam.js';
import { declareAllToolPolicies } from './declareAll.js';
import { portalTools, registerPortalTool, ToolRegistry, z } from './registry.js';
import { auditUndeclared, UNDECLARED_TOOLS } from './undeclaredTools.js';

const toy = (name: string) => ({ name, title: 'Toy', description: 'A toy tool.', scope: 'read' as const, input: z.object({}), handler: () => ({ summary: 'ok' }) });
const enforcing = () => new ToolRegistry({ requireDeclared: { isDeclared: (n) => toolPolicyFor(n) !== undefined, exempt: new Set(['t356_listed']) } });

test('FR19: registering a tool with no declared policy throws, a declared one and a listed one are accepted', () => {
  const r = enforcing();
  assert.throws(() => r.register(toy('t356_bare')), /t356_bare" declares no access policy \(FR19\)/);
  assert.equal(r.get('t356_bare'), undefined, 'a refused tool is not registered');
  declareToolPolicies('toolDeclared.test', { t356_declared: { kind: 'signed-in' } });
  r.register(toy('t356_declared'));
  r.register(toy('t356_listed'));
  assert.deepEqual(r.list().map((t) => t.name), ['t356_declared', 't356_listed']);
  // A registry made without the rule (every test's own) still takes any tool.
  new ToolRegistry().register(toy('t356_anything'));
});

/** Every file of the server's sources that is not a test. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('FR19: every registered tool of the portal is declared or on the closed list; the list holds no declared tool', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const names = new Set<string>();
  for (const file of sources(root))
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:registry\.register|registerPortalTool)\(\{\s*name: '([a-z][a-z0-9_]+)'/g)) names.add(m[1]!);
  assert.ok(names.size > 100, `found ${names.size} tools in the sources`);

  // What index.ts declares before it registers anything: the chat tools by registerChatAuthz, every other module by declareAllToolPolicies (the
  // attention tools declare inside their register function, called here with an empty registry).
  const { registerChatAuthz } = await import('../chat/authz.js');
  const { registerAttentionTools } = await import('../attention/portalTools.js');
  registerChatAuthz(() => null);
  declareAllToolPolicies();
  registerAttentionTools({} as never, new ToolRegistry());

  const { unlisted, stale } = auditUndeclared(names, UNDECLARED_TOOLS, (n) => toolPolicyFor(n) !== undefined);
  assert.deepEqual(unlisted, [], `these tools have no declared policy (FR19): declare them in their module's authz.ts, never add them to undeclaredTools.ts\n${unlisted.join('\n')}`);
  assert.deepEqual(stale, [], `these are on the closed list but are declared or gone: remove them from undeclaredTools.ts\n${stale.join('\n')}`);
});

test('FR19 ratchet, stale half (T-356 P5): a listed tool that becomes declared, or is gone, must leave the list; an undeclared unlisted one must declare', () => {
  const names = new Set(['a_declared', 'b_listed', 'c_listed_then_declared', 'd_bare']);
  const declared = new Set(['a_declared', 'c_listed_then_declared']);
  const r = auditUndeclared(names, new Set(['b_listed', 'c_listed_then_declared', 'e_gone']), (n) => declared.has(n));
  assert.deepEqual(r.stale, ['c_listed_then_declared', 'e_gone'], 'declared now, and gone: both leave the list; the still-bare listed one stays');
  assert.deepEqual(r.unlisted, ['d_bare']);
  assert.deepEqual(auditUndeclared(names, new Set(['b_listed', 'd_bare']), (n) => declared.has(n)), { unlisted: [], stale: [] });
});

test('FR19 in production (T-356): the portal’s real registry refuses a tool with no declared policy, and the closed list is its only way in', () => {
  assert.throws(() => portalTools.register(toy('t356_bare_real')), /t356_bare_real" declares no access policy \(FR19\)/);
  assert.equal(portalTools.get('t356_bare_real'), undefined, 'a refused tool is not registered');
  assert.throws(() => registerPortalTool(toy('t356_bare_real')), /declares no access policy/, 'registerPortalTool goes through the same registry');
  // index.ts declares every module’s tool policies first: afterwards a declared tool is accepted.
  declareAllToolPolicies();
  assert.ok(toolPolicyFor('workspace_rename'), 'declareAllToolPolicies declares the workspace tools');
  declareToolPolicies('toolDeclared.test', { t356_real_declared: { kind: 'signed-in' } });
  portalTools.register(toy('t356_real_declared'));
  assert.ok(portalTools.get('t356_real_declared'));
  // A name on the closed list is accepted undeclared (the tools that predate the rule): it is the registry's exempt set, not a copy.
  const listed = [...UNDECLARED_TOOLS].find((n) => toolPolicyFor(n) === undefined)!;
  assert.ok(listed, 'the closed list has an undeclared tool');
  portalTools.register(toy(listed));
  assert.ok(portalTools.get(listed));
});
