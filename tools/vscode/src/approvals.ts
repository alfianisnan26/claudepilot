// Approvals (docs/prd/vscode-extension.md §6): a new request arrives as a notification with Review, Deny and Open in Portal. Slice 1 never
// allows from VS Code (review R2, decided): the person allows in the portal; Review shows the WHOLE text read-only, and Deny goes to the
// portal's own rules.

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
      void vscode.window.showWarningMessage(approvalHeadline(a), 'Review', 'Deny', 'Open in Portal').then((pick) => {
        if (pick === 'Review') void this.review(a);
        if (pick === 'Deny') void this.#deny(a);
        if (pick === 'Open in Portal') void this.#portal(a);
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

  /** Opens the whole text read-only, then asks: Deny here, or Open in Portal to allow it there. */
  async review(a: VscodeApproval): Promise<void> {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(a.sessionId)}/${encodeURIComponent(a.requestId)}.txt` });
    this.#docs.set(uri.toString(), approvalDocument(a));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    const pick = await vscode.window.showWarningMessage(
      approvalHeadline(a),
      { modal: true, detail: 'The whole request is open in the editor. Deny it here, or open it in the portal to allow it.' },
      'Deny',
      'Open in Portal',
    );
    if (pick === 'Deny') await this.#deny(a);
    if (pick === 'Open in Portal') await this.#portal(a);
  }

  async #portal(a: VscodeApproval): Promise<void> {
    const client = this.auth.client();
    if (client) await vscode.env.openExternal(await vscode.env.asExternalUri(vscode.Uri.parse(client.pageUrl(a.url))));
  }

  async #deny(a: VscodeApproval): Promise<void> {
    const client = this.auth.client();
    if (!client) return;
    try {
      await client.deny(a.sessionId, { requestId: a.requestId });
      void vscode.window.showInformationMessage('Denied.');
    } catch (e) {
      if (e instanceof PortalError && e.signedOut) return void this.auth.lost();
      this.log.warn(`deny failed: ${redact(e instanceof Error ? e.message : String(e))}`);
      void vscode.window.showErrorMessage(e instanceof PortalError ? e.message : 'The answer failed.');
    } finally {
      void this.poller.refresh();
    }
  }

  dispose(): void {
    for (const d of this.#disposables) d.dispose();
  }
}
