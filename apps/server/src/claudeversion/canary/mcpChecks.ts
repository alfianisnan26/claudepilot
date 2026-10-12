// The canary's MCP checks (docs/prd/claude-version-pinning.md §11): what the portal writes into a plugin's `.mcp.json` and how Claude Code treats it,
// the guided sign-in (`claude mcp login --no-browser`) and the layout of `claude plugin details`. They run the portal's OWN code against the real CLI:
// `compileMcp` (the `.mcp.json` it writes: an oauth block with a scopes STRING, a headers helper), the delivery engine's `compile` and `writeBundle`
// (the files, the marketplace and the managed drop-ins), the sign-in module `SignIns` driving `claude mcp login` in a terminal, and the parsers of
// `claude mcp get` and `claude plugin details`. The provider on the other end is the MCP stand-in kit (src/mcp/builtin/testkit, bundled as
// kit.generated.ts), two instances in the container: an OAuth server with a pre-registered public client, and a bearer-token server.

import { secretFileRef, type McpSetContent, type McpVersionSpec } from '@portal/contracts';
import { CLAUDE_CANARY_CHECKS } from '@portal/contracts';
import { compile as compileDelivery } from '../../delivery/compile.js';
import { writeBundle } from '../../delivery/writer.js';
import type { CatalogVersion } from '../../mcp/catalog.js';
import { compileMcp } from '../../mcp/compile.js';
import { parseDetails, splitVerify, verifyScript } from '../../mcp/jobs.js';
import { initState, parseMcpGet } from '../../mcp/oauth/parse.js';
import { SignIns, type OAuthHost } from '../../mcp/oauth/signin.js';
import { VERIFY_TESTED_CLAUDE } from '../../mcp/spec.js';
import { BOX_DIR, expect, type CanaryBox } from './box.js';
import { MCP_STANDIN } from './kit.generated.js';
import { CHAT_FLAGS, isObj, pass, shq, tailOf, turn, type CanaryCheck, type CheckContext } from './support.js';

const PLUGIN = 'cpm-canary';
/** The providers are on the loopback: the CLI reaches them directly, not through the stand-in API's proxy. */
const LOCAL = { NO_PROXY: 'localhost,127.0.0.1' };
const OAUTH_SCOPES = ['write:repository', 'write:issue'];
const STATIC_TOKEN = 'canary-static-token';
const ROOT_UID = 0;
const NODE_GID = 1000;

interface McpFixture {
  /** The plugin's version as the portal compiled it (`1.0.0+<hash8>`). */
  pluginVersion: string;
  hash12: string;
  /** `mcp_servers` of a session's init line after the plugin was registered. */
  init: { name: string; status: string }[];
  /** The delivered `.mcp.json`. */
  mcpJson: { mcpServers: Record<string, Record<string, unknown>> };
  outcomes: { key: string; state: string; reason: string | null }[];
}

const version = (id: string, spec: McpVersionSpec, slots: unknown[] = []): CatalogVersion =>
  ({ entry: { id: `e-${id}`, display_name: `Canary ${id}`, kind: 'remote' }, row: { id, version: 'v1', review_state: 'approved', revoked_at: null }, spec, slots, target: null }) as unknown as CatalogVersion;

/** Starts one provider instance (preset gitea: a public client, no dynamic registration) and resolves with what it printed when ready. */
async function startKit(box: CanaryBox, name: string, port: number, authPort: number): Promise<Record<string, unknown>> {
  await box.sh(`cd ${BOX_DIR} && (nohup node mcp-standin.cjs --preset gitea --port ${port} --auth-port ${authPort} --public-host localhost --static-token ${STATIC_TOKEN}=canary --control >${name}.out 2>&1 &)\nfor i in $(seq 1 100); do [ -s ${BOX_DIR}/${name}.out ] && break; sleep 0.2; done`, { timeoutMs: 40_000 });
  const first = ((await box.read(`${BOX_DIR}/${name}.out`)) ?? '').split('\n')[0] ?? '';
  let ready: Record<string, unknown> = {};
  try {
    ready = JSON.parse(first) as Record<string, unknown>;
  } catch {
    // reported below
  }
  expect(ready.ready === true, `The MCP stand-in provider ${name} did not start.`, first || ((await box.read(`${BOX_DIR}/${name}.out`)) ?? ''));
  return ready;
}

