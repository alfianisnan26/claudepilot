// ClaudePilot for VS Code (docs/prd/vscode-extension.md). One bundle for the desktop and the web extension host: stable API only, no
// Node-only module anywhere in it (tsconfig has no Node types; esbuild bundles for a neutral platform).

import * as vscode from 'vscode';
import { Approvals } from './approvals.js';
import { Auth } from './auth.js';
import { ChatView } from './chat.js';
import { AgentsTree, Poller, StatusBar, TicketsTree, WorkspacesTree, type Item } from './views.js';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('ClaudePilot', { log: true });
  const auth = new Auth(ctx, log);
  const poller = new Poller(auth, log);
  const agents = new AgentsTree();
  const tickets = new TicketsTree();
  const workspaces = new WorkspacesTree();
  const status = new StatusBar(auth);
  const approvals = new Approvals(auth, poller, log);
  const chat = new ChatView(ctx, auth, log);

  ctx.subscriptions.push(
    log,
    poller,
    status,
    approvals,
    chat,
    vscode.window.registerTreeDataProvider('claudepilot.agents', agents),
    vscode.window.registerTreeDataProvider('claudepilot.tickets', tickets),
    vscode.window.registerTreeDataProvider('claudepilot.workspaces', workspaces),
    vscode.window.registerWebviewViewProvider(ChatView.id, chat, { webviewOptions: { retainContextWhenHidden: false } }),
    poller.onDidChange((s) => {
      agents.update(s);
      tickets.update(s);
      workspaces.update(s);
      status.update(s);
    }),
    auth.onDidChange(() => void poller.refresh()),
    vscode.commands.registerCommand('claudepilot.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('claudepilot.signOut', () => auth.signOut()),
    vscode.commands.registerCommand('claudepilot.refresh', () => poller.refresh()),
    vscode.commands.registerCommand('claudepilot.approvals', () => approvals.pick()),
    vscode.commands.registerCommand('claudepilot.openChat', (item?: Item) => {
      if (item?.agent) return chat.open({ id: item.agent.id, title: item.agent.title });
    }),
    vscode.commands.registerCommand('claudepilot.openInPortal', async (item?: Item) => {
      const client = auth.client();
      if (!client || !item?.url) return;
      await vscode.env.openExternal(await vscode.env.asExternalUri(vscode.Uri.parse(client.pageUrl(item.url))));
    }),
  );

  await auth.refresh();
  poller.start();
}

export function deactivate(): void {
  // everything is in the context's subscriptions
}
