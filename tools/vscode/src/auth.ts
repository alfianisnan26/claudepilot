// Signing in and out (docs/prd/vscode-extension.md §4). The token lives in SecretStorage only (the OS keychain on desktop, the host's
// secret store on the web): never in settings, a file, the global state or a log.

import * as vscode from 'vscode';
import { PortalClient, PortalError, checkPortalUrl, compat, pollForToken } from './api.js';
import { redact } from './redact.js';

/**
 * The token's key in SecretStorage names the portal it was issued by: a token is only ever sent to the portal that issued it, so pointing
 * the setting at another address (by mistake, or a settings file someone else wrote) never sends the old token there.
 */
const SECRET_PREFIX = 'claudepilot.token:';
export const secretKeyFor = (origin: string): string => `${SECRET_PREFIX}${origin}`;

export class Auth {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  #client: PortalClient | null = null;
  #signedIn = false;
  #warnedApi: number | null = null;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    ctx.subscriptions.push(
      this.#changed,
      ctx.secrets.onDidChange((e) => {
        if (e.key.startsWith(SECRET_PREFIX)) void this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudepilot.portalUrl')) {
          this.#client = null;
          void this.refresh();
        }
      }),
    );
  }

  get signedIn(): boolean {
    return this.#signedIn;
  }

  /** The portal address from the settings, checked (https, or http on this machine only). */
  portalUrl(): { ok: true; url: string } | { ok: false; reason: string } {
    return checkPortalUrl(vscode.workspace.getConfiguration('claudepilot').get<string>('portalUrl') ?? '');
  }

  /** The client for the current address; null (with the reason logged once) when the address is not allowed. */
  client(): PortalClient | null {
    if (this.#client) return this.#client;
    const url = this.portalUrl();
    if (!url.ok) {
      this.log.warn(`portal address refused: ${url.reason}`);
      return null;
    }
    this.#client = new PortalClient({
      baseUrl: url.url,
      token: () => Promise.resolve(this.ctx.secrets.get(secretKeyFor(url.url))),
      onApiVersion: (api) => this.#apiSeen(api),
    });
    return this.#client;
  }

  #apiSeen(api: number): void {
    const c = compat({ api, minApi: 1 });
    if (c.ok || this.#warnedApi === api) return;
    this.#warnedApi = api;
    void vscode.window.showWarningMessage(c.reason);
  }

  /** The key of the token for the portal now set, or null when the address is not allowed. */
  #key(): string | null {
    const url = this.portalUrl();
    return url.ok ? secretKeyFor(url.url) : null;
  }

  async refresh(): Promise<void> {
    const had = this.#signedIn;
    const key = this.#key();
    this.#signedIn = !!key && !!(await this.ctx.secrets.get(key));
    await vscode.commands.executeCommand('setContext', 'claudepilot.signedIn', this.#signedIn);
    if (had !== this.#signedIn) this.#changed.fire();
  }

  /** A 401 from any call: the token was revoked or expired. It is dropped, and the person is asked to sign in again. */
  async lost(): Promise<void> {
    const key = this.#key();
    if (!key || !(await this.ctx.secrets.get(key))) return;
    await this.ctx.secrets.delete(key);
    this.log.info('the portal refused the token (revoked or expired); signed out');
    await this.refresh();
    const pick = await vscode.window.showWarningMessage('Signed out of the portal.', 'Sign In');
    if (pick === 'Sign In') await this.signIn();
  }

  async signIn(): Promise<void> {
    const client = this.client();
    if (!client) {
      const url = this.portalUrl();
      void vscode.window.showErrorMessage(url.ok ? 'The portal address is not set.' : url.reason, 'Settings').then((pick) => {
        if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'claudepilot.portalUrl');
      });
      return;
    }
    try {
      const v = await client.version();
      const c = compat(v);
      if (!c.ok) {
        void vscode.window.showErrorMessage(c.reason);
        return;
      }
      const name = `${vscode.env.appName}${vscode.env.remoteName ? ` (${vscode.env.remoteName})` : ''}`;
      const start = await client.startDevice(name);
      // The page is built from the address in the settings, never from what the server says: the link always goes to the portal you set.
      const verify = vscode.Uri.parse(`${client.pageUrl('/admin/vscode')}?code=${encodeURIComponent(start.userCode)}`);
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Approve code ${start.userCode} in the portal`, cancellable: true },
        async (_p, cancel) => {
          void vscode.window.showInformationMessage(`Your code: ${start.userCode}. Approve it in the portal, signed in.`, 'Open Portal', 'Copy Code').then(async (pick) => {
            if (pick === 'Open Portal') await vscode.env.openExternal(await vscode.env.asExternalUri(verify));
            if (pick === 'Copy Code') await vscode.env.clipboard.writeText(start.userCode);
          });
          return pollForToken(client, start, { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), cancelled: () => cancel.isCancellationRequested });
        },
      );
      if (!outcome.ok) {
        if (outcome.reason !== 'cancelled') void vscode.window.showWarningMessage(outcome.reason === 'denied' ? 'The sign-in was denied in the portal.' : 'The code expired. Sign in again.');
        return;
      }
      await this.ctx.secrets.store(secretKeyFor(client.baseUrl), outcome.token);
      this.log.info(`signed in to ${client.baseUrl} (token ${outcome.tokenId}, until ${outcome.expiresAt})`);
      await this.refresh();
      void vscode.window.showInformationMessage('Signed in to the portal.');
    } catch (e) {
      this.log.error(`sign-in failed: ${redact(e instanceof Error ? e.message : String(e))}`);
      void vscode.window.showErrorMessage(e instanceof PortalError ? e.message : 'The sign-in failed.');
    }
  }

  async signOut(): Promise<void> {
    const client = this.client();
    const key = this.#key();
    try {
      // The portal revokes the token, so a copy of it anywhere is dead too.
      if (client && key && (await this.ctx.secrets.get(key))) await client.logout();
    } catch (e) {
      this.log.warn(`the portal did not confirm the sign-out: ${redact(e instanceof Error ? e.message : String(e))}`);
    }
    if (key) await this.ctx.secrets.delete(key);
    this.log.info('signed out');
    await this.refresh();
  }
}
