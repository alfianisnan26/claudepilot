// Approvals (docs/prd/vscode-extension.md §6): a new request arrives as a notification; Allow is offered only after the WHOLE text is
// open in a read-only editor, and only when the portal says it may be allowed (a cut or empty request can only be denied). The answer
// goes to the portal with the hash of the text that was shown, and the portal applies the same rules as the web on top.

import * as vscode from 'vscode';
import type { VscodeApproval } from '../../../packages/contracts/src/vscode.js';
import { PortalError } from './api.js';
import type { Auth } from './auth.js';
import { approvalDocument, approvalHeadline, oneLine } from './model.js';
import { redact } from './redact.js';
import type { Poller } from './views.js';

const SCHEME = 'claudepilot-approval';

export class Approvals implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly #seen = new Set<string>();
  readonly #docs = new Map<string, string>();
  readonly #disposables: vscode.Disposable[] = [];
  #latest: VscodeApproval[] = [];

  constructor(
    private readonly auth: Auth,
    private readonly poller: Poller,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.#disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      poller.onDidChange((s) => {
        if (s.approvals) this.#arrived(s.approvals);
      }),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#docs.get(uri.toString()) ?? 'This request is no longer open.\n';
  }

  #key = (a: VscodeApproval) => `${a.sessionId}/${a.requestId}`;

  #arrived(list: VscodeApproval[]): void {
    this.#latest = list;
    for (const a of list) {
      const k = this.#key(a);
      if (this.#seen.has(k)) continue;
      this.#seen.add(k);
      void vscode.window.showWarningMessage(approvalHeadline(a), 'Review', 'Deny').then((pick) => {
        if (pick === 'Review') void this.review(a);
        if (pick === 'Deny') void this.#answer(a, 'deny');
      });
    }
  }

  /** The status bar's click: what waits now. */
  async pick(): Promise<void> {
    await this.poller.refresh();
    const list = this.#latest;
    if (list.length === 0) {
      void vscode.window.showInformationMessage('Nothing waits for an approval.');
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      list.map((a) => ({ label: oneLine(a.title, 80), description: oneLine(a.sessionTitle, 60), detail: a.full ? oneLine(a.full, 120) : undefined, a })),
      { title: 'Approvals', placeHolder: 'Pick one to review' },
    );
    if (chosen) await this.review(chosen.a);
  }

  /** Opens the whole text, then asks. Allow is a button only when the portal says the request may be allowed. */
  async review(a: VscodeApproval): Promise<void> {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(a.sessionId)}/${encodeURIComponent(a.requestId)}.txt` });
    this.#docs.set(uri.toString(), approvalDocument(a));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    const buttons = a.allowable ? ['Allow', 'Deny'] : ['Deny'];
    const pick = await vscode.window.showWarningMessage(
      a.allowable ? `Allow this request? ${approvalHeadline(a)}` : `${a.note ?? 'This can’t be allowed.'} Deny it?`,
      { modal: true, detail: 'The whole request is open in the editor. Read it there before you answer.' },
      ...buttons,
    );
    if (pick === 'Allow' && a.allowable) await this.#answer(a, 'allow');
    if (pick === 'Deny') await this.#answer(a, 'deny');
  }

  async #answer(a: VscodeApproval, decision: 'allow' | 'deny'): Promise<void> {
    const client = this.auth.client();
    if (!client) return;
    try {
      await client.respond(a.sessionId, { requestId: a.requestId, decision, ...(decision === 'allow' && a.fullSha256 ? { fullSha256: a.fullSha256 } : {}) });
      void vscode.window.showInformationMessage(decision === 'allow' ? 'Allowed.' : 'Denied.');
    } catch (e) {
      if (e instanceof PortalError && e.signedOut) return void this.auth.lost();
      this.log.warn(`answer failed: ${redact(e instanceof Error ? e.message : String(e))}`);
      void vscode.window.showErrorMessage(e instanceof PortalError ? e.message : 'The answer failed.');
    } finally {
      void this.poller.refresh();
    }
  }

  dispose(): void {
    for (const d of this.#disposables) d.dispose();
  }
}
