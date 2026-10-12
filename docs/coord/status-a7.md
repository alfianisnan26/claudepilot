# A7 status (chat motion and polish) - FINAL, 2026-10-12 03:15 UTC. Nothing running (portal, Chromium, /tmp files removed).
## Built (apps/web/src/features/chat/motion/, new; 83 unit tests via `npm test -w @portal/web`; `npm run build -w @portal/web` clean)
tokens (one place for easing/durations/pacing), pacing + engine (adaptive pace, hard 0.5 s deadline, fast flush at the end), words (whitespace + CJK/Thai segmenting, table-header hold), blocks (top-level block splitter, incremental),
reveal (rehype cut of the RENDERED block; code line by line, table row by row, inline code whole), frames (one rAF loop), StreamingMarkdown + motion.css + StreamTable (cells glide when columns re-balance),
useFollow + glide (eased scroll-follow, Jump to latest glide), useHandover + handover (live -> stored without flash), deltas (about 30 Hz delta batching).
## Integration edits in A2's/A2b's files (see outbox-a7.md for the detailed list)
Markdown.tsx (export COMPONENTS, PLUGINS); Transcript.tsx (follow, handover, live slot, key per live reply, aria-busy, storedRows memo, tokens); ToolRows.tsx (shimmer instead of spinner, Thinking read once); Activity.tsx (tokens);
useChatSocket.ts (delta batcher, 5 lines); apps/web/package.json (`test` script); docs/prd/chat-sessions.md (approved: 12.7 Transcript row, G8, NFR numbers).
## Numbers (production build, headless Chromium software rendering, 390x800 @2x, shared 8-core machine at load ~4)
5,061 words at ~71 w/s: 4,376 frames, dt p50 16.7 / p99 16.8 / max 167 ms, 36 frames over 20 ms; script ~84 ms/s, flat from 2.7k to 15k DOM nodes; scroll moved in 97% of frames, 0 backwards, p95 step 10 px, 30 px (p95 60) behind the end; 0 words moved.
First word 30-66 ms after arrival; lag behind the stream p50 160 / p95 285 / max 414 ms (steady 40 w/s), max 469 ms at 200 w/s (cap 0.5 s). 120-turn transcript: script 56-86 ms/s after memoising stored rows (was 385-607).
## Not verified / limits: real iOS Safari (only Chromium mobile emulation); CDP-synthesised touch swipe did not scroll (wheel stop + Jump verified); true pixelate not attempted (blur-to-sharp per word); no screen-reader run;
an expanded activity row's usage line still nudges the reply below it by one line when the turn ends; table columns re-balance as rows arrive (cells glide, never jump).
