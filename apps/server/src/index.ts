import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { formatCode, SETTING_KEYS, type LiveTopic } from '@portal/contracts';
import { AccountHealthService } from './accounts/health.js';
import { AccountPools } from './accounts/pools.js';
import { AccountsService } from './accounts/service.js';
import { Outbox } from './delivery/outbox.js';
import { LiveHub } from './live.js';
import { SocketGuard } from './sockets.js';
import { workspaceView } from './workspaces/view.js';
import { Reconciler, type FragmentProvider } from './delivery/reconciler.js';
import { References } from './pools/references.js';
import { exposedSecretValues } from './secrets/exposed.js';
import { SecretsKind } from './secrets/kind.js';
import { registerMcpSets } from './mcp/index.js';
import { SkillsModule } from './skills/module.js';
import { registerSkillTools } from './skills/portalTools.js';
import { SecretRotations } from './secrets/rotation.js';
import { createKnowledge } from './knowledge/module.js';
import { registerKnowledgeTools } from './knowledge/portalTools.js';
import { createClaudeUsage } from './claudeusage/index.js';
import { registerClaudeUsageTools } from './claudeusage/portalTools.js';
import { ClaudeVersions, registerClaudeVersionTools } from './claudeversion/index.js';
import { createUsageSpend, registerUsageSpendTools } from './usagespend/index.js';
import { createRepos, registerRepoTools } from './repos/index.js';
import { createGlance } from './glance/index.js';
import { createPlatform } from './platform/index.js';
import { createCodespaces } from './codespaces/index.js';
import { registerPersonas } from './personas/index.js';
import { registerPersonaTools } from './personas/portalTools.js';
import { readSessionBlob } from './personas/sessionBlobs.js';
import { readWorkspaceFile } from './personas/workspaceFiles.js';
import { registerSettings } from './settings/index.js';
import { BrowserModule } from './browser/index.js';
import { PortalMcpModule } from './portalmcp/module.js';
import { registerBuiltInPortalTools } from './portalmcp/tools/index.js';
import { internalUrlResolver } from './portalmcp/internalUrl.js';
import { Tickets } from './tickets/service.js';
import { CiService } from './ci/service.js';
import { WorkspacesCiHost } from './ci/host.js';
import { registerCiTools } from './ci/portalTools.js';
import { valueRedactors } from './ci/values.js';
import { secretName } from './secrets/names.js';
import { ChatSessionsAdapter } from './ci/sessions.js';
import { TicketsAdapter } from './ci/tickets.js';
import { ChatTicketSessions } from './tickets/sessions.js';
import { registerChatTools } from './chat/portalTools.js';
import { registerArtifactTools } from './chat/artifacts/portalTools.js';
import { registerTicketTools } from './tickets/portalTools.js';
import { PoolService } from './pools/service.js';
import { createApp, PLAIN_NAME } from './app.js';
import { config } from './config.js';
import { JsonFile } from './jsonFile.js';
import { Portal } from './portal.js';
import { acquireLock } from './store/lock.js';
import { loadSecretKey, SecretKeyError } from './store/secretBox.js';
import { sessionStore } from './store/sessions.js';
import { Store } from './store/store.js';
import { DockerRuntime } from './workspaces/docker.js';
import { attachShell, cookie } from './workspaces/shell.js';
import { ChatController } from './chat/controller.js';
import { BYPASS_SETTING } from './chat/bypass.js';
import { AUTO_TRUST_SETTING } from './chat/trust.js';
import { AGENT_CHILDREN_SETTING, AGENT_DEPTH_SETTING, AGENT_MESSAGES_SETTING, AGENT_SPAWNS_SETTING } from './chat/agents.js';
import { BUDGET_SETTING, CAP_TOTAL_SETTING, CAP_WORKSPACE_SETTING } from './chat/caps.js';
import { chatEligibility } from './chat/eligibility.js';
import { hostInstaller } from './chat/install.js';
import { attachChat } from './chat/socket.js';
import { registerChatAuthz } from './chat/authz.js';
import { KubernetesRuntime } from './workspaces/kubernetes.js';
import { LocalRuntime } from './workspaces/local.js';
import { Workspaces } from './workspaces/manager.js';
import { WorkspaceIdentities } from './workspaces/identity.js';
import { rewriteWorkspaceRefs } from './workspaces/refRewrite.js';
import { createConnect } from './connect/index.js';
import { agentBundle } from './connect/bundle.js';
import { wireConnect } from './workspaces/connect/wire.js';
import type { Runtime } from './workspaces/runtime.js';