/** The shared setup: two providers, the portal's own compile and delivery of a plugin naming them, and one session so Claude Code registers the marketplace. */
function fixture(ctx: CheckContext): Promise<McpFixture> {
  let made = ctx.shared.get('mcp') as Promise<McpFixture> | undefined;
  if (!made) {
    made = build(ctx);
    ctx.shared.set('mcp', made);
  }
  return made;
}

async function build({ box, version: claudeVersion }: CheckContext): Promise<McpFixture> {
  await box.put([box.dir(BOX_DIR), box.file(`${BOX_DIR}/mcp-standin.cjs`, MCP_STANDIN, 0o755)]);
  await startKit(box, 'kit-oauth', 4601, 4602);
  await startKit(box, 'kit-token', 4603, 4604);

  // The catalog's versions and a set naming them, as the portal's built-in templates make them: an OAuth server with a pinned client, callback port and
  // scopes (a list in the catalog, ONE string in `.mcp.json`), and a bearer-token server whose header comes from a Secrets & env file through the helper.
  const versions = new Map<string, CatalogVersion>([
    ['e-gitea', version('gitea', { url: 'http://localhost:4601/mcp', transport: 'http', auth: 'oauth', allowPrivateNetwork: true, oauth: { clientId: 'standin-gitea-client', callbackPort: 24819, scopes: OAUTH_SCOPES } })],
    ['e-static', version('static', { url: 'http://localhost:4603/mcp', transport: 'http', auth: 'headers', allowPrivateNetwork: true }, [{ name: 'Authorization', target: 'header', secret: true, required: true, template: 'Bearer {value}' }])],
  ]);
  const content: McpSetContent = {
    slug: 'canary',
    servers: [
      { key: 'gitea', entry: 'e-gitea', version: 'v1', enabled: true, config: {}, secrets: {} },
      { key: 'static', entry: 'e-static', version: 'v1', enabled: true, config: {}, secrets: { Authorization: secretFileRef('canary-token') } },
    ],
  };
  // The version is not given to the compiler: the canary asks what THIS Claude Code does with the format, whatever the portal would deliver to it.
  const out = compileMcp({ sets: [{ pool: { id: 'canary', name: 'Canary', revision: 1 }, content }], find: (e) => versions.get(e) ?? null, names: null, claudeVersion: null, running: true, now: new Date() });
  const outcomes = out.servers.map((s) => ({ key: s.key, state: s.state, reason: s.reason }));
  expect(outcomes.length === 2 && outcomes.every((o) => o.state === 'delivered'), `The portal’s compile did not deliver both servers: ${JSON.stringify(outcomes)}.`);
  const plugin = out.plugins[0]!;
  const bundle = compileDelivery({ portalId: 'canary', generation: 1, fragments: out.fragments, claudeVersion: null, running: true });
  await writeBundle(box.asDelivery(), box.name, bundle, { running: true, deletes: [] });
  await box.put([{ path: '/etc/claudepilot/secrets/files/canary-token', type: 'file', content: STATIC_TOKEN, mode: 0o440, uid: ROOT_UID, gid: NODE_GID }]);

  // The first session registers the portal's marketplace and enables the plugin; its init line then lists the plugin's servers.
  await box.setScript({ id: 'mcp-register', messages: { text: 'ok' } });
  const s = await box.stream(CHAT_FLAGS, { env: LOCAL });
  let init: { name: string; status: string }[] = [];
  try {
    await turn(s, 'hello');
    const line = s.lines.find((l) => typeof l !== 'string' && l.type === 'system' && l.subtype === 'init');
    const listed = isObj(line) && Array.isArray(line.mcp_servers) ? line.mcp_servers : [];
    init = listed.filter(isObj).map((m) => ({ name: String(m.name), status: String(m.status) }));
  } finally {
    await s.close();
  }
  const raw = (await box.read(`/etc/claudepilot/marketplace/plugins/${PLUGIN}/${plugin.hash12}/.mcp.json`)) ?? '';
  let mcpJson: McpFixture['mcpJson'];
  try {
    mcpJson = JSON.parse(raw) as McpFixture['mcpJson'];
  } catch {
    mcpJson = { mcpServers: {} };
  }
  void claudeVersion;
  return { pluginVersion: plugin.version, hash12: plugin.hash12, init, mcpJson, outcomes };
}

