# B2 status (providers: research, definitions, stand-in server) - 2026-10-12  DONE
Built: providers/{github,gitlab,gitea,outline,cloudflare,common,index}.ts (+ providers.test.ts, 11 tests); testkit/{types,presets,provider,cert,cli,build,index}.ts (+ provider.test.ts, 25 tests); docs/prd/mcp-providers.md (facts with marks).
Verified: probes of the real hosts (A.7 rules); B1's registry accepts all five (B1's 25 builtin tests pass with them); kit driven by the real MCP SDK client; kit + real Claude Code 2.1.296 in a throwaway container (removed); full server suite 1316 tests, 1301 pass, 14 skipped, 1 fail (B3 mcp/oauth signin.test.ts, passes alone); root typecheck clean.
Not verified (needs a real account): PRD section 9 (GitLab PAT, Gitea round trip, Outline/Cloudflare sign-in, GitHub PAT types, consent screens).
Decisions: callbackPort 24819; cf- key prefix; GitHub token-only no host param; GitLab token mode kept but flagged unconfirmed; Gitea scopes pinned + OIDC authServerMetadataUrl; conventional secret names; kit = TS + esbuild bundle.
Cleanup done: container bp-ws removed, /tmp/bp-* removed, probe scratch dir removed; no portal/tmux/images of mine remain.
RESUME HERE: nothing pending. If asked: re-probe providers with the PRD section 2 recipe and bump template `version`/`checkedAt` when a fact changes.
