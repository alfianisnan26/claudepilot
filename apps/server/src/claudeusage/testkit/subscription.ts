// A scratch Claude whose directory holds a clearly fake claude.ai login, so the real Claude Code CLI behaves as a
// subscription account (Pro, Max, ...) for usage, profile and connector calls, with no sign-in and no real token.
// Every value here is obviously fake (`FAKE-...`, `example.invalid`) and lives in a temporary directory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeClaude {
  /** The HOME to run Claude Code with. */
  home: string;
  /** The Claude's directory the way the portal names it: '' for Default, else `claudes/<16 hex>`. */
  directory: string;
  /** `CLAUDE_CONFIG_DIR` for a Claude that has one; undefined for Default (Claude Code's own home). */
  configDir: string | undefined;
  remove(): void;
}

export interface FakeClaudeOptions {
  /** `claudes/<16 hex>` for a named Claude; '' (the default) for Default. */
  directory?: string;
  /** The tier a login carries: pro, max, team, enterprise. */
  plan?: string;
  /** OAuth scopes; `user:profile` is what usage needs, `user:mcp_servers` what the claude.ai connectors need. */
  scopes?: string[];
  /** No login at all: an empty directory. */
  signedOut?: boolean;
}

export const FAKE_ACCOUNT = { email: 'fake-user@example.invalid', org: 'Fake Org (test)' } as const;

/** Makes a temporary HOME with a fake login for one Claude. */
export function makeFakeClaude(opts: FakeClaudeOptions = {}): FakeClaude {
  const home = mkdtempSync(join(tmpdir(), 'cp-fake-claude-'));
  const directory = opts.directory ?? '';
  const configDir = directory ? join(home, '.claudepilot', directory) : undefined;
  const credentialsDir = configDir ?? join(home, '.claude');
  const accountFile = configDir ? join(configDir, '.claude.json') : join(home, '.claude.json');
  mkdirSync(credentialsDir, { recursive: true });
  if (!opts.signedOut) {
    writeFileSync(
      join(credentialsDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'FAKE-test-access-token-not-real',
          refreshToken: 'FAKE-test-refresh-token-not-real',
          expiresAt: 4102444800000,
          scopes: opts.scopes ?? ['user:inference', 'user:profile'],
          subscriptionType: opts.plan ?? 'max',
          rateLimitTier: 'default_claude_max_5x',
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      accountFile,
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: {
          accountUuid: '00000000-0000-4000-8000-000000000001',
          emailAddress: FAKE_ACCOUNT.email,
          organizationUuid: '00000000-0000-4000-8000-000000000002',
          organizationName: FAKE_ACCOUNT.org,
          displayName: 'Fake',
        },
      }),
    );
  }
  return { home, directory, configDir, remove: () => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
