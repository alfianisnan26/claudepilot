// T-STATIC (PRD §19.3): the plan's golden files, its allowlist reader (the TypeScript reference and install.sh's, under dash and
// bash --posix, on the same inputs), and the shape of node-manifest.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONNECT_KINDS, CONNECT_PLAN_KEYS, type ConnectKind } from '@portal/contracts';
import { INSTALL_SH } from './installers.generated.js';
import { NODE_MANIFEST, PLAN_VALUE, buildPlan, parsePlan, type PlanInput } from './plan.js';
import { BUNDLE_FIXTURE, CONFIG_FIXTURE, enrollment, targetRecord } from './testkit.js';

const golden = (name: string) => new URL(`./testdata/${name}`, import.meta.url);
const update = process.env.UPDATE_GOLDEN === '1';

const input = (kind: ConnectKind, over: Partial<PlanInput> = {}): PlanInput => ({
  enrollment: enrollment({ maxUses: kind === 'swarm' ? 20 : 1 }),
  target: targetRecord(kind, kind === 'kubernetes' ? { settings: { storage: '10Gi' } } : {}),
  options: kind === 'host' ? { hostAccess: true } : {},
  bundle: BUNDLE_FIXTURE,
  config: CONFIG_FIXTURE,
  ...over,
});

for (const kind of CONNECT_KINDS) {
  test(`the ${kind} plan is its golden file`, () => {
    const text = buildPlan(input(kind));
    if (update) writeFileSync(golden(`plan-${kind}.txt`), text);
    assert.equal(text, readFileSync(golden(`plan-${kind}.txt`), 'utf8'), 'UPDATE_GOLDEN=1 to accept a change');
    const parsed = parsePlan(text);
    assert.ok(parsed.ok);
    for (const line of text.trim().split('\n')) {
      const [k] = line.split('=');
      assert.ok((CONNECT_PLAN_KEYS as readonly string[]).includes(k!), `${k} is on the allowlist`);
      assert.match(line.slice(k!.length + 1), PLAN_VALUE);
    }
  });
}

