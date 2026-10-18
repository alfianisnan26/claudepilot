# T-968: the General Manager's launch flags, measured on Claude Code 2.1.296 (2026-10-18)

Probe: `claude -p --input-format stream-json --output-format stream-json --verbose` with a one-tool stdio MCP server named `pilot`
(`--mcp-config`, `--strict-mcp-config`, `--allowedTools 'mcp__pilot__*'`), read up to the `system/init` line (no model call needed).

| Flags | init `tools` | MCP `pilot` | a project SessionStart hook |
| --- | --- | --- | --- |
| `--tools ""` | `mcp__pilot__session_list` only | connected | ran |
| `--tools "" --safe-mode` | none | **not started** | did not run |
| `--safe-mode` (no `--tools`) | 29 built-ins (Task, Bash, …) | not started | did not run |
| `--tools "" --disable-slash-commands --setting-sources ""` | `mcp__pilot__session_list` only | connected | **did not run** |

Chosen for a `kind = 'manager'` session: `--tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands`, the pilot
`--mcp-config` with `--allowedTools 'mcp__pilot__*'`, and `ENABLE_CLAUDEAI_MCP_SERVERS=false` in its environment. `--safe-mode` is not
used: it drops the MCP server too. The built-in plugins listed in init (`cc-plugin-*@builtin`) are Claude Code's own and stay.
