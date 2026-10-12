// The wizard's commands (PRD §13.2) and the plan preview: the token only where it must be, the variants, and the preview built from
// the same plan the script reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECT_KINDS } from '@portal/contracts';
import { buildCommands, previewSteps, type CommandsInput } from './commands.js';
import { buildPlan } from './plan.js';
import { BUNDLE_FIXTURE, CONFIG_FIXTURE, enrollment, newToken, targetRecord } from './testkit.js';

const TOKEN = newToken();
const SHA = { sh: '1'.repeat(64), ps1: 'ab'.repeat(32) };
const cmds = (over: Partial<CommandsInput> = {}) =>
  buildCommands({ portalUrl: 'https://pilot.example.com', token: TOKEN, kind: 'docker', platform: 'linux', targetId: 'cx4-lab', sha256: SHA, ...over });

test('linux: the pasted command, verify-first, and token-less upgrade, uninstall and doctor', () => {
  const c = cmds();
  assert.equal(c.install, `curl -fsSL https://pilot.example.com/connect/install.sh | PILOT_URL=https://pilot.example.com PILOT_TOKEN=${TOKEN} sh`);
  assert.equal(
    c.verified,
    `curl -fsSL https://pilot.example.com/connect/install.sh -o pilot-install.sh && echo "${SHA.sh}  pilot-install.sh" | sha256sum -c - && PILOT_URL=https://pilot.example.com PILOT_TOKEN=${TOKEN} sh pilot-install.sh`,
  );
  assert.equal(c.upgrade, 'curl -fsSL https://pilot.example.com/connect/install.sh | PILOT_URL=https://pilot.example.com PILOT_TARGET=cx4-lab sh -s -- upgrade');
  assert.match(c.uninstall, /sh -s -- uninstall$/);
  assert.match(c.doctor, /sh -s -- doctor$/);
  assert.equal(c.scriptUrl, 'https://pilot.example.com/connect/install.sh');
  assert.equal(c.scriptSha256, SHA.sh);
  for (const k of ['upgrade', 'uninstall', 'doctor', 'scriptUrl'] as const) assert.ok(!c[k].includes(TOKEN), `${k} has no token`);
  for (const k of ['install', 'verified'] as const) {
    assert.equal(c[k].split(TOKEN).length, 2, `${k} has the token once`);
    assert.ok(!c[k].includes(`install.sh?`) && !c[k].includes(`/${TOKEN}`), 'never in a URL');
  }
});

test('variants: sudo env, macOS shasum, plain-http lab portal, Kubernetes picks its kind, a private CA', () => {
  assert.match(cmds({ options: { sudo: true } }).install, /\| sudo env PILOT_URL=https:\/\/pilot\.example\.com PILOT_TOKEN=cpen_\S+ sh$/);
  assert.match(cmds({ options: { sudo: true } }).verified, /&& sudo env PILOT_URL=\S+ PILOT_TOKEN=\S+ sh pilot-install\.sh$/);
  assert.doesNotMatch(cmds({ options: { sudo: true }, kind: 'host' }).install, /sudo/, 'never sudo for a host');
  assert.match(cmds({ platform: 'macos' }).verified, /shasum -a 256 -c -/);
  assert.match(cmds({ portalUrl: 'http://172.18.0.1:3214' }).install, /PILOT_URL=http:\/\/172\.18\.0\.1:3214 PILOT_ALLOW_HTTP=1 PILOT_TOKEN=/);
  assert.doesNotMatch(cmds({ portalUrl: 'http://localhost:3000' }).install, /ALLOW_HTTP/, 'loopback needs no flag');
  assert.match(cmds({ kind: 'kubernetes' }).uninstall, /PILOT_TARGET=cx4-lab PILOT_KIND=kubernetes sh -s -- uninstall/);
  const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
  const ca = cmds({ options: { privateCa: true }, caPem: pem });
  assert.ok(ca.install.startsWith(`cat > pilot-ca.pem <<'PILOT_CA_EOF'\n${pem}\nPILOT_CA_EOF\ncurl --cacert pilot-ca.pem -fsSL `));
  assert.match(ca.install, /PILOT_CA="\$PWD\/pilot-ca\.pem"/);
  assert.doesNotMatch(cmds({ options: { privateCa: true }, caPem: null }).install, /pilot-ca/, 'no CA configured: no CA lines');
});

test('windows: PowerShell, the token in $env:, Get-FileHash, token-less script blocks', () => {
  const c = cmds({ platform: 'windows' });
  assert.equal(c.install, `$env:PILOT_URL='https://pilot.example.com'; $env:PILOT_TOKEN='${TOKEN}'; irm https://pilot.example.com/connect/install.ps1 | iex`);
  assert.match(c.verified, /Get-FileHash pilot-install\.ps1 -Algorithm SHA256\)\.Hash -ne 'ABAB/);
  assert.equal(c.upgrade, `$env:PILOT_URL='https://pilot.example.com'; $env:PILOT_TARGET='cx4-lab'; & ([scriptblock]::Create((irm https://pilot.example.com/connect/install.ps1))) upgrade`);
  assert.equal(c.scriptSha256, SHA.ps1);
  assert.ok(!c.uninstall.includes(TOKEN));
});

test('the preview is at most six plain lines per kind, from the plan text, with no secret', () => {
  for (const kind of CONNECT_KINDS) {
    const plan = buildPlan({
      enrollment: enrollment(),
      target: targetRecord(kind),
      options: kind === 'host' ? { hostAccess: true } : {},
      bundle: BUNDLE_FIXTURE,
      config: CONFIG_FIXTURE,
    });
    const steps = previewSteps(plan);
    assert.ok(steps.length > 0 && steps.length <= 6, kind);
    for (const s of steps) assert.ok(s.length < 90 && !/cpen_/.test(s), s);
  }
  assert.deepEqual(previewSteps('<html>'), []);
});
