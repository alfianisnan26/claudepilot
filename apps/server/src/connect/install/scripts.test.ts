// T-STATIC and T-INST for install.sh (PRD §13, §19.3): the generated text matches the scripts, dash and bash --posix parse it,
// forbidden constructs are absent, and the flows run for real under dash against a fake portal (the real install routes) with a private
// HOME and stub `docker`/`kubectl` programs on PATH that record their arguments and stdin. No real cluster is ever contacted (the stub
// kubectl answers a context named cx4-fake; KUBECONFIG points at nothing). shellcheck and the Docker rig runs are opt-in
// (CLAUDEPILOT_DOCKER_TESTS=1, the dev container's DinD).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FETCHER, syncFetcher } from './fetcher.js';
import { INSTALL_PS1, INSTALL_SH } from './installers.generated.js';
import { fakePortal, newToken, sandbox, type FakePortal } from './testkit.js';

const SCRIPTS = new URL('./scripts/', import.meta.url);
const DOCKER = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';

test('the generated installers are the scripts, with the current fetcher', () => {
  const sh = readFileSync(new URL('install.sh', SCRIPTS), 'utf8');
  const ps1 = readFileSync(new URL('install.ps1', SCRIPTS), 'utf8');
  assert.equal(INSTALL_SH, sh, 'npm run gen:connect-installers -w @portal/server');
  assert.equal(INSTALL_PS1, ps1, 'npm run gen:connect-installers -w @portal/server');
  assert.equal(syncFetcher(sh, 'sh'), sh, 'install.sh’s FETCHER line is the fetcher: npm run gen:connect-installers');
  assert.equal(syncFetcher(ps1, 'ps1'), ps1, 'install.ps1’s fetcher line is the fetcher: npm run gen:connect-installers');
  assert.ok(sh.includes(FETCHER));
});

test('dash -n and bash --posix -n parse install.sh', () => {
  const file = new URL('install.sh', SCRIPTS).pathname;
  execFileSync('dash', ['-n', file]);
  execFileSync('bash', ['--posix', '-n', file]);
});

test('forbidden constructs: no eval of input, no sudo, nothing piped to a shell, the token only in quiet places', () => {
  const lines = INSTALL_SH.split('\n');
  const code = lines.filter((l) => !/^\s*#/.test(l));
  for (const l of code) {
    if (/\beval\b/.test(l)) assert.match(l, /eval "_pv=\\\$\{\$_p:-\}"/, `eval only reads a fixed proxy variable name: ${l}`);
    assert.doesNotMatch(l.replace(/(say|printf) .*/, ''), /\bsudo\b/, `never runs sudo: ${l}`);
    assert.doesNotMatch(l.replace(/(say|printf) .*/, ''), /\|\s*(sudo\s+)?(sh|bash)\b/, `never pipes into a shell: ${l}`);
    assert.doesNotMatch(l, /\bsource\b|^\s*\.\s+\S/, `sources nothing: ${l}`);
  }
  // The token variable is expanded only by printf in a quiet (untraced) section, and copied once at the top.
  const uses = code.filter((l) => l.includes('$_tok') || l.includes('${_tok'));
  for (const l of uses) assert.match(l, /^\s*(_tok=\$\{PILOT_TOKEN:-\}|\[ -n "\$_tok" \] && _has_tok=1|.*printf .*"\$_tok")/, `token use: ${l}`);
  assert.ok(/case \$- in \*x\*\) _trace=1; set \+x/.test(INSTALL_SH), 'tracing goes off before the token is read');
  assert.ok(INSTALL_SH.indexOf('set +x') < INSTALL_SH.indexOf('_tok=${PILOT_TOKEN'));
  assert.ok(!INSTALL_SH.includes('\r'), 'LF endings');
  // ASCII only: Windows PowerShell 5.1 reads a saved .ps1 without a BOM as ANSI, and some /bin/sh builds care too.
  assert.doesNotMatch(INSTALL_SH, /[^\x00-\x7f]/);
  assert.doesNotMatch(INSTALL_PS1, /[^\x00-\x7f]/);
});

test('shellcheck -s sh is clean (koalaman/shellcheck, CLAUDEPILOT_DOCKER_TESTS=1)', { skip: !DOCKER }, () => {
  const dir = dirname(new URL('install.sh', SCRIPTS).pathname);
  execFileSync('docker', ['run', '--rm', '--name', 'cx4-shellcheck', '-v', `${dir}:/s:ro`, 'koalaman/shellcheck:stable', '-s', 'sh', '/s/install.sh'], { encoding: 'utf8' });
});

