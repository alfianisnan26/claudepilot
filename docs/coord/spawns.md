# Spawn ledger (model, effort, why). The rule is in DELEGATION.md. Format: agent id | package | model | effort | reason

## Before the delegation rule (default model inherited from the coordinator, default effort)
B1 a8205ce94fb407c9b | catalogue core | default | default | spawned before the rule
B2 a699fbe89318fbd70 | providers + testkit | default | default | spawned before the rule
B3 a4f1a709d818631e8 | OAuth status + sign-in | default | default | spawned before the rule
B4 a531c32049b2afd78 | catalogue UI | default | default | spawned before the rule
G1 a4b9924362ee31884 | workspace git server | default | default | spawned before the rule
P1 a86561a02bfd77db1 | Connect architect | default | default | spawned before the rule
P2 a9a4bb6ff74da2a1e | platform auditor/architect | default | default | spawned before the rule
U1a a770e2bdf75735501 | usage engine A | default | default | spawned before the rule
U1b ade918695d865fc53 | usage engine B | default | default | spawned before the rule
U2 a5f6c9a9afeb81f99 | usage page UI | default | default | spawned before the rule
U3 a71975f3f4675051d | glance framework | default | default | spawned before the rule
U4 afb598ced5b864920 | glance widgets | default | default | spawned before the rule
G2 aac12dc0fc66fdbdd | repos UI | default | default | spawned before the rule
T1 a50f466d25e070d71 | Connect control plane | default | default | spawned before the rule
T2 ad5f5d5de62103714 | Connect agent | default | default | spawned before the rule
V1 a96f4c1687c90ea07 | version pin + canary | default | default | spawned before the rule
P5 a1996019d3cb0d44b | multi-user architect | default | default | spawned before the rule (a TIER S task: if it reports stuck or weak, replace with fable/high continuing from its status)
S1 a207ec932ae388796 | btw engine | default | default | spawned before the rule

## After the rule
V2 aeaf0d70396c19240 | Claude Code version UI | sonnet | medium | Tier B/C UI against a landed contract; mechanical, verified by screenshots
T4 a521df4c49ff40cf8 | Connect installers | opus | medium | Tier A: installers run on users' machines with enrollment tokens; security-relevant, well specified, script-test verified
T3 ab5b013adb02e6725 | Connect remote runtimes | opus | medium | Tier A: complex integration into core runtime code; detailed spec
N1 a82c4523de23d2c9a | notify core | opus | high | Tier S/A: crypto, answer tokens, SSRF, sealed keys; detailed spec
N2 a80dcc78f0d7837e9 | notify web | sonnet | medium | Tier B/C: UI and small worker against a landed contract
K1 a62ddb23a0876ae0e | Copilot POC | opus | medium | Tier A: tokens + device flow + real-CLI verification, integration with secrets/delivery/workspaces
P8 (id below) | VS Code architect + PoC | opus | high | Tier A/S: security-sensitive architecture decided by real tests
K1 a62ddb23a0876ae0e | REDIRECTED to GitHub Codespaces POC (was Copilot CLI) | opus | medium | scope corrected by the owner; auth + REST lifecycle + stand-in remain Tier A
GA (not spawned yet) | guidance server+registry | sonnet | medium | Tier B
GB (not spawned yet) | guidance UI | sonnet | medium | Tier B/C
P9 (not spawned yet) | MCP both directions + gateway architect | fable | high | Tier S: security/authorization/gateway architecture
S2 a03ae92ed54da888d | btw UI | sonnet | medium | Tier B/C: UI against a landed contract; layout verified by automatic checks
UR (not spawned yet) | UI resilience components + lab + checks | sonnet | medium | Tier B
US (not spawned yet) | screen migration for dynamic data | sonnet | medium | Tier B/C, after UR and per-feature owners done
N3 adc4608c960494194 | triggers | opus | high | Tier S/A: webhooks, injection exposure, automatic session starts with limits
N4 a81a4f31f49edceb3 | auto transfer | opus | medium | Tier A: automatic quota-moving action with safeguards
T5 abce2e319c0f02709 | Connect web UI | sonnet | medium | Tier B/C: UI against a landed contract and live REST
MU1 aee37491959784d8e | identity core | fable | high | Tier S: security-critical (accounts, passwords, sessions, setup token); 2026-10-12T06:50Z
MU2 ac45f5f5bb6244579 | authorization layer (shadow) | fable | high | Tier S: default-deny authz, one decision point, evasion tests; 2026-10-12T06:50Z
P3 aa478a8baa0349a04 | evidence/annotations/code viewer architect | opus | high | Tier A: design with security, no runtime code; 2026-10-12T06:57Z
P4 a8a7f710cc5eab933 | ops plan architect | fable | high | Tier S: auto-approval matching + evasion; 2026-10-12T06:57Z
P7(ps) a0bff55eeba6c6816 | data placement audit READ-ONLY | opus | high | Tier A: whole-schema audit, staged plan; 2026-10-12T06:57Z
P9(mx) a8ef7f7a3b5b6e680 | MCP complete + pool gateway architect | fable | high | Tier S: authz/untrusted-text/secret-injection gateway; 2026-10-12T07:05Z
