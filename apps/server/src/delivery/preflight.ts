import type { DeliveryAccess } from '../workspaces/runtime.js';

/**
 * Lists, by name only, credentials and settings the workspace's user configured that a pool would
 * override (foundation PRD §6.6): `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` in the container environment and
 * shell profiles, and `apiKeyHelper` / matching `env` names in Claude Code settings files. Never prints
 * a value, and never opens `~/.claude.json` or `~/.claude/.credentials.json`, so login state stays unread.
 */
const SCRIPT = `
H=/home/node
pat='^(ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_USE_[A-Z0-9_]+)$'
for n in $(env | cut -d= -f1); do echo "$n" | grep -Eq "$pat" && echo "container environment sets $n"; done
for f in .bashrc .profile .bash_profile .zshrc .zprofile .zshenv; do
  [ -f "$H/$f" ] || continue
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?((ANTHROPIC|CLAUDE_CODE_USE)_[A-Z0-9_]*)=.*/\\2/p' "$H/$f" | sort -u | while read -r n; do echo "~/$f exports $n"; done
done
node -e '
  const fs = require("fs"), path = require("path");
  const files = [path.join(process.env.H, ".claude/settings.json")];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.name === ".claude") for (const f of ["settings.json", "settings.local.json"]) files.push(path.join(p, f));
      else if (!e.name.startsWith(".")) walk(p, depth + 1);
    }
  };
  walk(path.join(process.env.H, "work"), 0);
  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    const shown = f.replace(process.env.H, "~");
    if (s.apiKeyHelper) console.log(shown + " sets apiKeyHelper");
    for (const n of Object.keys(s.env || {})) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(n)) console.log(shown + " sets env " + n);
  }
' 2>/dev/null
`;

export async function runPreflight(access: DeliveryAccess, name: string): Promise<string[] | null> {
  const state = await access.state(name);
  if (!state.running) return null;
  const r = await access.run(name, `H=/home/node; export H; ${SCRIPT}`, { user: 'node', timeoutMs: 15_000 });
  return [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
}
