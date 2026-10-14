# T-294: does `claude --agent <name>` make a session work as that agent?

Observed 2026-10-14 with Claude Code **2.1.296** on the dev workspace (the owner's sign-in, account default model `opus`), in a scratch
folder `/tmp/t294agent-probe` holding one project agent, `.claude/agents/probe.md`:

```markdown
---
name: probe
description: A probe agent for testing the --agent flag. Answers every message with one word.
model: haiku
tools: Read
---

You are the probe agent. Answer every message with exactly the single word PROBE-OK and nothing else. Never use a tool.
```

Lines below are cut to the fields that matter (jq); nothing else was kept.

## 1. `-p` with a prompt argument

```sh
claude -p --model haiku --agent probe --output-format stream-json --verbose "hello"
```

- `system/init`: `"model":"claude-haiku-5-5"`, `"tools":["Read"]` (the agent's `tools:` list, not the full set),
  `"agents":[..., "probe", ...]`. The init line has **no `agent` field**: which agent runs is not reported in the stream.
- Answer: `PROBE-OK`; `result`: `{"subtype":"success","result":"PROBE-OK"}`. The agent's prompt is the session's system prompt.

## 2. The portal's flags (`BASE_FLAGS`, stream-json on stdin), no `--model`, then a `set_model` control request

```sh
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages \
  --permission-prompt-tool stdio --permission-mode default --session-id <uuid> --agent probe
# stdin: {"type":"user",...,"hello"}; after the result: {"type":"control_request","request":{"subtype":"set_model","model":"sonnet"}};
# after its reply: {"type":"user",...,"What is two plus two?"}
```

- `system/init` (first turn): `"model":"claude-haiku-5-5"`, `"tools":["Read"]`. With no `--model`, the agent's `model:` frontmatter
  applies (the account default would be opus).
- Answer 1 on `claude-haiku-5-5`: `PROBE-OK`.
- `set_model` reply: `{"subtype":"success","request_id":"probe-set-model"}`, and the stream echoed `Set model to ...` as usual.
- `system/init` (second turn): `"model":"claude-sonnet-5-5"`, `"tools":["Read"]`. Answer 2 on `claude-sonnet-5-5`: `PROBE-OK`.
  The portal's model change still works, and the agent's prompt and tools stay on the new model.

## 3. Resume with the agent

```sh
claude -p <the same flags> --resume <the same uuid> --agent probe
```

- `system/init`: same `session_id`, `"model":"claude-haiku-5-5"`, `"tools":["Read"]`. Answer: `PROBE-OK`.
- The resumed process starts on the **agent's** model again, not on the `sonnet` set by `set_model` before it. The portal already puts the
  session's model back after every resume or wake (`#restore` sends `set_model` when the session has a model and it differs from what
  applies), so a model the person or the spawner chose wins; a session without one runs on the agent's model.

## 4. An agent name that does not exist

```sh
claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --permission-mode default --agent nosuchagent
```

- No error and no warning on stderr; `system/init` lists the full tool set (29 tools) and the answer is the default assistant's
  ("Hello! How can I help you today? ..."). An unknown agent is **ignored silently**: the session runs as if no agent were given. A
  missing `.claude/agents/<name>.md` in the session's folder never stops a session from starting.

## Not tested here

- A Move between two Claudes (different config dirs) with `--agent`: project agents are read from the session's folder
  (`<cwd>/.claude/agents`), not the config dir, so the Claude does not matter; the portal's unit tests check the flag is passed.
- `--resume` **without** `--agent` (whether the agent is remembered in the transcript): not tested; the portal passes the flag at
  every start, so it does not depend on it.
- Agent frontmatter beyond `model` and `tools` (`permissionMode`, `effort`): the repository's agents set only `name`, `description`
  and `model`.
