#!/usr/bin/env bash
# One checkpoint: stage per ownership group (explicit paths), skip files touched in the last 3 min, scan the staged diff, commit unsigned, push.
# Usage: commit-cycle.sh [--dry]   Groups: see GROUPS below (name|prefixes (space separated)|subject|body)
set -u
R=/workspaces/claudepilot
C=/tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord
TRAILER='Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'
DRY=${1:-}
retry() { local i; for i in 1 2 3 4 5 6; do out=$("$@" 2>&1) && return 0; case "$out" in *index.lock*) sleep 3;; *) echo "$out" | head -3; return 1;; esac; done; echo "$out" | head -3; return 1; }
cd "$R" || exit 1
git status --porcelain -uall | sed -E 's/^.. //' | grep -v ' -> ' > "$C/.cc-all.txt"
# files touched in the last 3 minutes (owner probably mid-edit) stay out of this checkpoint
: > "$C/.cc-recent.txt"
while read -r f; do [ -f "$f" ] && [ -n "$(find "$f" -mmin -${RECENT_MIN:-3} -print 2>/dev/null)" ] && echo "$f" >> "$C/.cc-recent.txt"; done < "$C/.cc-all.txt"
grep -vxFf "$C/.cc-recent.txt" "$C/.cc-all.txt" > "$C/.cc-todo.txt"
cp "$C/.cc-todo.txt" "$C/.cc-left.txt"
echo "changed: $(wc -l < "$C/.cc-all.txt"), skipped as recent: $(wc -l < "$C/.cc-recent.txt")"
SHAS=()
declare -a GROUPS_DEF
GROUPS_DEF=(
"docs|docs/|docs: PRDs and plans for this round|Product requirement documents and plans written by the build agents: MCP catalogue and providers, workspace git, Connect targets, usage and glance widgets, platform roadmap, triggers, auto transfer, Claude Code version pinning, Codespaces POC, multi-user, identity, authorization, sharing and teams."
"contracts|packages/contracts/src/|contracts: wire types and route tables for the new areas|Types and route tables for MCP catalogue, repos, Connect, usage and budgets, glance, notify, triggers, auto transfer, Claude version, Codespaces, btw, identity, authorization, sharing and teams. The package index is committed with the wiring group."
"server-connect|apps/server/src/connect/ apps/server/scripts/gen-connect|server/connect: outbound-dialing control plane, remote runtimes, agent, installers|Registry and enrollment, transport (yamux-format frames over one WebSocket), remote Docker and Kubernetes runtimes, the dialing agent and its generated bundle, install.sh and install.ps1 with the per-token plan, generator scripts. Not wired into index.ts here."
"server-mcp|apps/server/src/mcp/|server/mcp: built-in catalogue, OAuth status and guided sign-in, jobs and routes|Templates for GitHub, GitLab, Gitea, Outline and Cloudflare, native Claude Code OAuth handling (no tokens held by the portal), connection checks and the catalogue routes."
"server-notify-platform|apps/server/src/notify/ apps/server/src/platform/|server/notify and platform: event bus, channels, Web Push, audit skeleton|Notification core with webhook, Discord, Slack and Web Push adapters, per-event preferences, quiet hours, delivery log, single-use answer tokens for action buttons, and the platform skeleton (bus, audit, owner adapter)."
"server-triggers-autotransfer|apps/server/src/triggers/ apps/server/src/autotransfer/|server/triggers and auto transfer: cron, webhooks, limits, quota-based moves|Scheduler, webhook receivers with signature checks for Gitea, GitHub and GitLab, templates, limits and run history; the auto-transfer decision function and engine. Work in progress by their owners: not wired yet."
"server-usage|apps/server/src/claudeusage/ apps/server/src/usagespend/ apps/server/src/glance/|server/usage and glance: speed, pace, compare, attribution, budgets, spikes, aggregator|Usage engine with measured, estimate and unavailable figures, the Move recommendation, spend attribution, budgets and spike alerts, the usage probe in safe mode, and the glance aggregator with the approval-text fix."
"server-claudeversion|apps/server/src/claudeversion/ apps/server/scripts/gen-canary-kit images/workspace/|server/claudeversion and image: Claude Code version pin and canary|Exact version pin as an image build argument and label, auto-update off, minimum versions per feature with warnings, explicit upgrade with a canary and rollback to the previous image tag."
"server-codespaces|apps/server/src/codespaces/|server/codespaces: GitHub Codespaces as a workspace target (POC, server side)|Device-flow sign-in with a client ID only, REST lifecycle against a stand-in GitHub API, connection metadata kept in the data dir."
"server-repos|apps/server/src/repos/|server/repos: workspace git scanning, tracking, worktrees, audit|Automatic scan of repositories in a workspace including nested and pool repos, tracking, synced worktrees, events and audit."
"server-workspaces|apps/server/src/workspaces/|server/workspaces: runtime seams for remote targets and host exec|Runtime interface changes used by Connect and the Codespaces target, the extracted host exec."
"server-chat|apps/server/src/chat/|server/chat: btw side questions engine, request review text, usage hooks|One-shot side-question runner in a separate safe-mode process, full request text kept next to the short summary, usage and redaction touches."
"server-misc|apps/server/src/portalmcp/ apps/server/src/tickets/ apps/server/src/delivery/ apps/server/src/authz/ apps/server/src/settings/ apps/server/src/browser/ apps/server/src/accounts/|server/misc: Portal MCP, tickets, delivery, authorization seam, settings, browser, accounts|Small touches in existing modules: Portal MCP tools and sanitising, ticket start path, delivery reconciler, the authorization seam with its tests, lockdown settings, browser compile, account pools."
"web-glance|apps/web/src/features/glance/|web/glance: widgets framework and widgets|Quota, Sessions, Active agents, Needs attention and Shortcuts widgets, placements, settings and the approval block."
"web-usage|apps/web/src/features/usage/ apps/web/src/lib/usage/|web/usage: Usage page tabs, charts, attribution, budgets, spikes|Strip and five tabs (Requests, Claudes, Attribution, Budgets, Spikes) with measured, estimate and unavailable figures, colour-blind palette from server slots."
"web-notify|apps/web/src/features/notify/|web/notify: push subscriptions, preferences, history|Notification preferences, events matrix, quiet hours and the in-app history."
"web-chat|apps/web/src/features/chat/|web/chat: btw card, side panel and phone sheet; approval text|btw card above the composer, resizable side panel from 1280 px, phone bottom sheet, pinned btw in the transcript; approvals show the request whole."
"web-repos|apps/web/src/features/repos/|web/repos: Repos tab, repo sheet with timeline, attention chip|Tree of repositories with chips and actions, a repo sheet with remotes, worktrees and a commits and audit timeline."
"web-mcp|apps/web/src/features/mcp/|web/mcp: catalogue shelf, dialogs, status chips|Built-in MCP catalogue shelf with guided OAuth sign-in and status chips."
"web-targets|apps/web/src/features/targets/|web/targets: Connect wizard and Targets page|Wizard for cluster or single host, copy-paste install scripts for Linux, macOS and Windows, live enrollment status."
"web-claudeversion|apps/web/src/features/claudeversion/|web/claudeversion: version chip, pin and upgrade UI|Version shown per workspace, warnings below the minimum, explicit upgrade with canary result."
"web-shared-features|apps/web/src/features/workspaces/ apps/web/src/features/pools/ apps/web/src/features/settings/|web: workspace sheet, pools and settings touches|Details and Repos switch and the attention chip on the workspace list, version chip placement, pool and settings touches."
"web-shell|apps/web/src/app/ apps/web/src/components/ apps/web/src/lib/auth.tsx apps/web/src/lib/live.tsx apps/web/public/|web shell: navigation, shared components, PWA worker and manifest|InfoTip text prop with a 44 px tap area, chart components, app shell, live topics, service worker and manifest shortcuts."
"qa-tools|tools/|tools: QA harnesses and measuring scripts|Headless Chromium harnesses for the btw layout and other checks."
"wiring|apps/server/src/app.ts apps/server/src/index.ts apps/server/src/config.ts apps/server/src/live.ts apps/server/src/live.test.ts apps/server/src/store/ apps/server/package.json packages/contracts/src/index.ts|wiring: app, index, config, live, migrations, package|Shared files that mount the new modules, new config keys, live topics, migrations appended by set, the package script changes."
)
for g in "${GROUPS_DEF[@]}"; do
  IFS='|' read -r name prefixes subject body <<< "$g"
  : > "$C/.cc-g.txt"
  for pre in $prefixes; do grep -E "^${pre//./\\.}" "$C/.cc-todo.txt" >> "$C/.cc-g.txt"; done
  sort -u "$C/.cc-g.txt" -o "$C/.cc-g.txt"
  n=$(wc -l < "$C/.cc-g.txt")
  [ "$n" -eq 0 ] && { echo "[$name] nothing"; continue; }
  grep -vxFf "$C/.cc-g.txt" "$C/.cc-left.txt" > "$C/.cc-left2.txt"; cp "$C/.cc-left2.txt" "$C/.cc-left.txt"
  if [ "$DRY" = "--dry" ]; then echo "[$name] would stage $n"; continue; fi
  mapfile -t files < "$C/.cc-g.txt"
  retry git add -- "${files[@]}" || { echo "[$name] git add failed"; continue; }
  if ! (git diff --cached -U0 | (cd apps/server && npx tsx "$C/diff-scan.mts")) > "$C/.cc-scan.txt" 2>&1; then
    # hold back only the flagged files (secret-shaped literals): the owners must build them at runtime
    grep -oE 'SECRET-SHAPED: [^: ]+' "$C/.cc-scan.txt" | sed 's/SECRET-SHAPED: //' | sort -u > "$C/.cc-held.txt"
    echo "[$name] held back (secret-shaped): $(tr '\n' ' ' < "$C/.cc-held.txt")"
    cat "$C/.cc-held.txt" >> "$C/held-back.txt"
    mapfile -t held < "$C/.cc-held.txt"; git reset -q -- "${held[@]}"
    if ! (git diff --cached -U0 | (cd apps/server && npx tsx "$C/diff-scan.mts")) > "$C/.cc-scan2.txt" 2>&1; then echo "[$name] STILL FLAGGED after hold-back:"; head -5 "$C/.cc-scan2.txt"; git reset -q; continue; fi
  fi
  if git diff --cached --quiet; then echo "[$name] nothing staged"; continue; fi
  retry git commit -q --no-gpg-sign -m "$subject" -m "$body" -m "$TRAILER" || { echo "[$name] commit failed"; continue; }
  sha=$(git rev-parse --short HEAD); SHAS+=("$name:$sha"); echo "[$name] $n files -> $sha"
done
echo "unstaged leftovers (no group or recent): $(cat "$C/.cc-left.txt" "$C/.cc-recent.txt" | sort -u | wc -l)"
cat "$C/.cc-left.txt" | head -20
echo "SHAS: ${SHAS[*]}"