test('a plan carries what each kind needs and nothing it does not', () => {
  const v = (kind: ConnectKind, over?: Partial<PlanInput>) => {
    const p = parsePlan(buildPlan(input(kind, over)));
    assert.ok(p.ok);
    return p.values;
  };
  assert.equal(v('docker').PILOT_IMAGES, CONFIG_FIXTURE.workspaceImage);
  assert.equal(v('docker').PILOT_NODE_VERSION, undefined);
  assert.equal(v('host').PILOT_NODE_VERSION, NODE_MANIFEST.node.version);
  assert.equal(v('host').PILOT_HOST_ACK, '1');
  assert.equal(v('host', { options: {} }).PILOT_HOST_ACK, undefined);
  assert.equal(v('container').PILOT_NAME, 'cx4-lab', 'a single is named after its target');
  assert.equal(v('docker').PILOT_NAME, undefined, 'a cluster node defaults to the host name');
  assert.equal(v('kubernetes').PILOT_NAMESPACE, 'claudepilot-workspaces');
  assert.equal(v('docker', { target: targetRecord('docker', { settings: { workspaceImage: 'reg.example/ws:2' } }) }).PILOT_WORKSPACE_IMAGE, 'reg.example/ws:2');
  assert.equal(v('docker', { target: targetRecord('docker', { portalUrl: 'http://172.18.0.1:3214' }) }).PILOT_ALLOW_HTTP, '1');
  assert.equal(v('docker').PILOT_ALLOW_HTTP, undefined);
  assert.equal(v('docker').PILOT_TUNNEL, 'wss://pilot.example.com/connect/v1/tunnel');
  assert.equal(v('docker').PILOT_AGENT_URL, `https://pilot.example.com/connect/v1/agent/${BUNDLE_FIXTURE.build}/agent.mjs`);
  const ca = v('docker', { options: { privateCa: true }, config: { ...CONFIG_FIXTURE, caPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n' } });
  assert.match(ca.PILOT_CA_SHA256 ?? '', /^[0-9a-f]{64}$/);
  assert.throws(() => buildPlan(input('docker', { config: { ...CONFIG_FIXTURE, workspaceImage: 'bad image; rm -rf /' } })), /refuse/);
});

// The reader's rules, as cases: [plan text, expected values or null for "refused"].
const CASES: [string, string, Record<string, string> | null][] = [
  ['minimal', 'PILOT_PLAN=1\nPILOT_KIND=docker\n', { PILOT_KIND: 'docker' }],
  ['CRLF endings', 'PILOT_PLAN=1\r\nPILOT_KIND=docker\r\n', { PILOT_KIND: 'docker' }],
  ['no final newline', 'PILOT_PLAN=1\nPILOT_TARGET=lab', { PILOT_TARGET: 'lab' }],
  ['empty lines skipped', 'PILOT_PLAN=1\n\nPILOT_KIND=host\n\n', { PILOT_KIND: 'host' }],
  ['unknown keys ignored', 'PILOT_PLAN=1\nPILOT_FUTURE=x\nPILOT_KIND=swarm\n', { PILOT_KIND: 'swarm' }],
  ['first occurrence wins', 'PILOT_PLAN=1\nPILOT_KIND=docker\nPILOT_KIND=host\n', { PILOT_KIND: 'docker' }],
  ['value characters', 'PILOT_PLAN=1\nPILOT_PTY_INTEGRITY=sha512-ab+/cd==\nPILOT_AGENT_URL=https://x:1/a@b,c\n', { PILOT_PTY_INTEGRITY: 'sha512-ab+/cd==', PILOT_AGENT_URL: 'https://x:1/a@b,c' }],
  ['empty value', 'PILOT_PLAN=1\nPILOT_NAME=\n', { PILOT_NAME: '' }],
  ['not a plan (HTML)', '<html>\n', null],
  ['not first', 'PILOT_KIND=docker\nPILOT_PLAN=1\n', null],
  ['command substitution', 'PILOT_PLAN=1\nPILOT_KIND=$(id)\n', null],
  ['backtick', 'PILOT_PLAN=1\nPILOT_KIND=`id`\n', null],
  ['semicolon', 'PILOT_PLAN=1\nPILOT_TARGET=a;rm\n', null],
  ['space', 'PILOT_PLAN=1\nPILOT_TARGET=a b\n', null],
  ['quote', "PILOT_PLAN=1\nPILOT_TARGET=a'b\n", null],
  ['lowercase key', 'PILOT_PLAN=1\npilot_kind=docker\n', null],
  ['no equals', 'PILOT_PLAN=1\nPILOT_KIND\n', null],
  ['key starting with a digit', 'PILOT_PLAN=1\n1X=y\n', null],
];

test('the reference reader follows the rules', () => {
  for (const [name, text, want] of CASES) {
    const got = parsePlan(text);
    if (want === null) assert.equal(got.ok, false, name);
    else {
      assert.ok(got.ok, name);
      for (const [k, v] of Object.entries(want)) assert.equal((got.values as Record<string, string>)[k], v, name);
    }
  }
});

// install.sh's read_plan, run on its own: the script minus its last line (`main "$@"`), then a driver that prints the variables.
test('install.sh reads plans the same way, under dash and bash --posix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx4-plan-'));
  try {
    const lib = INSTALL_SH.replace(/\nmain "\$@"\n$/, '\n');
    assert.notEqual(lib, INSTALL_SH, 'the script ends with main "$@"');
    const vars = ['KIND', 'TARGET', 'NAME', 'PTY_INTEGRITY', 'AGENT_URL'];
    writeFileSync(
      join(dir, 'drive.sh'),
      `${lib}\nif read_plan "$1"; then printf 'ok\\n'; ${vars.map((v) => `printf 'PILOT_${v}=%s\\n' "$P_${v}"`).join('; ')}; else printf 'refused\\n'; fi\n`,
    );
    for (const shell of [['dash'], ['bash', '--posix']]) {
      for (const [name, text, want] of CASES) {
        writeFileSync(join(dir, 'plan'), text);
        const out = execFileSync(shell[0]!, [...shell.slice(1), join(dir, 'drive.sh'), join(dir, 'plan')], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
        const lines = out.trim().split('\n');
        if (want === null) assert.equal(lines[0], 'refused', `${shell[0]}: ${name}`);
        else {
          assert.equal(lines[0], 'ok', `${shell[0]}: ${name}`);
          for (const [k, v] of Object.entries(want)) if (vars.includes(k.slice(6))) assert.ok(lines.includes(`${k}=${v}`), `${shell[0]}: ${name}: ${k}`);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node-manifest.json has the shape the plan needs', () => {
  assert.match(NODE_MANIFEST.node.version, /^22\.\d+\.\d+$/);
  const [, minor] = NODE_MANIFEST.node.version.split('.').map(Number);
  assert.ok(minor! >= 13, 'Node 22.13 or newer');
  for (const p of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const) assert.match(NODE_MANIFEST.node.sha256[p], /^[0-9a-f]{64}$/);
  assert.equal(NODE_MANIFEST.pty.name, '@lydell/node-pty');
  const lock = JSON.parse(readFileSync(new URL('../../../../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string; integrity: string }> };
  assert.equal(NODE_MANIFEST.pty.version, lock.packages['node_modules/@lydell/node-pty']!.version, 'the lockfile’s pty version: npm run gen:connect-node');
  assert.equal(NODE_MANIFEST.pty.integrity.main, lock.packages['node_modules/@lydell/node-pty']!.integrity);
  for (const p of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const) {
    assert.equal(NODE_MANIFEST.pty.integrity[p], lock.packages[`node_modules/@lydell/node-pty-${p}`]!.integrity);
    assert.match(NODE_MANIFEST.pty.integrity[p], /^sha512-[A-Za-z0-9+/]{86}==$/);
  }
});