const gitea = `plugin:${PLUGIN}:gitea`;
const staticToken = `plugin:${PLUGIN}:static`;

/* ---------- mcp-plugin-format ---------- */

const pluginFormat: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'mcp-plugin-format')!,
  async run(ctx) {
    const { box } = ctx;
    const fx = await fixture(ctx);
    // What the portal wrote: the scopes as ONE string (a list makes Claude Code drop the server without a word), a headers helper for the token server.
    const oauth = fx.mcpJson.mcpServers.gitea?.oauth as Record<string, unknown> | undefined;
    expect(oauth && oauth.scopes === OAUTH_SCOPES.join(' ') && oauth.clientId === 'standin-gitea-client' && oauth.callbackPort === 24819, 'The delivered .mcp.json lacks the oauth block (a scopes STRING, the client id and the callback port).', JSON.stringify(fx.mcpJson).slice(0, 700));
    expect(typeof fx.mcpJson.mcpServers.static?.headersHelper === 'string', 'The delivered .mcp.json lacks the headersHelper of the token server.', JSON.stringify(fx.mcpJson).slice(0, 700));
    // What Claude Code made of it, in a session's init line (the portal's reader maps these statuses to a sign-in state).
    const byName = new Map(fx.init.map((m) => [m.name, m.status]));
    expect(byName.has(gitea) && byName.has(staticToken), `The session lists ${fx.init.map((m) => m.name).join(', ') || 'no plugin servers'}, not both plugin servers.`, JSON.stringify(fx.init));
    // The init line is written while connections may still be pending: its words are only checked to be ones the portal's reader knows. The health
    // check of `claude mcp list` below is what decides the state.
    const known = new Set(['pending', 'needs-auth', 'connected', 'failed']);
    expect([...byName.values()].every((st) => known.has(st) && (st === 'pending' || initState(st) !== null)), `A server status in the init line is one the portal does not read: ${JSON.stringify(fx.init)}.`, JSON.stringify(fx.init));
    // `claude mcp list` and `claude mcp get`, read by the portal's parser.
    const list = await box.sh(`${shq(box.claude)} mcp list 2>&1 | head -8`, { timeoutMs: 120_000, env: LOCAL });
    expect(new RegExp(`${gitea}:.*Needs authentication`).test(list.stdout) && new RegExp(`${staticToken}:.*Connected`).test(list.stdout), '`claude mcp list` does not list the plugin’s servers as needing authentication and connected.', list.stdout);
    const get = await box.sh(`${shq(box.claude)} mcp get ${gitea} 2>&1 | head -12`, { timeoutMs: 120_000, env: LOCAL });
    expect(parseMcpGet(get.stdout).state === 'needs_sign_in' && /OAuth: client_id configured, callback_port 24819/.test(get.stdout), '`claude mcp get` does not describe the OAuth server the way the portal reads it.', get.stdout);
    return pass('the portal’s .mcp.json (oauth scopes string, headers helper) is accepted: both plugin servers are listed, one needs sign-in, one is connected', `${fx.init.map((m) => `${m.name}: ${m.status}`).join('\n')}\n${list.stdout.trim()}`);
  },
};

/* ---------- mcp-login ---------- */