// ---------------------------------------------------------------------------------------------------------------------------------

interface Run {
  code: number | null;
  out: string;
  err: string;
  lines: string[];
}

/** Runs the generated install.sh under dash (or `shell`), detached from any terminal, with a minimal environment. */
function installer(sb: ReturnType<typeof sandbox>, env: Record<string, string>, args: string[] = [], shell: string[] = ['dash']): Promise<Run> {
  const file = join(sb.root, 'install.sh');
  if (!existsSync(file)) writeFileSync(file, INSTALL_SH);
  return new Promise((resolve) => {
    const p = spawn(shell[0]!, [...shell.slice(1), file, ...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${sb.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: sb.home,
        KUBECONFIG: '/nonexistent/cx4-kubeconfig',
        PILOT_POLL_SECONDS: '1',
        PILOT_WAIT_SECONDS: '8',
        ...env,
      },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => process.kill(-p.pid!, 'SIGKILL'), 90_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, lines: out.trim().split('\n') });
    });
  });
}
const result = (r: Run) => r.lines.at(-1);
const records = (sb: ReturnType<typeof sandbox>, name: string): { argv: string[]; stdin: string }[] => {
  const f = join(sb.root, `${name}.log`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/** A docker stub: answers the read-only questions like a Linux amd64 daemon; `extra` is sh case arms run before the defaults. */
const dockerStub = (sb: ReturnType<typeof sandbox>, extra = '') =>
  sb.stub(
    'docker',
    `case "$*" in
${extra}
  "version --format {{.Server.Version}}") echo 29.0.0 ;;
  "version --format {{.Server.Arch}}") echo amd64 ;;
  "version") echo ok ;;
  "info --format {{.OSType}} {{.Architecture}} {{json .SecurityOptions}}") echo 'linux x86_64 ["name=seccomp"]' ;;
  "image inspect "*) exit 0 ;;
  "container inspect "*) exit 1 ;;
  "ps -a "*|"service ls "*) exit 0 ;;
  *) exit 0 ;;
esac
`,
    true,
  );

describe('install.sh flows against a fake portal (stubs, private HOME)', () => {
  let portal: FakePortal;
  before(async () => {
    portal = await fakePortal();
  });
  after(() => portal.close());

  test('checks before anything: a bad address, a plain-http address, a malformed token, an unreachable portal', async () => {
    const sb = sandbox();
    try {
      const tok = newToken();
      let r = await installer(sb, { PILOT_URL: 'https://x.example/path', PILOT_TOKEN: tok });
      assert.equal(r.code, 10);
      assert.equal(result(r), 'PILOT_RESULT=failed');
      r = await installer(sb, { PILOT_URL: 'http://pilot.example.com', PILOT_TOKEN: tok });
      assert.equal(r.code, 10);
      assert.match(r.err, /Use https/);
      const before = portal.calls.length;
      r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: 'cpen_short' });
      assert.equal(r.code, 12);
      assert.equal(portal.calls.length, before, 'a malformed token is never sent');
      r = await installer(sb, { PILOT_URL: 'http://127.0.0.1:1', PILOT_TOKEN: tok });
      assert.equal(r.code, 11);
      assert.match(r.err, /Can't reach/);
    } finally {
      sb.done();
    }
  });

  test('token refusals: unknown, expired, revoked exit 12 with their message and never print the token', async () => {
    const sb = sandbox();
    try {
      const unknown = newToken();
      let r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: unknown });
      assert.equal(r.code, 12);
      assert.match(r.err, /doesn't know this token/);
      for (const [state, msg] of [
        ['expired', /expired/],
        ['revoked', /revoked/],
      ] as const) {
        const t = newToken();
        portal.enrollments.add(t, 'docker', { target: { portalUrl: portal.url }, enrollment: { state } });
        r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: t });
        assert.equal(r.code, 12, state);
        assert.match(r.err, msg);
        assert.ok(!(r.out + r.err).includes(t));
      }
    } finally {
      sb.done();
    }
  });

  test('docker, dry run with PILOT_DEBUG=1 and sh -x: the plan and the commands, no change, no token anywhere', async () => {
    const sb = sandbox();
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'docker', { target: { id: 'cx4-dry', portalUrl: portal.url } });
      dockerStub(sb);
      const from = portal.calls.length;
      const r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: tok, PILOT_DRY_RUN: '1', PILOT_DEBUG: '1', PILOT_HEADERS: 'X-Canary: hdr-canary' }, [], ['dash', '-x']);
      assert.equal(r.code, 0, r.err);
      assert.equal(result(r), 'PILOT_RESULT=dry-run');
      assert.match(r.out, /Target cx4-dry \(docker, cluster, linux\)/);
      assert.match(r.out, /\$ docker run -d --name claudepilot-agent-cx4-dry --restart unless-stopped --read-only --tmpfs \/tmp --cap-drop ALL/);
      assert.match(r.out, /node -e <fetcher>/);
      assert.match(r.out, /\(stdin: the token\)/);
      assert.ok(r.err.includes('+ '), 'traced');
      for (const secret of [tok, 'hdr-canary']) assert.ok(!(r.out + r.err).includes(secret), `${secret.slice(0, 8)} printed`);
      const changing = records(sb, 'docker').filter((c) => /^(run|pull|rm|start|restart|build|volume|service)$/.test(c.argv[0]!));
      assert.deepEqual(changing, [], 'a dry run changes nothing');
      assert.equal(portal.enrollments.rows.get(tok)!.enrollment.state, 'waiting');
      const plans = portal.calls.slice(from).filter((c) => c.path === '/connect/v1/plan');
      assert.equal(plans.length, 1);
      assert.equal(plans[0]!.auth, `Bearer ${tok}`, 'the token went as a header');
    } finally {
      sb.done();
    }
  });

  test('docker: permission denied on the socket says to use sudo env, exits 10, prints no token', async () => {
    const sb = sandbox();
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'docker', { target: { id: 'cx4-perm', portalUrl: portal.url } });
      dockerStub(sb, `  "version --format {{.Server.Version}}") echo 'permission denied while trying to connect to the Docker daemon socket' >&2; exit 1 ;;`);
      const r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: tok });
      assert.equal(r.code, 10);
      assert.match(r.out, /\| sudo env PILOT_URL=\S+ PILOT_TOKEN=<the token> sh/);
      assert.ok(!(r.out + r.err).includes(tok));
    } finally {
      sb.done();
    }
  });

  test('docker: helper containers, the token on stdin of the enroll run only, the hardened agent container, then connected', async () => {
    const sb = sandbox();
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'docker', { target: { id: 'cx4-stub', portalUrl: portal.url } });
      portal.enrollments.setStatus(tok, 'connected');
      dockerStub(sb);
      const r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: tok });
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(result(r), 'PILOT_RESULT=connected');
      const calls = records(sb, 'docker');
      for (const c of calls) assert.ok(!c.argv.join(' ').includes(tok), 'never an argument');
      const withToken = calls.filter((c) => c.stdin.includes(tok));
      assert.equal(withToken.length, 1);
      assert.deepEqual(withToken[0]!.argv.slice(-3), ['/var/lib/claudepilot-agent/current.mjs', 'enroll', '--token-stdin']);
      const fetch = calls.find((c) => c.argv.includes(FETCHER))!;
      assert.ok(fetch.argv.includes('claudepilot-agent-cx4-stub:/var/lib/claudepilot-agent'));
      assert.ok(fetch.argv.includes(`${portal.url}/connect/v1/agent/${fetch.argv.at(-1)!.split('/').at(-2)}/agent.mjs`), 'the plan’s bundle address');
      const agentJson = calls.find((c) => c.stdin.includes('"mode": "docker"'))!;
      const cfg = JSON.parse(agentJson.stdin) as Record<string, unknown>;
      assert.equal(cfg.url, portal.url);
      assert.equal(cfg.allowHttp, true);
      assert.deepEqual(cfg.images, ['claudepilot-workspace:latest']);
      const run = calls.find((c) => c.argv[0] === 'run' && c.argv.includes('-d'))!.argv.join(' ');
      for (const flag of ['--restart unless-stopped', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--memory 256m', '--pids-limit 256', '-v /var/run/docker.sock:/var/run/docker.sock', '--label claudepilot.connect=agent']) {
        assert.ok(run.includes(flag), flag);
      }
      assert.doesNotMatch(run, /claudepilot\.managed/);
    } finally {
      sb.done();
    }
  });

  test('swarm: one global service, the token through an env file (not an argument), removed afterwards', async () => {
    const sb = sandbox();
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'swarm', { target: { id: 'cx4-swarm', portalUrl: portal.url }, enrollment: { maxUses: 20 } });
      portal.enrollments.setStatus(tok, 'connected');
      dockerStub(
        sb,
        `  "info --format {{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}") echo 'active true' ;;
  "service inspect "*) exit 1 ;;
  "service create "*) for a; do case $prev in --env-file) cat "$a" >> ${JSON.stringify(join(sb.root, 'envfile'))} ;; esac; prev=$a; done ;;`,
      );
      const r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: tok, PILOT_SWARM_SETTLE_SECONDS: '0' });
      assert.equal(r.code, 0, r.err + r.out);
      const calls = records(sb, 'docker');
      const create = calls.find((c) => c.argv[0] === 'service' && c.argv[1] === 'create')!.argv;
      assert.ok(!create.join(' ').includes(tok));
      for (const want of ['--mode', 'global', 'PILOT_NODE_NAME={{.Node.Hostname}}', 'claudepilot.connect=agent', 'PILOT_MODE=swarm']) assert.ok(create.includes(want), want);
      assert.match(readFileSync(join(sb.root, 'envfile'), 'utf8'), new RegExp(`^PILOT_ENROLL_TOKEN=${tok}$`, 'm'));
      const update = calls.find((c) => c.argv[0] === 'service' && c.argv[1] === 'update')!.argv;
      assert.deepEqual(update, ['service', 'update', '--detach', '--env-rm', 'PILOT_ENROLL_TOKEN', 'claudepilot-agent-cx4-swarm']);
    } finally {
      sb.done();
    }
  });

  test('kubernetes: the context is shown, refused without a terminal, then applied through stdin with --context on every call', async () => {
    const sb = sandbox();
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'kubernetes', { target: { id: 'cx4-kube', portalUrl: portal.url } });
      portal.enrollments.setStatus(tok, 'connected');
      sb.stub(
        'kubectl',
        `case "$*" in
  "config current-context") echo cx4-fake ;;
  "config view "*) echo https://cx4-fake.invalid:6443 ;;
  *"get namespace"*) exit 1 ;;
  *"auth can-i"*) echo yes ;;
  *) exit 0 ;;
esac
`,
        true,
      );
      let r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: tok });
      assert.equal(r.code, 20, 'no terminal, no PILOT_YES: declined');
      assert.match(r.out, /kubectl context: cx4-fake/);
      assert.match(r.out, /API server:      https:\/\/cx4-fake\.invalid:6443/);
      assert.ok(!records(sb, 'kubectl').some((c) => c.argv.includes('apply')), 'nothing applied before the answer');
      r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: tok, PILOT_YES: '1' });
      assert.equal(r.code, 0, r.err + r.out);
      const calls = records(sb, 'kubectl');
      const cluster = calls.filter((c) => c.argv[0] !== 'config');
      for (const c of cluster) assert.deepEqual(c.argv.slice(0, 2), ['--context', 'cx4-fake'], c.argv.join(' '));
      for (const c of calls) assert.ok(!c.argv.join(' ').includes(tok));
      const apply = calls.find((c) => c.argv.includes('apply'))!;
      assert.match(apply.stdin, /^kind: Namespace$/m, 'a missing namespace is created by the manifest');
      assert.match(apply.stdin, new RegExp(`token: "${tok}"`));
      assert.ok(calls.some((c) => c.argv.join(' ').includes('rollout status deployment/claudepilot-agent --timeout=120s')));
      assert.ok(calls.some((c) => c.argv.join(' ') === '--context cx4-fake auth can-i create namespaces'));
      assert.ok(!(r.out + r.err).includes(tok));
    } finally {
      sb.done();
    }
  });

  test('kubernetes: a namespace that runs another target’s agent is refused with what to do, before anything is applied (T6)', async () => {
    // Seen on k3s: a target removed with its workspaces kept, a new target in the same namespace: `kubectl apply` failed on the
    // Deployment's immutable selector after the Secret had already been replaced.
    const sb = sandbox();
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'kubernetes', { target: { id: 'cx4-kube2', portalUrl: portal.url } });
      sb.stub(
        'kubectl',
        `case "$*" in
  "config current-context") echo cx4-fake ;;
  "config view "*) echo https://cx4-fake.invalid:6443 ;;
  *"get namespace"*) exit 0 ;;
  *"get deployment claudepilot-agent"*) printf cx4-kube ;;
  *"auth can-i"*) echo yes ;;
  *) exit 0 ;;
esac
`,
        true,
      );
      const r = await installer(sb, { PILOT_URL: portal.url, PILOT_TOKEN: tok, PILOT_YES: '1' });
      assert.equal(r.code, 14, r.out + r.err);
      assert.match(r.out + r.err, /already runs the agent of target cx4-kube\. Uninstall it first/);
      assert.ok(!records(sb, 'kubectl').some((c) => c.argv.includes('apply')), 'nothing applied');
    } finally {
      sb.done();
    }
  });

  test('host: Node from the machine, the bundle and the pty package checked, enrolled, kept running (nohup); a re-run and uninstall', async () => {
    const sb = sandbox();
    const dataDir = join(sb.home, '.claudepilot', 'agent');
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'host', { target: { id: 'cx4-metal', portalUrl: portal.url }, options: { hostAccess: true } });
      sb.stub('docker', 'exit 1\n');
      mkdirSync(join(sb.home, 'work'));
      writeFileSync(join(sb.home, 'work', 'keep.txt'), 'user data');
      const env = { PILOT_URL: portal.url, PILOT_TOKEN: tok, PILOT_SERVICE: 'nohup', npm_config_registry: `${portal.url}/npm` };
      let r = await installer(sb, env);
      assert.equal(r.code, 20, 'the consent is asked on the host; no terminal: declined');
      assert.match(r.out, /a shell as \S+ on this machine/);
      r = await installer(sb, { ...env, PILOT_YES: '1' });
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(result(r), 'PILOT_RESULT=connected');
      assert.ok(existsSync(join(dataDir, 'identity.json')));
      assert.ok(existsSync(join(dataDir, 'node_modules/@lydell/node-pty/package.json')));
      assert.ok(existsSync(join(dataDir, 'node_modules/@lydell/node-pty-linux-x64/package.json')) || existsSync(join(dataDir, 'node_modules/@lydell/node-pty-linux-arm64/package.json')));
      const cfg = JSON.parse(readFileSync(join(dataDir, 'agent.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(cfg.mode, 'host');
      assert.equal(cfg.home, sb.home);
      assert.equal(portal.runs.at(-1)?.target, 'cx4-metal', 'the agent started and called home');
      for (const f of ['agent.json', 'start.sh']) assert.ok(!readFileSync(join(dataDir, f), 'utf8').includes(tok));
      // T6: the agent started in the background held the installer's fd 3 (its stdout), so `install.sh | tee log` never ended.
      assert.match(readFileSync(join(dataDir, 'start.sh'), 'utf8'), /<\/dev\/null 3>&- &$/m, 'the background agent closes fd 3');

      r = await installer(sb, { ...env, PILOT_YES: '1' });
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(r.out, /used already; cx4-metal is installed here/);
      assert.equal(result(r), 'PILOT_RESULT=connected');

      r = await installer(sb, { PILOT_YES: '1', PILOT_TARGET: 'cx4-metal' }, ['uninstall']);
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(result(r), 'PILOT_RESULT=removed');
      assert.ok(!existsSync(dataDir));
      assert.equal(readFileSync(join(sb.home, 'work', 'keep.txt'), 'utf8'), 'user data', 'nothing else touched');
    } finally {
      try {
        const pid = Number(readFileSync(join(dataDir, 'agent.pid'), 'utf8'));
        if (pid) process.kill(pid);
      } catch {
        /* gone */
      }
      sb.done();
    }
  });

  test('host: a bundle whose sha256 does not match the plan exits 13 and installs nothing that runs', async () => {
    const bad = await fakePortal({ badSha: true });
    const sb = sandbox();
    try {
      const tok = newToken();
      bad.enrollments.add(tok, 'host', { target: { id: 'cx4-bad', portalUrl: bad.url }, options: { hostAccess: true } });
      sb.stub('docker', 'exit 1\n');
      const r = await installer(sb, { PILOT_URL: bad.url, PILOT_TOKEN: tok, PILOT_YES: '1', PILOT_SERVICE: 'none' });
      assert.equal(r.code, 13, r.err);
      assert.match(r.err, /checksum mismatch/);
      assert.ok(!existsSync(join(sb.home, '.claudepilot/agent/versions')) || !execFileSync('find', [join(sb.home, '.claudepilot/agent/versions'), '-name', 'agent.mjs'], { encoding: 'utf8' }).trim());
    } finally {
      sb.done();
      await bad.close();
    }
  });
});