// A background task that rejects (a module reading a table a frozen database doesn't have, a probe, a scan) must not
// take the portal down with every open terminal: log it and carry on. Synchronous throws still stop the process.
process.on('unhandledRejection', (reason) => console.error('[portal] unhandled rejection:', reason));
// A client library that emits 'error' on a request nobody listens to (a Docker daemon that answers a redirect, a host that no
// longer resolves) would end the process the same way. Network failures are logged and survived; anything else still stops it.
const NETWORK_ERROR = /^(ENOTFOUND|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_STREAM_PREMATURE_CLOSE|ERR_UNESCAPED_CHARACTERS)$/;
process.on('uncaughtException', (err) => {
  console.error('[portal] uncaught', err);
  if (!NETWORK_ERROR.test((err as NodeJS.ErrnoException)?.code ?? '')) process.exit(1);
});

// One portal per data dir: the database has a single writer.
await acquireLock(config.paths.data).catch((e: unknown) => {
  console.error(`portal: ${(e as Error).message}`);
  process.exit(1);
});

let secretKey: Buffer | null = null;
let keyError: string | undefined;
// A key file that doesn't exist yet (or is empty) just means "no key yet": the panel can set one up.
const keyFileEmpty = !!config.secretKey.file && !config.secretKey.value && (!existsSync(config.secretKey.file) || statSync(config.secretKey.file).size === 0);
try {
  secretKey = keyFileEmpty ? null : loadSecretKey(config.secretKey);
} catch (e) {
  if (!(e instanceof SecretKeyError)) throw e;
  keyError = e.message;
}
const store = await Store.open({
  dataDir: config.paths.data,
  secretKey,
  keyError,
  keySource: config.secretKey.value ? 'env' : config.secretKey.file ? 'file' : null,
});
const { trust } = store;
console.log(
  trust.state === 'ok'
    ? `[store] ready (portal ${store.portalId?.slice(0, 8)}, schema ${store.schemaVersion})`
    : `[store] ${trust.state.toUpperCase()}: ${trust.reasons.map((r) => r.message).join(' ')}`,
);
const dailyBackup = () =>
  void store.backupIfDue().then(
    (file) => file && console.log(`[store] daily backup ${file}`),
    (e: unknown) => console.error(`[store] daily backup failed: ${(e as Error).message}`),
  );
dailyBackup();
const backupTimer = setInterval(dailyBackup, 60 * 60 * 1000);
backupTimer.unref();

const portal = new Portal(config.serverCode, config.session.ttlMs);
// Sign-ins survive restarts (12 hours each); only token hashes are stored.
portal.useStore(sessionStore(store));
const { workspaces: ws } = config;
const runtimes: Runtime[] = ws.docker.map((d) => new DockerRuntime(d, ws.dockerImage, ws.imageContext, () => store.portalId, undefined, { canaryPrefix: ws.claude.canaryPrefix, alias: ws.claude.imageAlias }));
if (ws.kubernetes.enabled) {
  try {
    runtimes.push(new KubernetesRuntime(ws.kubernetes));
  } catch (e) {
    console.error(`[workspaces] kubernetes target off: ${(e as Error).message}`);
  }
}
if (ws.local.enabled && !PLAIN_NAME.test(ws.local.name)) {
  console.error(`[workspaces] PORTAL_LOCAL_NAME “${ws.local.name}” is not a plain name (letters, digits, . _ -, up to 63): using "local".`);
  ws.local.name = 'local';
}
if (ws.local.enabled) runtimes.push(new LocalRuntime({ name: ws.local.name, state: new JsonFile(`${config.paths.data}/local-workspace.json`, {}) }));
// Every workspace's stable id, its `<target>/<name>` alias and its stored runtime name (T-42), kept in the store.
const workspaces = new Workspaces(runtimes, new JsonFile(`${config.paths.data}/pending-creates.json`, []), {}, new WorkspaceIdentities(store));

// Chat sessions: one controller shared by the REST routes and the chat socket.
const chatController = new ChatController(store, workspaces);
chatController.installHost = hostInstaller(workspaces);

