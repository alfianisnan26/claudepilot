# DELEGATION RULE (standing, from the owner, 2026-10-12; applies to every Agent spawn the coordinator makes)

The owner lets the coordinator choose the MODEL and the EFFORT of every agent it spawns (the Agent tool's `model` and `effort` inputs; the effort input may be set because the owner explicitly allowed it). The owner can override model or effort at any time.

## Rubric
Ambiguity, security risk, impact if wrong, difficulty of verification, size of context.
- TIER S (strongest model, high effort): architecture with cross-cutting impact, security, authorization, approval-matching, crypto and token handling, anything where a mistake silently weakens security. Model `fable`, effort `high`.
- TIER A (strong model, medium or high effort): complex server engines and integrations with real risk or a big context (tunnel, runtimes, scanners, policy engines), architecture and audits that are large but not security-critical, security-flavoured QA. Model `opus`, effort `medium` (high when the spec is ambiguous or the blast radius is big).
- TIER B (standard model, medium effort): ordinary implementation with tests against a clear spec. Model `sonnet`, effort `medium`.
- TIER C (light model or low effort): mechanical work: UI components against a given contract, documents, QA scripts, glue. Model `sonnet` with effort `low` or `medium` (or `haiku` for truly mechanical edits).
Start light; ESCALATE when an agent reports it is stuck or its tests fail repeatedly: spawn a NEW agent (stronger tier) that continues from the RESUME HERE block in the status file. Never use the strongest model for everything; mind the remaining quota per model.

## Record
Every spawn gets ONE line (model, effort, why) in COORD/spawns.md AND as the FIRST line of the agent's COORD/status-<id>.md ("Spawn: model=... effort=... - reason"); the agent's prompt says to keep that first line when it overwrites its status file. Agents spawned BEFORE this rule ran with the default model (inherited) and the default effort: they are recorded as such below.
