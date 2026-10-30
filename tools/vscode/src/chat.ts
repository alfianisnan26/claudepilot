// The Chat view (docs/prd/vscode-extension.md §7): one agent's transcript and a box to send to it. The page has a strict CSP: nothing but
// the extension's own script (by nonce) and stylesheet, no inline script, no remote anything, no network from the page (the extension
// does every call). Everything from the portal is put in the page as text (`textContent` in media/chat.js), never as HTML.

import * as vscode from 'vscode';
import { VSCODE_SEND_MAX, type VscodeEvent } from '../../../packages/contracts/src/vscode.js';
import { chatHtml, nonce } from './page.js';
import { PortalError } from './api.js';
import type { Auth } from './auth.js';
import { redact } from './redact.js';

export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'claudepilot.chat';
  #view: vscode.WebviewView | null = null;
  #agent: { id: string; title: string } | null = null;
  #lastSeq = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly auth: Auth,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media], enableForms: false } as vscode.WebviewOptions;
    view.webview.html = chatHtml({
      cspSource: view.webview.cspSource,
      nonce: nonce(),
      script: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js')).toString(),
      style: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css')).toString(),
    });
    view.webview.onDidReceiveMessage((m: unknown) => void this.#received(m));
    view.onDidChangeVisibility(() => (view.visible ? this.#poll(true) : this.#stop()));
    view.onDidDispose(() => {
      this.#view = null;
      this.#stop();
    });
    if (this.#agent) this.#show();
  }

  /** Points the view at an agent and brings it forward. */
  async open(agent: { id: string; title: string }): Promise<void> {
    this.#agent = agent;
    this.#lastSeq = 0;
    await vscode.commands.executeCommand(`${ChatView.id}.focus`);
    this.#show();
  }

  #show(): void {
    if (!this.#view || !this.#agent) return;
    void this.#view.webview.postMessage({ type: 'reset', title: this.#agent.title });
    this.#poll(true);
  }

  #stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #poll(now = false): void {
    this.#stop();
    if (!this.#view?.visible || !this.#agent) return;
    this.#timer = setTimeout(() => void this.#load(), now ? 0 : 2500);
  }

  async #load(): Promise<void> {
    const agent = this.#agent;
    const client = this.auth.client();
    if (!agent || !client || this.#busy) return this.#poll();
    this.#busy = true;
    try {
      const r = await client.events(agent.id, this.#lastSeq || undefined);
      if (agent !== this.#agent) return;
      const fresh: VscodeEvent[] = r.events.filter((e) => e.seq > this.#lastSeq);
      this.#lastSeq = Math.max(this.#lastSeq, r.lastSeq, ...fresh.map((e) => e.seq));
      void this.#view?.webview.postMessage({ type: 'events', title: r.title, state: r.state, events: fresh });
    } catch (e) {
      if (e instanceof PortalError && e.signedOut) {
        void this.auth.lost();
        return;
      }
      void this.#view?.webview.postMessage({ type: 'error', text: e instanceof PortalError ? e.message : 'Could not load the chat.' });
    } finally {
      this.#busy = false;
      this.#poll();
    }
  }

  /** What the page may ask: send one message. Anything else is ignored. */
  async #received(m: unknown): Promise<void> {
    if (!m || typeof m !== 'object' || (m as { type?: unknown }).type !== 'send') return;
    const text = (m as { text?: unknown }).text;
    const agent = this.#agent;
    const client = this.auth.client();
    if (typeof text !== 'string' || !text.trim() || text.length > VSCODE_SEND_MAX || !agent || !client) return;
    try {
      await client.send(agent.id, text, crypto.randomUUID());
      void this.#view?.webview.postMessage({ type: 'sent' });
      this.#poll(true);
    } catch (e) {
      if (e instanceof PortalError && e.signedOut) return void this.auth.lost();
      this.log.warn(`send failed: ${redact(e instanceof Error ? e.message : String(e))}`);
      void this.#view?.webview.postMessage({ type: 'error', text: e instanceof PortalError ? e.message : 'Could not send.' });
    }
  }

  dispose(): void {
    this.#stop();
  }
}
