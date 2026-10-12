# A2b status (chat content: artifacts, media, files) - FINISHED 2026-10-12 ~03:25 UTC (no RESUME needed; only the optional leftovers below)
## My reading of the owner's words (unchanged)
UPLOAD = in the composer only (photos, screenshots, docs, text/code, CSV, PDF, audio, video; picker, paste, drop anywhere); tiles with thumbnail/icon, name, size, x. The staged copy in the workspace
(~/.claudepilot/uploads/<session>/) is transport so Claude can read it, never a user-facing "file". DOWNLOAD = in the transcript only: what the agent produces (files it wrote, files commands made, tool images,
artifact_publish) becomes an ARTIFACT CARD where it happened (icon/thumbnail, name, size, Download, tap = preview); copy kept in the portal blob store per chat. Source edits are the Changes view, not cards. No file manager.
## DONE and verified
- Server: chat/artifacts/** (names, sniff, records, quota, intake, uploads, stage, attachments, serve, zip, capture, retention, portalTools, index + tests: ~80 tests; real cp-session script used for put/cat/produced/unstage),
  routes in fileRoutes.ts (POST/DELETE uploads with its own bodyLimit, text preview via controller.scrub, artifacts.zip), one blob-serving policy (inline allow-list, Range, ETag, nosniff, attachment for the rest), migration 60,
  host.ts put/unstage/produced, controller seams (send, observe, delete, blobFile, publishArtifact), store.ts (files + image size in payload), protocol.ts userLine imagesFirst, local.ts stdin 'error' listener (exec and run).
- Web: Composer (tiles, progress ring, cancel, retry, paste, drop anywhere, photo scaling), artifacts/* (cards, previews: text/md/CSV/JSON/PDF/audio/video/sandboxed HTML, Download all), ImageViewer (zoom, swipe, share/download),
  Transcript.tsx one `case 'artifact'` + attachment chips, useChatSocket outbox files, SessionPage sessionId prop.
- Real checks: Docker workspace + real Claude Code 2.1.296 + stand-in API (what Claude receives: image block first, @path expanded for text/CSV, audio note); real artifact flow (Write card, Bash sweep card); UI at 390 and 1280 px;
  PRODUCTION build + CSP (PDF iframe, audio, video, sandboxed HTML: no violations, script in HTML never ran, Range 206 verified); Info-ZIP/Python open the zip; QA fuzz-api: 112 routes, 0 findings.
- PRD chat-sessions.md: G5, US6, FR30-FR33, FR47, data model, host commands, Rendering row, status table (Built/Partly built/Not built with what was observed).
## Not built / unverified
Android share target (needs manifest + service worker); share sheet and camera on a real phone; PDF content against the REAL Anthropic API (stand-in only shows "PDF file read: <path>"); artifact_publish tested through the MCP harness with
the real controller, not by a real Claude Code process calling it; Files panel not slimmed (no changes there).
## For others
A3c (I11): bytes of a session's blob by verified (sessionId, blobId): `blobFileFor(store, sessionId, blobId)` in apps/server/src/chat/artifacts/serve.ts -> { path, mediaType, size }.
A2: chat.test.ts "delete: a running session..." fails on `worktree: 'none'` in delete's result (your change, not mine); isStagedUpload is yours to call (done by you); local.ts listener added.
Everything stopped and removed (portal, workspace ct-ws via the API, ct-exp, /tmp/ct*, my screenshots). Ports 3107/9237 free.