const accounts = new AccountsService(store);
const pools = new AccountPools(store);
const health = new AccountHealthService(store);
accounts.hooks = {
  changed: (id, why) => pools.accountChanged(id, why),
  checked: (id, result, manual) => health.fromCheck(id, result, manual),
  poolsWith: (id) => pools.poolsWith(id),
};
// Multi-assignment pools (secrets & env, skillsets, MCP sets). Each registered kind's fragment provider
// joins `providers`; register kinds here, before the reconciler starts, or a manifest naming one of
// their pools freezes its workspace (foundation §6.5).
const providers: FragmentProvider[] = [pools];
const poolService = new PoolService(store, { providers });
// Pool kinds register here, before the reconciler starts. Kinds that use Secrets & env names (or provide
// them) share one References.
const references = new References();
// Secrets & env: variables and secrets for tools in workspaces; also where other pools resolve secret names.
const secretsKind = new SecretsKind(store, poolService, references);
poolService.register(secretsKind);
// Rotation, versions and revocation of secret values, and the purge of values nobody needs (Secrets & env FR16 to FR18).
const secretRotations = new SecretRotations(store, secretsKind, poolService);
secretRotations.start();
// MCP sets: reviewed MCP servers grouped into sets, delivered as plugins; secrets by Secrets & env name.
const mcpSets = registerMcpSets({ store, pools: poolService, references, access: (t) => workspaces.runtimeFor(t)?.delivery });
// Settings store and the MCP lockdown: portal-wide switches (account MCP off, pool MCP only), delivered to every workspace
// as the `settings` owner's drop-in. The MCP pool reports what it delivers, so "pool only" allows exactly that.
const settingsModule = registerSettings({ store, providers });
settingsModule.lockdown.addMatcherSource((ws) => mcpSets.matchers(ws));
// Skillsets: the reviewed skill library, delivered as one plugin per set; verified in running workspaces.
const skills = new SkillsModule(store, poolService, { runtimes: (t) => workspaces.runtimeFor(t) });
skills.start();
// Personas and instruction contexts: what Claude is told, as managed instructions, styles, subagents and rules.
const personas = registerPersonas({ store, pools: poolService });
// Agents may propose changes to their own persona only while the portal-wide switch is on (I11).
personas.agentSelfEdit = () => settingsModule.settings.get<boolean>(SETTING_KEYS.agentsSelfEdit);
// Browser & desktop: a browser container beside each workspace, driven over MCP and watched in the portal. Its
// container shares the workspace's namespace and volume, so the runtimes take it away before they stop or remove one.
const browser = new BrowserModule({ store, pools: poolService, steps: mcpSets.steps, runtimes, notify: () => poolService.onChange(), names: workspaces.identities });
for (const r of runtimes) browser.guard(r);
// With "pool MCP only" on, the browser's servers are admitted by their command lines (the folder of the plugin spelled out).
settingsModule.lockdown.addMatcherSource((ws) => browser.service.matchers(ws));
// Knowledge: vaults of Markdown notes the admin and agents share, with search, history and graphs.
const knowledge = createKnowledge(store, { dataDir: config.paths.data, repoRoot: config.paths.root, dev: config.dev, log: console.log });
// Tickets store their workspace as the stable id (T-42 slice 3); the graphs link by the key.
knowledge.directory.workspaceKeyOf = (stored) => workspaces.identities.keyOf(stored);
knowledge.start();
const reconciler = new Reconciler(store, (t) => workspaces.runtimeFor(t), () => workspaces.runtimeList(), providers);
pools.reconciler = reconciler;
// Sessions run on the workspace's Account Pool when it has one (active and synced), else on their Claude's
// own sign-in (chat PRD §6); a pool change ends the workspace's sessions first. `signedIn` is set in app.ts.
chatController.pooled = (id) => !!pools.stateFor(id);
chatController.eligibility = (id) => chatEligibility(pools.stateFor(id), reconciler.row(id)?.status);
// A session or a Default Claude is only made for a workspace that exists (QA-032).
chatController.workspaceExists = (id) => {
  const slash = id.indexOf('/');
  return workspaces.exists(id.slice(0, slash), id.slice(slash + 1));
};
poolService.reconciler = reconciler;
settingsModule.reconciler = reconciler;
// Bypass in chat (chat PRD FR20): the interim policy switch, and what is true of a workspace for the confirmation.
chatController.bypassAllowed = () => settingsModule.settings.get<boolean>(BYPASS_SETTING);
chatController.autoTrustRules = () => settingsModule.settings.get<boolean>(AUTO_TRUST_SETTING);
// How many sessions may be awake (chat PRD FR39): per workspace and in total, from the shared settings.
chatController.liveCaps = () => ({ perWorkspace: settingsModule.settings.get<number>(CAP_WORKSPACE_SETTING), total: settingsModule.settings.get<number>(CAP_TOTAL_SETTING) });
// How deep, how wide and how often sessions may start sessions and message each other (multi-agent), from the shared settings.
chatController.sessionBudgetUsd = () => settingsModule.settings.get<number>(BUDGET_SETTING);
// Side questions (chat PRD §20): their limits and switches come from the shared settings, and a session is read through the one authorization resolver.
chatController.btwSettings = (key) => settingsModule.settings.get(key);
registerChatAuthz((id) => chatController.sessionFacts(id));
chatController.agentCaps = () => ({
  maxDepth: settingsModule.settings.get<number>(AGENT_DEPTH_SETTING),
  maxChildren: settingsModule.settings.get<number>(AGENT_CHILDREN_SETTING),
  spawnsPerHour: settingsModule.settings.get<number>(AGENT_SPAWNS_SETTING),
  messagesPerHour: settingsModule.settings.get<number>(AGENT_MESSAGES_SETTING),
});
settingsModule.settings.onChange((key) => key === BYPASS_SETTING && void chatController.bypassPolicyChanged());
// The Restart hint (chat PRD, Restart): when the latest delivery into a workspace landed; a session whose process is older offers a Restart.
chatController.deliveredAt = (id) => reconciler.row(id)?.applied_at ?? null;
chatController.configChanges = (id, sinceMs) => reconciler.changesSince(id, sinceMs);
reconciler.onChange((id) => chatController.deliveryChanged(id));
chatController.bypassFacts = (id) => ({
  internet: true,
  credentials: [...(pools.stateFor(id) ? ['an account pool’s key'] : []), ...(poolService.assignmentsFor(id).some((a) => a.type === 'secrets' && a.state === 'assigned') ? ['Secrets & env values'] : [])],
});
pools.onTransition = (id) => void chatController.endWorkspaceSessions(id, 'Pool change in progress');
// Reattach readers to sessions still running in workspaces, and mark the ones that died Interrupted.
chatController.start();
health.onChange = (id, why, opts) => pools.accountChanged(id, why, opts);
health.check = async (id) => void (await accounts.check(id, { manual: false }));
health.activeAccount = (workspaceId) => pools.activeAccount(workspaceId);
health.onUnconfirmed = (ids) => ids.forEach((id) => void reconciler.request(id, 'unconfirmed signal'));
// Failure signals from assigned workspaces: helper runs and StopFailure (Account Pool §11.5).
const outbox = new Outbox(store, (t) => workspaces.runtimeFor(t));
outbox.subscribe('account', (workspaceId, events) => health.onSignals(workspaceId, events), () => pools.assignedWorkspaces());
// MCP launcher and helper events: starts and failures, never values (MCP set §13.2).
outbox.subscribe('mcp', (workspaceId, events) => mcpSets.onOutbox(workspaceId, events), () => mcpSets.assignedWorkspaces());
// A workspace that stops (or is removed) takes its chat sessions with it: they stop cleanly now and read Interrupted, resumable once it is back.
workspaces.hooks.beforeStop = async (id) => {
  await chatController.endWorkspaceSessions(id, 'The workspace was stopped').catch(() => undefined);
  await outbox.pull(id);
};
// Connect (docs/prd/targets-connect.md): targets enrolled from the web, agents that dial out, runtimes over their tunnels. Built here, before the
// reconciler starts and the manager resumes, so enrolled runtimes are on the manager by then (FR38); `wireConnect` (workspaces/connect/wire.ts)
// plugs in the runtime factory and the manager's hooks. Its live topic is bound below, once the live hub exists.
let connectChanged: () => void = () => undefined;
const scannedTargetIds = runtimes.map((r) => r.target.id);
const connect = createConnect({
  store,
  config: config.connect,
  scanned: () => workspaces.targets(),
  scannedIds: () => scannedTargetIds,
  workspacesOn: async (target) => (await workspaces.list()).filter((w) => w.target === target),
  removeWorkspace: (id) => workspaces.remove(id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)),
  recheck: (id) => workspaces.recheck(id),
  bundle: agentBundle,
  trustProxy: config.trustProxy,
  notify: () => connectChanged(),
});
wireConnect({ connect, workspaces, chat: chatController, reconciler });
connect.start();
reconciler.start();
// After the manager's hooks are set (Connect's `wireConnect` sets `settled`, which resume waits on for enrolled targets: FR38).
void workspaces.resume().catch((e: unknown) => console.error(`[workspaces] resume failed: ${(e as Error).message}`));
// T-42 slice 3: stored workspace references move to the stable id, once, in the background, a minute after the start (the first list has
// given every workspace its identity by then). Safe to stop (a shutdown aborts it between two rows) and to run again on the next start.
const refRewrite = new AbortController();
setTimeout(() => {
  void (async () => {
    await workspaces.list().catch(() => undefined);
    const results = await rewriteWorkspaceRefs(store, workspaces.identities, { signal: refRewrite.signal });
    for (const r of results) console.log(`[workspaces] ${r.table}.${r.column}: ${r.rewritten} references moved to stable ids, ${r.kept} kept as they were${r.done ? '' : ' (stopped; continues next start)'}`);
  })().catch((e: unknown) => console.error(`[workspaces] reference rewrite failed: ${(e as Error).message}`));
}, 60_000).unref();
browser.start();
outbox.start();
health.start();
// Claude Code version pinning (claude-version-pinning PRD): each workspace's version next to its pin, the compatibility canary (a throwaway container, a stand-in
// API and the real CLI), Apply and Rollback. New workspaces get the default pin; the workspace list carries each one's version brief.
const claudeVersions = new ClaudeVersions({
  store,
  workspaces,
  reconciler,
  chat: chatController,
  settings: settingsModule.settings,
  notify: () => notify('claudeversion'),
  audit: (e) => platform.audit.record(e),
  canaryTarget: config.workspaces.claude.canaryTarget,
  imageFixed: config.workspaces.dockerImageFixed,
});
workspaces.hooks.defaultClaudeVersion = claudeVersions.defaultForNew;
// A workspace rename (T-42 slice 2) leaves a row in the platform audit (made further down; only called later).
workspaces.hooks.audit = (e) => platform.audit.record(e);
// Live pages (`/api/live`): one socket per tab, fed by every place that changes what they show.
const view = workspaceView(pools, reconciler, claudeVersions.brief);
const live = new LiveHub(
  { workspaces: async () => (await workspaces.list()).map(view), usage: () => workspaces.usage() },
  (req) => !!portal.session(cookie(req, config.session.cookie)),
);
const notify = (...topics: LiveTopic[]) => topics.forEach((t) => live.publish(t));
connectChanged = () => notify('connect');
workspaces.hooks.changed = () => notify('workspaces');
reconciler.onChange(() => notify('workspaces'));
accounts.hooks.event = () => notify('accounts');
health.onEvent = () => notify('accounts');
pools.onChange = () => notify('accounts', 'workspaces');
poolService.onChange = () => notify('pools');
settingsModule.onChange = () => notify('workspaces');
const stopWatching = runtimes.flatMap((r) => (r.watch ? [r.watch(() => notify('workspaces'))] : []));
registerClaudeVersionTools(claudeVersions);
claudeVersions.start();
// Portal MCP (portal-mcp PRD): the /mcp endpoint, its access tokens and audit, and the tool registry every area adds to
// (portalmcp/registry.ts). The built-in tools are adapters over the services above; other areas register theirs here too.
const agentUrls = internalUrlResolver({ workspaces, port: config.port, configured: config.portalMcp.internalUrl ?? null });
const portalMcp = new PortalMcpModule(store, {
  internalUrl: config.portalMcp.internalUrl,
  extraOrigins: config.portalMcp.origins,
  // Agents' per-session tokens (interface I8): alive while the chat session is, aimed at the portal as a workspace reaches it.
  agentHost: {
    alive: (id) => {
      const s = chatController.get(id);
      return !!s && s.state !== 'ended' && !s.archivedAt;
    },
    url: agentUrls,
    known: agentUrls.known,
  },
});
// With "Pool MCP only" on, Claude Code admits only listed servers, and the portal's own endpoint (which an agent's session reaches
// through --mcp-config) is one of them: its exact URL for each workspace that opted in. Compile again when that changes.
settingsModule.lockdown.addMatcherSource((workspaceId) => portalMcp.agentMatchers(workspaceId));
portalMcp.onAgentAddress = (workspaceId) => void reconciler.request(workspaceId, 'the portal MCP address for agents changed').catch(() => undefined);
// A token never outlives its session, whatever else is wired: ended, archived and deleted sessions lose theirs here too.
chatController.onEvent((id, msg) => {
  if (msg.type === 'session' && (msg.session.state === 'ended' || msg.session.archivedAt)) portalMcp.agents.revokeSession(id, `session ${msg.session.state}`);
  else if (msg.type === 'removed') portalMcp.agents.revokeSession(id, 'session deleted');
});
registerBuiltInPortalTools({ store, module: portalMcp, workspaces, chat: chatController, accounts, accountPools: pools, poolService, reconciler, mcp: mcpSets });
portalMcp.start();
// What each session's Claude Code process is launched with (I8 and the Secrets & env redactor): its token for the portal's tools, the
// account-MCP switch (belt and braces next to the managed key), and the secret values a workspace was given, read to redact chat text.
// Agent access stores its workspace as the stable id and reads it as the key (T-42 slice 3).
portalMcp.agents.workspaceRefs = workspaces.identities;
chatController.agentAccess = portalMcp.agents;
{
  // T-102: agent access turned on or off changes the portal tools a session's NEXT process gets: its "Tools changed" hint says so.
  const accessChanged = portalMcp.agents.onAccessChange;
  portalMcp.agents.onAccessChange = (workspaceId) => {
    accessChanged?.(workspaceId);
    chatController.portalToolsChanged(workspaceId);
  };
}
chatController.launchEnv = () => (settingsModule.settings.get<boolean>(SETTING_KEYS.mcpAccountOff) ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {});
chatController.secretValues = (id) => exposedSecretValues(poolService, id);
// MCP OAuth (MCP set PRD §13.3): the guided sign-in runs Claude Code's login in a workspace terminal, for one of its Claudes, and a chat
// session's `system/init` tells the MCP module which OAuth servers still need it.
mcpSets.oauth.host = workspaces;
mcpSets.oauth.claudeDirectory = (id, claudeId) => chatController.claudeOf(id, claudeId)?.directory ?? null;
chatController.mcpServersSeen = (id, directory, servers) => mcpSets.oauth.seen(id, directory, servers).map((s) => s.name);
// Tickets: one queue of work for people and agents; reaches chat sessions only through its adapter (tickets PRD).
// A ticket's workspace is stored as the stable id and read as the key (T-42 slice 3).
const tickets = new Tickets(store, new ChatTicketSessions(chatController), {
  link: (id) => `${(config.portalMcp.uiUrl ?? `http://localhost:${config.port}`).replace(/\/+$/, '')}/admin/tickets/${id}`,
  workspaceRefs: workspaces.identities,
});
tickets.onChange = () => notify('tickets');
// A bump reaches into a session: the platform audit (created further down) records who, which ticket, which session and how (FR30).
tickets.onAudit = (e) => platform.audit.record(e);
tickets.start();
chatController.ticketExists = (id) => tickets.exists(id);
// T-270: a continuation takes its predecessors' tickets in the transaction that creates it.
chatController.continueTickets = (to, from) => tickets.continueFrom(to, from);
registerTicketTools(tickets);
// The chat's own tools for its Claude (rename itself); bound to the session its token was minted for.
registerChatTools(chatController);
// Chat content: the agent hands a file to the person as an artifact card (artifact_publish).
registerArtifactTools(chatController);
// Knowledge: notes and graphs for an admin's Claude and for agents, inside each vault's agent policy (knowledge PRD §14).
registerKnowledgeTools(knowledge);
// Personas: a session reads and proposes changes to its own persona (name, avatar, instructions); a person approves (I11).
registerPersonaTools(personas, {
  readWorkspaceFile: (ws, path, max) => readWorkspaceFile((t) => workspaces.runtimeFor(t), ws, path, max),
  readSessionBlob: (sessionId, blobId, max) => readSessionBlob(store, sessionId, blobId, max),
});
// Skills: a session proposes a new or changed skill for its own workspace while the portal-wide switch is on; a person reviews it in the library (I11).
registerSkillTools(skills, { agentSelfEdit: () => settingsModule.settings.get<boolean>(SETTING_KEYS.agentsSelfEdit) });
// CI: a git remote on each workspace and a self-hosted runner in it (local-git-ci PRD). It follows the remotes of running workspaces
// by reading their files, and does nothing unless a workspace has one and the store allows work.
const ciSessions = new ChatSessionsAdapter(chatController);
// Secrets in logs: the values delivered to a workspace are taken out by value (the chat's redactor); a job's secrets are checked by name.
const ciValues = valueRedactors((id) => exposedSecretValues(poolService, id));
const ci = new CiService(store, new WorkspacesCiHost(workspaces), {
  maxRunsPerWorkspace: config.ci.maxRunsPerWorkspace,
  maxJobsParallel: config.ci.maxJobsParallel,
  tickets: new TicketsAdapter(tickets),
  sessions: ciSessions,
  redactFor: ciValues.redactFor,
  streamFor: ciValues.streamFor,
  secrets: (id, name) => secretName(references, id, name),
  // Deployment approvals and environment protection changes (FR41) go to the platform audit, created further down.
  audit: (e) => platform.audit.record(e),
});
registerCiTools(ci, ciSessions);
// A resources change that restarts a workspace's pod (T-98) waits for the CI runs running in it.
workspaces.hooks.runningCi = (id) => ci.list({ workspace: id, status: ['running'], limit: 1 }).total;
ci.onChange = () => notify('ci');
if (config.ci.enabled) ci.start();
// Claude usage: the plan limits of each Claude, read from Claude Code itself (claude-usage PRD). Its probes run only for running
// workspaces whose store the portal trusts; live sessions' rate-limit events arrive through `onRateLimit` (interface I12).
const claudeUsage = createClaudeUsage({ store, workspaces, chat: chatController, pooled: (id) => !!pools.stateFor(id), notify: () => notify('claudeusage') });
claudeUsage.start();
registerClaudeUsageTools(claudeUsage);
// The chat reader's hook: each rate_limit_info of a session on its Claude's own sign-in (the raw object, never stored as it came).
chatController.onRateLimit = (sessionId, claudeId, info) => claudeUsage.onRateLimit(sessionId, claudeId, info);
// Usage spend: who spent what (per session, workspace, ticket, persona), budgets with alerts and spike detection, over the recorded requests
// (claude-usage PRD §21 to §26). The chat controller tells it of each recorded turn and each process start, and asks it before a message
// whether a budget a person set to pause is used up. Its pages hear of changes on the `claudeusage` topic; `usageSpend.onAlert` is where
// notifications plug in.
const usageSpend = createUsageSpend({
  store,
  settings: settingsModule.settings,
  personaOf: (id) => {
    const p = personas.personaFor(id).persona;
    return p ? { id: p.poolId, name: p.name, revision: p.revision } : null;
  },
  personaName: (poolId) => {
    try {
      return poolService.get(poolId).name;
    } catch {
      return null; // the persona was deleted: the name recorded then is shown
    }
  },
  workspaceExists: (id) => chatController.workspaceExists?.(id) ?? true,
  notify: () => notify('claudeusage'),
  // Chat sessions store their workspace as the stable id (T-42 slice 3); usage groups by the key.
  workspaceKeyOf: (stored) => workspaces.identities.keyOf(stored) ?? stored,
});
chatController.onUsage = (turn, rows) => usageSpend.onTurn(turn, rows);
// A side question's row (`kind = 'side'`, chat PRD §20) is a request like a turn's: budgets are evaluated and spikes looked for right then, not at the next turn.
chatController.onSideUsage = (turn, rows) => usageSpend.onTurn(turn, rows);
chatController.onLaunch = (info) => usageSpend.onLaunch(info);
chatController.sendGate = (info) => usageSpend.gate(info);
registerUsageSpendTools(usageSpend);
// Workspace git: the repositories inside each running workspace, found by scanning and tracked each on its own, with worktrees, an audit
// and a summary (workspace-git PRD). It reads through the chat's hardened session host; a scan never fetches.
const repos = createRepos({ store, workspaces, installHost: (id) => chatController.installHost?.(id) ?? Promise.resolve(), sessions: chatController, scrub: (id, text) => chatController.scrub(id, text), notify: () => notify('repos') });
repos.start();
registerRepoTools(repos);
// Glance widgets: what waits on a person (approvals, tickets, failed CI) and who is working, counted once for every open page; the chat
// controller's events feed it directly, tickets and CI changes are chained onto the hooks that already tell their own pages (docs/prd/glance-widgets.md).
const glance = createGlance({ chat: chatController, tickets, ci, notify: () => notify('glance'), watching: () => live.watching('glance') });
for (const source of [tickets, ci]) {
  const was = source.onChange;
  source.onChange = () => (was?.(), glance.changed());
}
// GitHub Codespaces POC: GitHub connections (token or device flow with a client ID only; the token is a sealed secret) and the codespace
// lifecycle through GitHub's REST API (docs/prd/codespaces-poc.md).
const codespaces = createCodespaces({ store, pools: poolService, values: secretsKind.values, dataDir: config.paths.data });
// The platform track (docs/prd/platform-roadmap.md phase 1): one event bus over the seams above (chat, CI, usage alerts, spend alerts,
// tickets), the platform audit, and notifications (Web Push, webhook, Discord, Slack); triggers and auto transfer register inside platform/.
const platform = createPlatform({
  store,
  settings: settingsModule.settings,
  chat: chatController,
  ci,
  claudeUsage,
  usageSpend,
  tickets,
  ticketInfo: (id) => {
    const t = tickets.brief(id) ? tickets.get({ kind: 'system' }, id, { eventsLimit: 1 }).ticket : null;
    return t ? { type: t.type, workspaceId: t.workspaceId, open: t.closedAt === null } : null;
  },
  uiUrl: config.portalMcp.uiUrl ?? null,
  pushContact: config.notify.pushContact ?? null,
  selfOrigin: `http://localhost:${config.port}`,
  publish: (topic) => notify(topic),
  socketAuthorized: (req) => !!portal.session(cookie(req, config.session.cookie)),
});
live.onPresence = (connection, presence, req) => platform.presence(connection, presence, req);
platform.start();
const app = createApp(portal, workspaces, store, accounts, pools, reconciler, health, chatController, { serveWeb: !config.dev, notify, poolService, mcp: mcpSets, skills, personas, settings: settingsModule, secrets: secretRotations, portalMcp, knowledge, tickets, ci, browser, claudeUsage, usageSpend, repos, glance, codespaces, platform, claudeVersions, connect });
const handleApi = getRequestListener(app.fetch);
const server = createServer();
// Before the socket modules: ties their connections to the sign-in that opened them (QA-001) and drops unanswered upgrades.
const sockets = new SocketGuard(portal, config.session.cookie);
sockets.attach(server);
portal.onRevoked = () => sockets.sweep();
// The agents' tunnel (`/connect/v1/tunnel`): no cookie, its own handshake; answers only its own path.
connect.attach(server, portal);
attachShell(server, portal, workspaces);
browser.attach(server, portal);
live.attach(server);
attachChat(server, chatController, (req) => !!portal.session(cookie(req, config.session.cookie)));

