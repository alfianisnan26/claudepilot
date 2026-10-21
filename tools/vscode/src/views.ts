// The trees (Agents, Tickets, Workspaces) and the status bar, fed by one poller. Everything shown is plain text: labels, descriptions
// and tooltips are strings (never MarkdownString), so a title an agent wrote can't carry a link or markup.

import * as vscode from 'vscode';
import type { VscodeAgent, VscodeApproval, VscodeStatus, VscodeTicket, VscodeWorkspace } from '../../../packages/contracts/src/vscode.js';
import { PortalError } from './api.js';
import type { Auth } from './auth.js';
import { STATE_ICON, TICKET_STATUS_LABEL, agentDescription, agentTree, oneLine, statusView, ticketGroups, type AgentNode } from './model.js';
import { redact } from './redact.js';

export interface Snapshot {
  agents: VscodeAgent[] | null;
  tickets: VscodeTicket[] | null;
  workspaces: VscodeWorkspace[] | null;
  status: VscodeStatus | null;
  approvals: VscodeApproval[] | null;
  error: string | null;
}

/** One refresh of everything, every `claudepilot.pollSeconds`, and on demand. */
export class Poller implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<Snapshot>();
  readonly onDidChange = this.#changed.event;
  snapshot: Snapshot = { agents: null, tickets: null, workspaces: null, status: null, approvals: null, error: null };
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #disposed = false;

  constructor(
    private readonly auth: Auth,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  start(): void {
    void this.refresh();
  }

  #schedule(): void {
    if (this.#disposed) return;
    if (this.#timer) clearTimeout(this.#timer);
    const s = Math.min(300, Math.max(5, vscode.workspace.getConfiguration('claudepilot').get<number>('pollSeconds') ?? 15));
    this.#timer = setTimeout(() => void this.refresh(), s * 1000);
  }

  async refresh(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const client = this.auth.signedIn ? this.auth.client() : null;
      if (!client) {
        this.snapshot = { agents: null, tickets: null, workspaces: null, status: null, approvals: null, error: null };
      } else {
        const [agents, tickets, workspaces, status, approvals] = await Promise.allSettled([client.agents(), client.tickets(), client.workspaces(), client.status(), client.approvals()]);
        const failed = [agents, tickets, workspaces, status, approvals].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (failed && failed.reason instanceof PortalError && failed.reason.signedOut) {
          await this.auth.lost();
          return;
        }
        const val = <T>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
        const error = failed ? (failed.reason instanceof Error ? failed.reason.message : 'The portal did not answer.') : null;
        if (error) this.log.warn(`refresh: ${redact(error)}`);
        this.snapshot = { agents: val(agents), tickets: val(tickets), workspaces: val(workspaces), status: val(status), approvals: val(approvals), error };
      }
      this.#changed.fire(this.snapshot);
    } finally {
      this.#running = false;
      this.#schedule();
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#changed.dispose();
  }
}

/** What a tree item carries for the commands (Open in Portal, Open Chat). */
export class Item extends vscode.TreeItem {
  constructor(
    label: string,
    state: vscode.TreeItemCollapsibleState,
    readonly url: string | null = null,
    readonly agent: VscodeAgent | null = null,
    readonly kids: Item[] = [],
  ) {
    super(label, state);
  }
}

const message = (text: string) => new Item(text, vscode.TreeItemCollapsibleState.None);

export class AgentsTree implements vscode.TreeDataProvider<Item> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  #roots: Item[] = [];

  update(s: Snapshot): void {
    if (!s.agents) this.#roots = s.error ? [message(oneLine(s.error, 120))] : [];
    else if (s.agents.length === 0) this.#roots = [message('No agents running')];
    else this.#roots = agentTree(s.agents).map((n) => this.#item(n));
    this.#changed.fire();
  }

  #item(n: AgentNode): Item {
    const a = n.agent;
    const kids = n.children.map((c) => this.#item(c));
    const item = new Item(oneLine(a.title || a.id, 80), kids.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None, a.url, a, kids);
    item.id = a.id;
    item.description = agentDescription(a);
    item.tooltip = [oneLine(a.title, 200), `${a.workspaceId}${a.claudeName ? ` · ${a.claudeName}` : ''}`, a.agent ? `Role: ${a.agent}` : null, `Last active ${new Date(a.lastActivityAt).toLocaleString()}`]
      .filter(Boolean)
      .join('\n');
    item.iconPath = new vscode.ThemeIcon(STATE_ICON[a.state] ?? 'circle-outline');
    item.contextValue = 'agent';
    item.command = { command: 'claudepilot.openChat', title: 'Open Chat', arguments: [item] };
    return item;
  }

  getTreeItem = (e: Item) => e;
  getChildren = (e?: Item) => (e ? e.kids : this.#roots);
}

export class TicketsTree implements vscode.TreeDataProvider<Item> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  #roots: Item[] = [];

  update(s: Snapshot): void {
    if (!s.tickets) this.#roots = s.error && s.agents === null ? [message(oneLine(s.error, 120))] : [];
    else if (s.tickets.length === 0) this.#roots = [message('No open tickets')];
    else
      this.#roots = ticketGroups(s.tickets).map((g) => {
        const statuses = g.statuses.map((st) => {
          const tickets = st.tickets.map((t) => {
            const it = new Item(`${t.key} ${oneLine(t.summary, 100)}`, vscode.TreeItemCollapsibleState.None, t.url);
            it.id = `ticket:${t.id}`;
            it.description = t.priority === 'normal' ? undefined : t.priority;
            it.tooltip = `${t.key} · ${t.type} · ${t.priority}\n${oneLine(t.summary, 300)}`;
            it.contextValue = 'ticket';
            it.iconPath = new vscode.ThemeIcon(t.priority === 'urgent' ? 'flame' : t.priority === 'high' ? 'arrow-up' : 'issues');
            it.command = { command: 'claudepilot.openInPortal', title: 'Open in Portal', arguments: [it] };
            return it;
          });
          const node = new Item(TICKET_STATUS_LABEL[st.status], st.status === 'done' || st.status === 'wont_do' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded, null, null, tickets);
          node.id = `status:${g.bucket}:${st.status}`;
          node.description = String(st.tickets.length);
          return node;
        });
        const b = new Item(g.bucket, vscode.TreeItemCollapsibleState.Expanded, null, null, statuses);
        b.id = `bucket:${g.bucket}`;
        b.description = String(g.count);
        b.iconPath = new vscode.ThemeIcon('folder');
        return b;
      });
    this.#changed.fire();
  }

  getTreeItem = (e: Item) => e;
  getChildren = (e?: Item) => (e ? e.kids : this.#roots);
}

