# T-294: does `claude --disallowedTools Agent Task` take the sub-agent tool away?

Observed 2026-10-14 with Claude Code **2.1.296** (`claude_code_version` in the init line) on the dev workspace, the owner's sign-in, in a
scratch folder `/tmp/t294limits-probe` holding one project agent, `.claude/agents/probe-lead.md` (no `tools:` line, so it gets the full set):

```markdown
---
name: probe-lead
description: A probe agent for testing --disallowedTools with --agent. Starts every answer with PROBE-LEAD.
model: haiku
---

You are the probe-lead agent. Start every answer with the word PROBE-LEAD. If you are asked to start a sub-agent and you have no tool for it,
say so and name the tools you have that could start one (none, if none). Keep answers to two sentences.
```

One run, in the order the portal's launch (`#hostStart`) puts its flags: the agent, then the disallowed tools, then the portal's MCP config and
its `--allowedTools`. The user message went in on stdin (stream-json), as the portal sends it, so no prompt argument follows a variadic flag.

```sh
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Start a sub-agent with the Agent tool (older name Task) that says hello, then tell me what happened."}}' |
claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode default --model haiku \
  --agent probe-lead \
  --disallowedTools Agent Task \
  --mcp-config '{"mcpServers":{}}' --allowedTools 'mcp__pilot__*' \
  --session-id <uuid>
```

Lines below are cut to the fields that matter (jq); nothing else was kept.

- Exit 0, nothing on stderr: the three flags parse together (`--disallowedTools` takes `Agent Task` as two values and stops at the next
  flag, as `--allowedTools` does).
- `system/init`: `"model":"claude-haiku-5-5"`, `"agents":[..., "probe-lead", ...]`, `"tools"` (28): `Artifact, ArtifactComments,
  ArtifactData, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, Monitor, NotebookEdit,
  PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, ShareOnboardingGuide, Skill, TaskStop, ToolSearch,
  WebFetch, WebSearch, Workflow, Write`. **No `Agent` and no `Task`.**
- The answer (one turn, no tool call, `permission_denials: []`): "PROBE-LEAD: I can't start a sub-agent because I have no Agent or Task tool,
  and none of my available tools can start one (the Workflow tool could run agents, but only with your explicit opt-in, and SendMessage
  only messages existing agents). ..." The `PROBE-LEAD` opening shows `--agent` still applies with the tools taken away.
- Cost of the run: $0.0058.

## What this means for the portal

- `--disallowedTools Agent Task` removes the sub-agent tool under both names the portal's reader treats as sub-agents
  (`chat/protocol.ts` `AGENT_TOOLS`), together with `--agent` and with the portal's `--mcp-config` / `--allowedTools mcp__pilot__*`.
  A session with sub-agents off is launched with it at every start.
- It is a switch, not a count: Claude Code has no flag for "at most N sub-agents", so the portal offers on or off only.

## Not tested here

- A run **without** the flag in the same folder (the brief allowed one run): that `Agent` is in the default set is known from every
  ordinary session (this one included), not from a second probe.
- **`Workflow`** stays in the set. The model's own answer says it "could run agents, but only with your explicit opt-in"; whether a
  workflow started from a portal session runs sub-agents was not tried. Taking it away too (`--disallowedTools Agent Task Workflow`) is a
  one-word change once a probe shows it does.
- `--resume` with the flag (the portal passes it at every start, resume included, so it does not depend on the transcript remembering it).