// T-INST on real Docker (the dev container's DinD; this container is the rig host): the fake agent bundle runs in the real node and
// workspace images and calls the fake portal at the bridge gateway, the way an agent dials out.
describe('install.sh on real Docker (CLAUDEPILOT_DOCKER_TESTS=1)', { skip: !DOCKER }, () => {
  let portal: FakePortal;
  const gateway = DOCKER ? execFileSync('docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' }).trim() : '';
  const docker = (...a: string[]) => {
    try {
      return execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const inspect = (name: string) => JSON.parse(docker('container', 'inspect', name) || '[]')[0] as Record<string, any> | undefined;
  before(async () => {
    portal = await fakePortal({ host: '0.0.0.0', publicHost: gateway });
  });
  after(async () => {
    docker('rm', '-f', 'claudepilot-agent-cx4-dock', 'claudepilot-cx4-box');
    docker('volume', 'rm', 'claudepilot-agent-cx4-dock', 'claudepilot-cx4-box-home', 'claudepilot-cx4-box-agent', 'claudepilot-cx4-box-state');
    await portal.close();
  });

  test('docker kind: connected, a re-run still connected, upgrade, uninstall keeps the volume', async () => {
    const sb = sandbox();
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'docker', { target: { id: 'cx4-dock', portalUrl: portal.url } });
      const env = { PILOT_URL: portal.url, PILOT_ALLOW_HTTP: '1', PILOT_WAIT_SECONDS: '60' };
      let r = await installer(sb, { ...env, PILOT_TOKEN: tok });
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(result(r), 'PILOT_RESULT=connected');
      const c = inspect('claudepilot-agent-cx4-dock')!;
      assert.equal(c.State.Running, true);
      assert.equal(c.Config.Labels['claudepilot.connect'], 'agent');
      assert.equal(c.Config.Labels['claudepilot.managed'], undefined);
      assert.equal(c.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
      assert.equal(c.HostConfig.RestartPolicy.Name, 'unless-stopped');
      assert.ok(c.HostConfig.Binds.includes('/var/run/docker.sock:/var/run/docker.sock'));
      assert.ok(!JSON.stringify(c).includes(tok), 'no token in docker inspect');

      r = await installer(sb, { ...env, PILOT_TOKEN: tok });
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(r.out, /used already; cx4-dock is installed here/);

      r = await installer(sb, { ...env, PILOT_TARGET: 'cx4-dock' }, ['upgrade']);
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(r.out, /Already at/);
      assert.equal(result(r), 'PILOT_RESULT=installed');

      r = await installer(sb, { PILOT_TARGET: 'cx4-dock', PILOT_YES: '1' }, ['uninstall']);
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(inspect('claudepilot-agent-cx4-dock'), undefined);
      assert.equal(docker('volume', 'inspect', '-f', '{{.Name}}', 'claudepilot-agent-cx4-dock'), 'claudepilot-agent-cx4-dock', 'the volume stays without --purge');
    } finally {
      sb.done();
    }
  });

  test('container kind: the workspace image runs the agent, no Docker socket, no token; uninstall --purge removes it all', async () => {
    const sb = sandbox();
    try {
      const tok = newToken();
      portal.enrollments.add(tok, 'container', { target: { id: 'cx4-box', portalUrl: portal.url } });
      const r = await installer(sb, { PILOT_URL: portal.url, PILOT_ALLOW_HTTP: '1', PILOT_TOKEN: tok, PILOT_WAIT_SECONDS: '60', npm_config_registry: `${portal.url}/npm` });
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(result(r), 'PILOT_RESULT=connected');
      const c = inspect('claudepilot-cx4-box')!;
      assert.equal(c.Config.Image, 'claudepilot-workspace:latest');
      assert.equal(c.Config.Labels['claudepilot.connect'], 'single');
      assert.ok(!JSON.stringify(c.Mounts).includes('docker.sock'), 'no Docker socket');
      assert.ok(!JSON.stringify(c).includes(tok), 'no token in docker inspect');
      assert.equal(docker('exec', 'claudepilot-cx4-box', 'test', '-f', '/opt/claudepilot-agent/node_modules/@lydell/node-pty/package.json') === '', true);
      const u = await installer(sb, { PILOT_TARGET: 'cx4-box', PILOT_YES: '1' }, ['uninstall', '--purge']);
      assert.equal(u.code, 0, u.err + u.out);
      assert.equal(inspect('claudepilot-cx4-box'), undefined);
      for (const v of ['home', 'agent', 'state']) assert.equal(docker('volume', 'inspect', `claudepilot-cx4-box-${v}`), '');
    } finally {
      sb.done();
    }
  });
});
