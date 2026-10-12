# A4b (knowledge) status - updated 2026-10-12 03:35 UTC - K0 to K2 BUILT; final report pending the full-suite result
DONE and verified:
 - QA-011: start-up and background work guarded (writable store + deliveryAllowed + tables present, all in try/catch); qa/boot.test.ts green with the module in.
 - K1: vault core (files are truth, rebuildable per-vault SQLite index, history/audit/edges in portal.db migration 50), REST, zip import/export, UI under the text diet
   (vault page, note view/editor, backlinks, search, tags, history/restore, daily notes, import/export); checked in headless Chromium at 390 and 1280 px, light and dark.
 - K2: docs/context/agentic graphs (GET /api/knowledge/graph, gzip), caps with folder/kind clustering, local graph read from the index, read-only adapters tolerant of
   missing tables/columns; canvas graph UI (pan, pinch, wheel, tap opens, hold picks with Around/Open, hover, list view, filters sheet, local graph tab in the note panel,
   portal-wide page /admin/knowledge/graph); layout bug fixed (hubs linked to hubs flew apart: degree-weighted springs + step cap + regression test).
 - MCP tools (scope 'agent', one line in index.ts: registerKnowledgeTools(knowledge)): vault_list, note_search, note_read, note_backlinks, tag_list, graph_neighbours, graph_query,
   note_write, note_edit, note_append, daily_append. Checked through the REAL /mcp of my portal with an operate token (list, search, append, neighbours; the write shows as a
   token node in the context graph) and, in tests, with per-session agent tokens through a real MCP client (policy, conflicts with current text, secrets refused, untrusted
   labels, vault allow-list, edges for the VERIFIED session never from args, audit of denials, 20 writes/min stop).
 - QA fuzz (tools/qa/fuzz-api.mts) against my portal: 112 mutating routes, 3,326 requests, 0 findings.
 - Measured at 10,000 notes (45k links): search p95 9-26 ms (39 ms with snippets), cold index 3.6 s, unchanged rescan 81 ms, whole-vault graph 130 ms (cached per index
   generation), local graph 2-50 ms, 100 KB gzip. Web production build OK (GraphPane chunk 12.9 KB gzip). PRD docs/prd/knowledge-graph.md v0.3 + README row updated.
NOT VERIFIED (said plainly in the PRD): a vault exported from here opened in the Obsidian app; a real Claude Code process calling the tools; frame rate on a real phone;
 touch taps inside a bottom sheet could not be driven by my CDP touch emulation (the same shared Dialog works with the mouse; Import verified at 1280 px).
NOT BUILT: K3 (git sync, snapshot delivery, external systems) - out of scope by the coordinator's call.
Cleanup: my portal (tmux kgportal) stopped; no Chromium or container of mine running; scratch /tmp/kg-work, /tmp/kgdata, /tmp/kgportal.log removed at the end.
Ports: 3106 / CDP 9236 / prefix kg- / migrations 50-59 (50 used). No new dependencies.