if (config.dev) {
  // One port for everything: the API through Hono, the rest through Vite (with HMR on this server).
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({
    root: config.paths.web,
    configFile: `${config.paths.web}/vite.config.ts`,
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  server.on('request', (req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/') || url === '/healthz' || url === '/mcp' || url.startsWith('/mcp?') || url.startsWith('/hooks/') || url.startsWith('/connect/')) void handleApi(req, res);
    else vite.middlewares(req, res);
  });
} else {
  server.on('request', (req, res) => void handleApi(req, res));
}

server.listen(config.port, config.host, () => {
  const where = `http://localhost:${config.port}`;
  const code =
    portal.source === 'env' ? '(from PORTAL_SERVER_CODE)' : formatCode(portal.code);
  console.log(
    [
      '',
      `  portal ${config.dev ? 'dev' : 'production'} server on ${where}`,
      `  server code: ${code}`,
      '',
    ]
      .filter((line, i, all) => line || i === 0 || i === all.length - 1)
      .join('\n'),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    refRewrite.abort();
    clearInterval(backupTimer);
    claudeVersions.stop();
    reconciler.stop();
    browser.stop();
    outbox.stop();
    health.stop();
    live.close();
    sockets.close();
    chatController.stop();
    portalMcp.stop();
    tickets.stop();
    ci.stop();
    claudeUsage.stop();
    repos.stop();
    glance.stop();
    platform.stop();
    codespaces.stop();
    connect.stop();
    knowledge.stop();
    for (const stop of stopWatching) stop();
    store.close();
    process.exit(0); // releases the data-dir lock
  });