export class WorkspacesTree implements vscode.TreeDataProvider<Item> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  #roots: Item[] = [];

  update(s: Snapshot): void {
    this.#roots = (s.workspaces ?? []).map((w) => {
      const it = new Item(oneLine(w.name, 60), vscode.TreeItemCollapsibleState.None, w.url);
      it.id = `ws:${w.id}`;
      it.description = `${w.target} · ${w.status}`;
      it.tooltip = w.id;
      it.contextValue = 'workspace';
      it.iconPath = new vscode.ThemeIcon(w.status === 'running' ? 'vm-running' : 'vm-outline');
      return it;
    });
    this.#changed.fire();
  }

  getTreeItem = (e: Item) => e;
  getChildren = (e?: Item) => (e ? e.kids : this.#roots);
}

export class StatusBar implements vscode.Disposable {
  readonly #item = vscode.window.createStatusBarItem('claudepilot.status', vscode.StatusBarAlignment.Right, 100);

  constructor(private readonly auth: Auth) {
    this.#item.name = 'ClaudePilot';
    this.#item.show();
    this.update(null);
  }

  update(s: Snapshot | null): void {
    const v = statusView(s?.status ?? null, { signedIn: this.auth.signedIn, error: s?.error ?? null });
    this.#item.text = v.text;
    this.#item.tooltip = v.tooltip;
    this.#item.backgroundColor = v.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.#item.command = this.auth.signedIn ? 'claudepilot.approvals' : 'claudepilot.signIn';
  }

  dispose(): void {
    this.#item.dispose();
  }
}
