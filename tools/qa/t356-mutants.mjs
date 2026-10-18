// T-356 mutant proof. Run from the repo root inside a Job: each mutant breaks one rule, runs the tests that guard it and must FAIL (KILLED); the
// file is restored after each. Exit 1 when one survives or a replacement did not apply.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CI = 'apps/server/src/ci/portalTools.ts';
const WS = 'apps/server/src/workspaces/authz.ts';
const REG = 'apps/server/src/portalmcp/registry.ts';
const UND = 'apps/server/src/portalmcp/undeclaredTools.ts';
const ALL = 'apps/server/src/portalmcp/declareAll.ts';
const COMMON = 'apps/server/src/portalmcp/tools/common.ts';
const STARTTEST = 'src/chat/sessionStartParent.test.ts';
const CITEST ='src/ci/portalToolsAuthz.test.ts';
const WSTEST = 'src/workspaces/toolAuthz.test.ts';
const REGTEST = 'src/portalmcp/toolDeclared.test.ts';
const mutants = [
  ['N1 ci_runs_list unfiltered for a person', CI, "keep: (r) => visible(actor, 'ci_run', [r], (x) => x.id).length > 0", 'keep: () => true', CITEST],
  ['N2 ci_run_trigger: no repo check for a person', CI, "if (!repo || !can(actorOfPrincipal(ctx.principal), 'operate', objectRef('ci_repo', repo.id)).allow) throw", 'if (!repo) throw', CITEST],
  ['N3 resolver: bare name not resolved', WS, 'return named.length === 1 ? named[0]! : null;', 'return null;', WSTEST],
  ['N4 resolver: ambiguous name decided on one', WS, 'return named.length === 1 ? named[0]! : null;', 'return named[0] ?? null;', WSTEST],
  ['N5 resolver: no trim', WS, "typeof ref === 'string' ? ref.trim() : ''", "typeof ref === 'string' ? ref : ''", WSTEST],
  ['N6 rename: refusal text differs from a missing one', WS, "workspace_rename: { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'id', notFound: NO_WORKSPACE }] }", "workspace_rename: { kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'id' }] }", WSTEST],
  ['N7 registry accepts an undeclared tool', REG, 'if (this.#requireDeclared && !this.#requireDeclared.isDeclared', 'if (false && this.#requireDeclared && !this.#requireDeclared.isDeclared', REGTEST],
  // QA #11120's N7 (a different one from the registry mutant above): the `/` guard. A reference with a slash that does not resolve is tried as a bare name.
  ['N8 resolver: slash reference tried as a bare name (QA N7)', WS, "if (wanted.includes('/')) return null;", '', WSTEST],
  // The blind review #11576 (P4, P5, FR19 in production).
  ['N9 production registry does not require a declaration', REG, 'new ToolRegistry({ requireDeclared: { isDeclared: (name) => toolPolicyFor(name) !== undefined, exempt: UNDECLARED_TOOLS } })', 'new ToolRegistry()', REGTEST],
  ['N10 ratchet: a listed tool that is declared is not stale', UND, 'stale: [...listed].filter((n) => !names.has(n) || isDeclared(n)).sort()', 'stale: [...listed].filter((n) => !names.has(n)).sort()', REGTEST],
  ['N11 ratchet: a gone tool is not stale', UND, 'stale: [...listed].filter((n) => !names.has(n) || isDeclared(n)).sort()', 'stale: [...listed].filter((n) => isDeclared(n)).sort()', REGTEST],
  ['N12 declareAllToolPolicies leaves the trigger tools out', ALL, '  declareTriggerPolicies();\n}', '}', REGTEST],
  ['N13 workspace not found echoes the name asked (P4)', COMMON, "throw new AppError('NOT_FOUND', NO_WORKSPACE);\n}", 'throw new AppError(\'NOT_FOUND\', `No workspace “${wanted}”.`);\n}', STARTTEST],
];
const run = (test) => {
  try {
    execFileSync('node', ['--import', 'tsx', '--test', test], { cwd: 'apps/server', stdio: 'pipe', timeout: 240_000 });
    return true;
  } catch {
    return false;
  }
};
let bad = 0;
for (const [name, file, from, to, test] of mutants) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(from)) {
    console.log(`T356-MUTANT ${name}: NOT APPLIED`);
    bad++;
    continue;
  }
  const mutated = src.replace(from, to);
  if (mutated === src) {
    console.log(`T356-MUTANT ${name}: EMPTY DIFF`);
    bad++;
    continue;
  }
  writeFileSync(file, mutated);
  const passed = run(test);
  writeFileSync(file, src);
  console.log(`T356-MUTANT ${name}: applied (${from.length} -> ${to.length} chars) ${passed ? 'SURVIVED' : 'KILLED'}`);
  if (passed) bad++;
}
console.log(`T356-MUTANTS ${mutants.length - bad}/${mutants.length} killed`);
process.exit(bad ? 1 : 0);
