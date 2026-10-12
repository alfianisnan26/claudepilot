/**
 * The stand-in provider as a program, for a workspace container or a shell (providers PRD §6). `build.ts` bundles this file into
 * one script with no dependencies:
 *
 *   node standin.cjs --preset gitea --port 4601 --auth-port 4602 --control
 *
 * It prints one JSON line when it listens (`{"ready":true,"url":…,"issuer":…}`) and runs until it gets SIGTERM or SIGINT. With
 * `--control` the stand-in can be steered from another process: `GET /__standin/state`, `POST /__standin/advance {"ms":3600000}`,
 * `POST /__standin/authorize {"mode":"deny"}`, `POST /__standin/quirk {"name":"badTokenOk","value":true}`, `POST /__standin/revoke-all`.
 *
 * Options: --preset <name> (gitea, gitea-bare, gitlab, cloudflare, outline, github)  --host  --public-host  --port  --auth-port
 *   --static-token <token>=<subject> (repeat)  --client <id>=<redirect>[,<redirect>…] (repeat, replaces the preset's clients)
 *   --client-secret <id>=<secret> (repeat: makes that client confidential)  --user <name>
 *   --access-ttl <seconds>  --refresh-ttl <seconds>  --no-rotate  --bad-token-ok  --sse  --no-oauth  --authorize deny
 *   --tls-cert <file> --tls-key <file> | --self-signed (needs openssl)  --control
 */
import { readFileSync } from 'node:fs';
import { selfSignedCertificate } from './cert.js';
import { PROVIDER_PRESETS, type ProviderPreset } from './presets.js';
import { startProvider } from './provider.js';
import type { ProviderOverrides } from './types.js';

function fail(message: string): never {
  process.stderr.write(`standin: ${message}\n`);
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) fail(`unexpected argument ${a}`);
    const name = a.slice(2);
    const next = argv[i + 1];
    const takes = !['control', 'no-rotate', 'bad-token-ok', 'sse', 'no-oauth', 'self-signed'].includes(name);
    const value = takes ? (next === undefined ? fail(`--${name} needs a value`) : (i++, next)) : 'true';
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  const one = (name: string) => flags.get(name)?.at(-1);
  const num = (name: string) => {
    const v = one(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : fail(`--${name} is a number`);
  };

  const presetName = one('preset');
  if (presetName && !(PROVIDER_PRESETS as readonly string[]).includes(presetName)) fail(`--preset is one of ${PROVIDER_PRESETS.join(', ')}`);
  const preset = (presetName ?? null) as ProviderPreset | null;

  const over: ProviderOverrides = { control: flags.has('control') };
  const host = one('host');
  if (host) over.host = host;
  const publicHost = one('public-host');
  if (publicHost) over.publicHost = publicHost;
  const port = num('port');
  if (port !== undefined) over.port = port;
  const authPort = num('auth-port');
  if (authPort !== undefined) over.authPort = authPort;
  const user = one('user');
  if (user) over.user = user;
  if (flags.has('static-token')) {
    over.staticTokens = {};
    for (const t of flags.get('static-token')!) {
      const [token, ...subject] = t.split('=');
      over.staticTokens[token!] = subject.join('=') || 'standin-pat-user';
    }
  }
  if (flags.has('no-oauth')) over.oauth = false;
  else {
    const oauth: Record<string, unknown> = {};
    const access = num('access-ttl');
    if (access !== undefined) oauth.accessTtlSec = access;
    const refresh = num('refresh-ttl');
    if (refresh !== undefined) oauth.refreshTtlSec = refresh;
    if (flags.has('no-rotate')) oauth.rotateRefresh = false;
    if (one('authorize') === 'deny') oauth.authorize = 'deny';
    if (flags.has('client')) {
      const secrets = new Map((flags.get('client-secret') ?? []).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)] as const));
      oauth.clients = flags.get('client')!.map((c) => {
        const id = c.slice(0, c.indexOf('='));
        const secret = secrets.get(id);
        return { id, redirectUris: c.slice(id.length + 1).split(',').filter(Boolean), ...(secret ? { secret } : {}) };
      });
    }
    if (Object.keys(oauth).length) over.oauth = oauth;
  }
  if (flags.has('bad-token-ok') || flags.has('sse')) over.quirks = { ...(flags.has('bad-token-ok') ? { badTokenOk: true } : {}), ...(flags.has('sse') ? { sse: true } : {}) };
  if (flags.has('self-signed')) over.tls = selfSignedCertificate();
  else if (one('tls-cert') || one('tls-key')) {
    const cert = one('tls-cert');
    const key = one('tls-key');
    if (!cert || !key) fail('--tls-cert and --tls-key go together');
    over.tls = { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
  }

  const provider = await startProvider(preset, over);
  const tls = provider.options.tls;
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      url: provider.url,
      origin: provider.origin,
      authOrigin: provider.authOrigin,
      issuer: provider.issuer,
      resourceMetadataUrl: provider.resourceMetadataUrl,
      staticTokens: Object.keys(provider.options.staticTokens),
      clients: provider.clients().map((c) => ({ id: c.id, redirectUris: c.redirectUris, confidential: c.confidential })),
      control: provider.options.control,
      ...(tls ? { cert: tls.cert } : {}),
    })}\n`,
  );
  const stop = () => void provider.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main(process.argv.slice(2)).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
