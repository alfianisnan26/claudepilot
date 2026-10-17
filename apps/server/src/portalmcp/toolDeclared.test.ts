// FR19 (T-356): a Portal MCP tool with no declared access policy is refused at registration; and the portal's real tools are held to it: each is
// declared, or is on the closed list of tools that predate the rule (undeclaredTools.ts), which only shrinks.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { declareToolPolicies, toolPolicyFor } from '../authz/seam.js';
import { ToolRegistry, z } from './registry.js';
import { UNDECLARED_TOOLS } from './undeclaredTools.js';

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

  // What the modules declare (the ones that declare inside their register function are called with an empty registry).
  const { declarePortalMcpPolicies } = await import('./authz.js');
  const { registerChatAuthz } = await import('../chat/authz.js');
  const { declareCiPolicies } = await import('../ci/authz.js');
  const { declareClaudeVersionPolicies } = await import('../claudeversion/authz.js');
  const { declareKeepGoingPolicies } = await import('../keepgoing/authz.js');
  const { declareAutoTransferPolicies } = await import('../autotransfer/authz.js');
  const { declareWorkspacePolicies } = await import('../workspaces/authz.js');
  const { declareLabPolicies } = await import('../lab/authz.js');
  const { declareNotifyPolicies } = await import('../notify/authz.js');
  const { declareTicketPolicies } = await import('../tickets/authz.js');
  const { declareTriggerPolicies } = await import('../triggers/authz.js');
  const { registerAttentionTools } = await import('../attention/portalTools.js');
  declarePortalMcpPolicies();
  registerChatAuthz(() => null);
  declareCiPolicies();
  declareClaudeVersionPolicies();
  declareKeepGoingPolicies();
  declareAutoTransferPolicies();
  declareWorkspacePolicies();
  declareLabPolicies();
  declareNotifyPolicies();
  declareTicketPolicies();
  declareTriggerPolicies();
  registerAttentionTools({} as never, new ToolRegistry());

  const undeclared = [...names].filter((n) => toolPolicyFor(n) === undefined).sort();
  const unlisted = undeclared.filter((n) => !UNDECLARED_TOOLS.has(n));
  assert.deepEqual(unlisted, [], `these tools have no declared policy (FR19): declare them in their module's authz.ts, never add them to undeclaredTools.ts\n${unlisted.join('\n')}`);
  const stale = [...UNDECLARED_TOOLS].filter((n) => !names.has(n) || toolPolicyFor(n) !== undefined).sort();
  assert.deepEqual(stale, [], `these are on the closed list but are declared or gone: remove them from undeclaredTools.ts\n${stale.join('\n')}`);
});
