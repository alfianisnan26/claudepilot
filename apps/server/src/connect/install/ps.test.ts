// T-PS (PRD §19.3): install.ps1 in the PowerShell container (mcr.microsoft.com/powershell, opt-in with CLAUDEPILOT_DOCKER_TESTS=1):
// it parses, its plan reader follows the same rules as the reference, and the Docker flow dry-runs against the fake portal with a stub
// `docker` (a sh script on PATH that records its arguments), printing the commands and never the token. The Windows-only branches
// (Docker Desktop, Windows PowerShell 5.1's argument quoting, Get-FileHash on Windows) are the owner's checklist D2.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { INSTALL_PS1 } from './installers.generated.js';
import { parsePlan } from './plan.js';
import { fakePortal, newToken, type FakePortal } from './testkit.js';

const DOCKER = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
// The multi-arch `latest` resolves to arm v7 on an arm64 daemon (it crashed under qemu here): pick the native tag.
const IMAGE = arch() === 'arm64' ? 'mcr.microsoft.com/powershell:7.5-azurelinux-3.0-arm64' : 'mcr.microsoft.com/powershell:latest';

describe('install.ps1 in PowerShell (CLAUDEPILOT_DOCKER_TESTS=1)', { skip: !DOCKER }, () => {
  let portal: FakePortal;
  let dir = '';
  let gateway = '';
  const pwsh = (script: string, env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      writeFileSync(join(dir, 'run.ps1'), script);
      const e = Object.entries({ PATH: '/w/bin:/opt/microsoft/powershell/7:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      execFile('docker', ['run', '--rm', '--name', `cx4-pwsh-${process.pid}`, '-v', `${dir}:/w`, ...e, IMAGE, 'pwsh', '-NoProfile', '-NonInteractive', '-File', '/w/run.ps1'], { encoding: 'utf8' }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
      );
    });
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cx4-ps-'));
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, 'install.ps1'), INSTALL_PS1);
    mkdirSync(join(dir, 'bin'));
    writeFileSync(
      join(dir, 'bin', 'docker'),
      `#!/bin/sh\necho "$*" >> /w/docker.log\ncase "$*" in\n  "version --format {{.Server.Version}}") echo 29.0.0 ;;\n  "version --format {{.Server.Arch}}") echo amd64 ;;\n  "info --format {{.OSType}}") echo linux ;;\n  "image inspect "*) echo sha256:x ;;\n  "container inspect "*) exit 1 ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    const { execFileSync } = await import('node:child_process');
    gateway = execFileSync('docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' }).trim();
    portal = await fakePortal({ host: '0.0.0.0', publicHost: gateway });
  });
  after(async () => {
    await portal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('it parses with no errors', async () => {
    const r = await pwsh(`$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('/w/install.ps1', [ref]$null, [ref]$e); "errors=$($e.Count)"; $e | % { $_.Message }`);
    assert.match(r.out, /errors=0/, r.out);
  });

  test('Read-Plan follows the reference reader on the same cases', async () => {
    const cases = [
      'PILOT_PLAN=1\nPILOT_KIND=docker\n',
      'PILOT_PLAN=1\r\nPILOT_KIND=docker\r\n',
      'PILOT_PLAN=1\nPILOT_FUTURE=x\nPILOT_KIND=swarm\n',
      'PILOT_PLAN=1\nPILOT_KIND=docker\nPILOT_KIND=host\n',
      'PILOT_PLAN=1\nPILOT_KIND=$(id)\n',
      'PILOT_PLAN=1\nPILOT_TARGET=a b\n',
      'PILOT_KIND=docker\nPILOT_PLAN=1\n',
      'PILOT_PLAN=1\npilot_kind=docker\n',
      '<html>\n',
    ];
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
    // The script without its last block (the part that runs), then the reader on each case.
    const lib = INSTALL_PS1.slice(0, INSTALL_PS1.indexOf('$pilotCode = 0'));
    writeFileSync(join(dir, 'lib.ps1'), lib);
    const r = await pwsh(
      `. /w/lib.ps1\n$cases = Get-Content -Raw /w/cases.json | ConvertFrom-Json\nforeach ($c in $cases) { $p = Read-Plan $c; if ($null -eq $p) { 'refused' } else { 'kind=' + $p['PILOT_KIND'] } }`,
    );
    const got = r.out.trim().split('\n').map((l) => l.trim());
    const want = cases.map((c) => {
      const p = parsePlan(c);
      return p.ok ? `kind=${p.values.PILOT_KIND ?? ''}` : 'refused';
    });
    assert.deepEqual(got, want, r.out);
  });

  test('the Docker flow dry-runs: plan, commands, the token on stdin only, never printed; PILOT_RESULT=dry-run', async () => {
    const tok = newToken();
    portal.enrollments.add(tok, 'docker', { target: { id: 'cx4-psdock', portalUrl: portal.url }, platform: 'windows' });
    const r = await pwsh(`$env:PILOT_URL='${portal.url}'; $env:PILOT_TOKEN='${tok}'; $env:PILOT_ALLOW_HTTP='1'; $env:PILOT_DRY_RUN='1'; irm ${portal.url}/connect/install.ps1 | iex; "code=$LASTEXITCODE"`);
    assert.match(r.out, /Target cx4-psdock \(docker, cluster\)/, r.out);
    assert.match(r.out, /\$ docker run -d --name claudepilot-agent-cx4-psdock --restart unless-stopped --read-only/);
    assert.match(r.out, /node -e 'eval\(process\.env\.PILOT_FETCHER\)'/);
    assert.match(r.out, /\(stdin: the token\)/);
    assert.match(r.out, /PILOT_RESULT=dry-run\s+code=0/);
    assert.ok(!r.out.includes(tok), 'the token is never printed');
    const log = readFileSync(join(dir, 'docker.log'), 'utf8');
    assert.ok(!log.includes(tok));
    assert.doesNotMatch(log, /^(run|pull|rm|start|restart|build)\b/m, 'a dry run changes nothing');
  });

  test('a wrong token is refused with 12 and the session is not closed (no exit under iex)', async () => {
    const r = await pwsh(`$env:PILOT_URL='${portal.url}'; $env:PILOT_TOKEN='${newToken()}'; $env:PILOT_ALLOW_HTTP='1'; irm ${portal.url}/connect/install.ps1 | iex; "still here code=$LASTEXITCODE"`);
    assert.match(r.out, /doesn't know this token/);
    assert.match(r.out, /PILOT_RESULT=failed\s+still here code=12/, r.out);
  });
});
