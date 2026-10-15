# orchestrator status (2026-10-15 16:01 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- MERGED ff cc26c96: T-531 S2c (gate GREEN 55d5fad). CLOSED T-531.
## IN FLIGHT (6 of 6, D-71/D-70): LANE 7e4879c7 "ClaudePilot QA Perf" (lane-qa-perf, sonnet, lane/cp-qa-perf): queue T-426 -> T-591 -> T-586 -> T-561 S1c -> T-546 -> T-548 (+ T-486 S2e).
  T-561: S1b QA PASS WITH GAPS (5440, symlink holes A, B) -> S1c DONE 0beae29 (5498/5501; 77c04fc0 ended) -> QA Perf re-probe -> lead
  gate + merge. LANE bbbe2b38 "ClaudePilot QA UI" (lane-qa-ui, sonnet, qa/T-600-ui, deps linked by lead) on T-600 FE ux: browser tools refused (5503 PASS
  WITH GAPS; T-525 5505 to coordinator); default: headless tools/qa/*.mjs. T-576 DONE 2427d98 (Jobs green; no
  prettier/eslint in the Job): ux BLOCKED (a `folder` spawn gets no Bash; 5368) until T-586 merges. T-586 DONE 1d27635 (Job 6be903ec rc 0, mutation
  caught, 5419; 2ae78a99 ended): review PASS W/ COND (5456) -> S2 fc9ce1d DONE (5464; 813992cf ended) -> premerge
  wip/main-5b66aa0, gate GREEN gate-5b66aa0-44ef (suite 559 s, peak 2172Mi) -> QA Perf after T-548 -> ff integration (no deploy).
  T-486 S2d 2979f99: QA Perf PASS WITH GAPS 5548 (junk drains the global 120/min bucket -> signed hook 429). Decision 5551: S2e fix
  -> BACKEND LANE 74a8d857 (respawned, sonnet, ticket/T-486-s2e-bucket from 2979f99) -> QA Perf re-probe -> gate + merge. QA Perf on T-426 at 7fbbe4c (lead merge, its ff worked).
  T-548 S1 9b822ba + T-591 S1 bf932c3: blind review 9651c9fa (ended) PASS W/ COND both (5512/5513; sev 2 vault authz on T-591). Decisions
  5514/5515: S1b fixes. T-591 S1b DONE 09ade72 (5563; 192/192 ci+authz, mutation caught; lead read authz: sound; 4ba6c5db ended)
  -> QA Perf. T-548 S1b = one-off sonnet at next free slot. REVIEWER d4c49b5c (opus, why: secret door) on T-426.
  Backend 5f8f392b ENDED (ff refused): T-546 DONE 10b22e0 (5535) -> QA Perf; merge 10b22e0, not the branch head 0004ac5 (has S2d).
  PLANNED T-600 BE 5540, T-597 5546, T-325 5547 (S1+S2 only, 5549). T-600 BE: respawn Backend on a branch from FE 7d19c94 after QA UI. LANE f13a9442 "ClaudePilot Frontend" (lane-frontend, sonnet,
  ticket/T-600-crew-pace-ui): T-600 FE DONE 7d19c94 (5473/5478); T-556 PLANNED 5497 (one "Upstream" dialog, 4 fields: no upstream UI exists);
  builds after T-486 merges + T-595. QA UI then T-576 ux. LANE 83921ca7 "ClaudePilot BE Infra" (lane-backend, sonnet,
  ticket/T-611-job-placement) on T-611; queue T-547, T-610 (T-401/T-426 fixes, if any). 6 of 6: QA Perf, Backend, BE Infra, QA UI, 2 reviewers.
  16:35 Frontend f13a9442 ENDED (idle, T-556 parked) for REVIEWER 219d5558 (sonnet) on T-619 browser allow-list (owner priority).
  T-600 FE: QA UI FAIL 5565 (Home card grid follows viewport; labels cut at 1280) -> FE S1b (5573): respawn Frontend on a fresh
  branch from 7d19c94 at next free slot; QA UI fixes home.mjs harness meanwhile. T-558 QA -> end of QA Perf queue. No prettier/eslint in Jobs (T-612).
- 16:12 OWNER PRIORITY (coordinator, T-426 5538): T-401 then T-426 FIRST (Konfersi QA UI needs stg login in a Job; done = T-617 screenshots).
  T-426 ab93b54 (on T-401 060aca4): QA Perf FIRST (5541), blind review opus at next free slot (impl-t591 ends -> reviewer), gate, merge.
  T-401 re-merged wip/main-54ba328: gate GREEN gate-54ba328-6502 (suite 570 s, peak 2228Mi; 5560/5562); ff only on the person's ack (4941).
- T-379 S2 3f11b28 PASS (4948; review 4938) -> merge after T-401. T-401 060aca4: review 4936, QA 4943; HELD on the ack (4941).
- T-416 (high incident): S1 d37c5f0; QA b1aa2e47 PASS WITH GAPS (4623: 995/999 0 fail job-2c410105; mutations A2/B/C caught);
  ended. Decision 4637: S1b a769b00 (race fix + push-bridge test, UNTESTED; author ended for T-379, 4688). QA runs its Jobs,
  then blind review (opus), lead gate, merge, deploy. S2 = Bypass restore.
- T-404 open until deployed. T-376 (high): S2 0b0faf7 needs integration merged in, ux re-check, S3 perf.

## DECISIONS (binding)
- 16:30 D-71 (coordinator): limit 6; 3rd build lane BE Infra (CI, runners, job-run, k3s, deploy, secrets delivery, usage, spend, quota):
  T-401, T-426, T-611, T-547, T-610. Backend: T-546, T-597, T-600 route, T-325. Spawn lanes with claude auto.
- 14:56 D-70 LANES (DECISIONS.md; my decision T-595 5380): current 5 workers finish; freed slots become lanes, spawned ONCE on sonnet and fed
  by session_message, never ended for lack of work: CP Backend -> CP QA Perf -> CP Frontend -> CP QA UI -> 5th = blind reviewer.
  Every delivery goes to its side's QA lane before merge. T-591 S1 stays with eaec4cc5, then Backend. T-595 5389: the LEAD makes each ticket's
  worktree+branch and gives the lane the path. 15:19 CONFIRMED refused (5443): no lane can take a 2nd ticket; coordinator asked (a/b/c);
  16:25 (T-595 5552/5553): QA Perf may `git merge --ff-only` a base the lead pushed; lane-backend may NOT. An implementing lane
  needing a new base is ended and respawned as the same lane on a fresh branch from that base.
- 15:50 Workspace restarted 13:46 UTC; 03c496b6 (T-546, mid-Jobs) and cee43422 (T-486 port, WAITING 3cb0883) are gone, all branches
  pushed and clean. Deploy #39 (coordinator, RBAC + T-557 fix) holds the cluster, finishes by itself. 14:05 Coordinator AWAY (owner offline): restart POSTPONED, long work OK, Mac runner off.
  BINDING: the coordinator runs deploys (#38-#40); I start NO deploy. (Old T-546/T-486 workers replaced.)
- 12:50 Coordinator: it builds T-557 itself (owner's ask); no T-557 slices from me; T-426 stays mine; a line on T-557 when I touch
  ci/ or connect/ in a big way. (Supersedes 12:45's fold of T-426 into the lease.)
- 13:20 D-66: quick-check (format, lint, named tests) before the gate. Workers cannot git merge: the lead merges base heads in (4852).
- 11:15 D-65 (coordinator): 4 ClaudePilot workers; implementers sonnet by default (opus only with a written why); small QA/review
  findings fixed in the same slice; a worker takes 2-3 related tickets (reuse under 150k); full report on the ticket, the lead
  reads line 1 and opens it only on FAIL; ready features over chores. Targets under 8 USD per ticket, lead share under 30 %.
- 15:29 Coordinator: job-run.sh caps and queues Jobs (2/program, 3 cluster); "one at a time" is PER AGENT. Workers start their own Jobs
  when pushed; no GO protocol (supersedes 10:25). gate-job before each merge stays mine.
- 09:00 Persona/role-tool/permission questions go to the coordinator, NEVER the owner; `owner-checklist` = production only.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: (worker count now 5 by D-68, coordinator 2026-10-15), NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time. Hand over before 250k.

## NEEDS A HUMAN (D-62)
- T-401 gate wall (via the coordinator): the owner acks on T-401 that gate-job.yaml's change is credential plumbing plus one
  stricter red (exit 3 on a credential value in the gate's files); gate.sh's checks unchanged. Question text in 4941.
- T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-594 alfian.isnan signed out; T-525 session_get + scribe tools + QA UI browser tools (5505); T-595 lane Bash (5443);
  T-591 #40 backfill after deploy (5511); T-325 S3 push door vs charter "only the main chat merges integration" + its token (5549); T-527 finding 4 (owner triggers tagging owner-checklist).

## NEXT (in order, as slots free)
1. Merges: T-401 (ack) -> T-426 -> T-379 -> T-486; deploys are the coordinator's. 2. T-416 S1b QA -> blind review (opus) -> merge; then S2.
3. NEXT FREE SLOTS: T-558 QA (sonnet) + review (opus); T-426 QA + blind review; T-548 (sonnet); T-578 (high: deploy reuses a green gate for the same
   tree + per-file gate progress; a gate change: built + blind review, merged only on a person's ack like T-401); then RTK (coordinator 14:55):
   T-340 (hook refuses typed rtk hiding a denied command; a hook change is landed by a person/coordinator) -> T-341 -> T-306
   delivery (dev/t-306-1 has items 1-2); T-547 + T-549 (+ wasted-calls row, 4802); T-574 (session_family summary, from T-282 4801). Sweep results: the lead closes on PASS or reopens with the gap. 4. T-524 measurement with T-513. 5. T-537. 6. T-513.
7. T-472 live re-check (4294), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1 verify, T-382, T-377, T-386, T-409, T-402, T-398, T-399, T-370 HOLD,
   T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-376 S2.

LESSONS: node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders; cite a comment id only after the post returns it (wrong twice); trailers in one block; FULL hashes; gate before every push; status via Edit/Write ONLY (broken twice 2026-10-15: python, sed -i); ancestor check before ff.
