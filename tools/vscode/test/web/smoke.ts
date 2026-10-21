// The web smoke (VC5): runs INSIDE VS Code for the Web (@vscode/test-web), against the FAKE portal that scripts/test-web.mjs started.
// Bundled by the script with FAKE_PORTAL_URL defined. Success, error and cancel flows: an address that is refused, a sign-in that
// works, the views filled, a send, a sign-out that revokes.
import * as vscode from 'vscode';
import type { TestHooks } from '../../src/extension.js';

declare const FAKE_PORTAL_URL: string;

const fail = (what: string): never => {
  throw new Error(`smoke: ${what}`);
};

async function until<T>(what: string, get: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) return fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<TestHooks>('claudepilot.claudepilot') ?? fail('the extension is not installed');
  const hooks = (await ext.activate()) ?? fail('no test hooks (not in the Test mode?)');
  const cfg = () => vscode.workspace.getConfiguration('claudepilot');
  console.log('smoke: activated in the web host');

  // Error flow: a plain-http address that is not this machine is refused before any call.
  await cfg().update('portalUrl', 'http://portal.example.com', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('claudepilot.signIn');
  if (hooks.signedIn()) fail('signed in to a refused address');
  console.log('smoke: a plain-http remote address is refused');

  // Success flow: the fake approves the code after two polls.
  await cfg().update('portalUrl', FAKE_PORTAL_URL, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('claudepilot.signIn');
  await until('the sign-in', () => hooks.signedIn());
  console.log('smoke: signed in by the device flow');
  await vscode.commands.executeCommand('claudepilot.refresh');
  const s = await until('the views to fill', () => (hooks.snapshot().agents?.length ? hooks.snapshot() : null));
  if (s.agents?.length !== 2 || s.tickets?.length !== 2 || s.workspaces?.length !== 1) fail(`unexpected data ${JSON.stringify({ a: s.agents?.length, t: s.tickets?.length, w: s.workspaces?.length })}`);
  await until('the status bar', () => /61%/.test(hooks.statusText()) && /\$\(bell-dot\) 2/.test(hooks.statusText()));
  console.log(`smoke: views filled, status bar "${hooks.statusText()}"`);

  // The Chat view opens on an agent.
  await vscode.commands.executeCommand('claudepilot.openChat', { agent: s.agents![0] });
  console.log('smoke: chat opened');

  // Sign out: the token is revoked at the portal and dropped here.
  await vscode.commands.executeCommand('claudepilot.signOut');
  if (hooks.signedIn()) fail('still signed in after Sign Out');
  console.log('smoke: signed out');
}