const login: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'mcp-login')!,
  async run(ctx) {
    const { box } = ctx;
    await fixture(ctx);
    // The portal's own sign-in module drives `claude mcp login --no-browser` in a terminal in the container.
    const host: OAuthHost = { shell: (_t, _n, size, cmd) => box.shell(size, cmd ?? ['bash', '-l'], LOCAL), exec: (_t, _n, cmd) => box.exec(cmd, { env: LOCAL }) };
    const signIns = new SignIns(() => host, () => undefined);
    const ws = 'canary/canary';
    const server = { plugin: PLUGIN, key: 'gitea', name: 'Canary gitea' };
    let id: string | null = null;
    try {
      const start = await signIns.start(ws, '', server, 'system:claude-canary');
      id = start.signInId;
      const url = new URL(start.url);
      expect(url.origin === 'http://localhost:4602', `The authorization address points at ${url.origin}, not the provider’s own server.`, url.origin);
      expect(url.searchParams.get('client_id') === 'standin-gitea-client', 'The authorization address does not carry the pinned client id.', url.search.slice(0, 300));
      expect(url.searchParams.get('scope') === OAUTH_SCOPES.join(' '), `The authorization address asks for scope “${url.searchParams.get('scope')}”, not the pinned scopes.`, url.search.slice(0, 300));
      expect(url.searchParams.get('redirect_uri') === 'http://localhost:24819/callback' && start.callback === 'http://localhost:24819/callback', 'The redirect address is not the pinned callback port’s.', `${url.searchParams.get('redirect_uri')} / ${start.callback}`);
      expect(!!url.searchParams.get('code_challenge') && url.searchParams.get('code_challenge_method') === 'S256', 'The authorization address is not a PKCE (S256) request.', url.search.slice(0, 300));
      // The browser, played from inside the container: the provider approves and redirects to the callback address with a code.
      const hop = (await box.sh(`curl -s -o /dev/null -D - ${shq(start.url)} | grep -i '^location' | cut -d' ' -f2- | tr -d '\\r'`, { timeoutMs: 30_000, env: LOCAL })).stdout.trim();
      expect(hop.startsWith('http://localhost:24819/callback?code='), `The provider redirected to ${hop.replace(/code=[^&]*/, 'code=…') || 'nowhere'}, not to the callback address.`);
      await signIns.complete(ws, id, hop);
      id = null;
      const get = await box.sh(`${shq(box.claude)} mcp get ${gitea} 2>&1 | head -12`, { timeoutMs: 120_000, env: LOCAL });
      expect(parseMcpGet(get.stdout).state === 'connected', 'After the pasted redirect Claude Code does not report the server as connected.', get.stdout.replace(/code=[^&\s]*/g, 'code=…'));
      const left = await box.sh(`ps -eo args | grep -c "[c]laude mcp login" || true`);
      expect(left.stdout.trim() === '0', 'A `claude mcp login` process was left running.', left.stdout);
      return pass('claude mcp login --no-browser printed the authorization address (pinned client, scopes, callback, PKCE), took the pasted redirect and signed in', `${url.origin}${url.pathname} client_id=${url.searchParams.get('client_id')} scope=${url.searchParams.get('scope')}\n${get.stdout.trim().split('\n').slice(0, 4).join('\n')}`);
    } finally {
      if (id) await signIns.cancel(ws, id, 'system:claude-canary').catch(() => undefined);
    }
  },
};

/* ---------- plugin-details ---------- */

const pluginDetails: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'plugin-details')!,
  async run(ctx) {
    const { box } = ctx;
    const fx = await fixture(ctx);
    const r = await box.sh(verifyScript([PLUGIN]), { timeoutMs: 120_000, env: LOCAL });
    const split = splitVerify(r.stdout);
    const text = split.plugins.get(PLUGIN) ?? '';
    expect(text !== '', '`claude plugin details` printed nothing the portal can split.', `${r.stdout}\n${r.stderr}`.trim().slice(-800));
    // The portal gates this reader on the versions it knows (VERIFY_TESTED_CLAUDE); the canary asks whether the LAYOUT still parses, so it hands the
    // parser a version it knows. A layout it can no longer read is `not_verified`/`mismatch`: the portal would say "Not verified" for this version.
    const outcome = parseDetails(text, { plugin: PLUGIN, version: fx.pluginVersion, servers: ['gitea', 'static'] }, VERIFY_TESTED_CLAUDE[0]!);
    expect(outcome.result === 'ok', `The portal could not read \`claude plugin details\` (${outcome.result}${outcome.detail ? `: ${outcome.detail}` : ''}).`, text.slice(0, 1200));
    return pass(`claude plugin details lists ${outcome.servers.join(' and ')} in the layout the MCP verification reads`, text.trim().split('\n').slice(0, 8).join('\n'));
  },
};

export const MCP_CHECKS: CanaryCheck[] = [pluginFormat, login, pluginDetails];
void tailOf;
