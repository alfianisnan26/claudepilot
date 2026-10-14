// T-255: Claude Code's limit message as a hard signal. The parse of the stated reset (several variants, the zone, the fallback), the chat
// reader's line (only Claude Code's own `<synthetic>` line counts), and the usage module: the Claude is used up until the reset whatever a
// probe reads meanwhile, the snapshot says "limit reported by a chat" with its source, and an unknown reading is never 0 %.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine } from '../chat/protocol.js';
import { claude, HOUR, MIN, NOW, planResult, usageHarness, win } from './fixtures.js';
import { fallbackReset, LIMIT_MESSAGE_SOURCE, parseLimitMessage, parseResetTime } from './limitMessage.js';
import type { ProbeResult } from './probe.js';

// 2026-10-12 01:00 UTC (the fixtures' clock).
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

test('the reset a limit message states: the next such time after the message, in the zone it names', () => {
  // As seen on this pod (Claude Code 2.x): a middle dot, or a comma.
  assert.equal(iso(parseResetTime("You've hit your session limit · resets 11pm (UTC)", NOW)), '2026-10-12T23:00:00.000Z');
  assert.equal(iso(parseResetTime("You've hit your session limit, resets 10:20pm (UTC)", NOW)), '2026-10-12T22:20:00.000Z');
  // A time already past today is tomorrow's.
  assert.equal(iso(parseResetTime("You've hit your session limit · resets 12:30am (UTC)", NOW)), '2026-10-13T00:30:00.000Z');
  // Another zone: 5am in Jakarta (UTC+7) is 22:00 UTC the day before.
  assert.equal(iso(parseResetTime("You've hit your session limit · resets 5am (Asia/Jakarta)", NOW)), '2026-10-12T22:00:00.000Z');
  // A date (a week window), and an older CLI's wording.
  assert.equal(iso(parseResetTime("You've hit your weekly limit · resets Oct 15, 9am (UTC)", NOW)), '2026-10-15T09:00:00.000Z');
  assert.equal(iso(parseResetTime('Claude usage limit reached. Your limit will reset at 5pm (America/New_York).', NOW)), '2026-10-12T21:00:00.000Z');
  // No zone: UTC.
  assert.equal(iso(parseResetTime('5-hour limit reached ∙ resets 3am', NOW)), '2026-10-12T03:00:00.000Z');
  // Nothing the portal can read: an unknown zone, no time, a date too far off.
  assert.equal(parseResetTime("You've hit your session limit · resets 11pm (Mars/Olympus)", NOW), null);
  assert.equal(parseResetTime("You've hit your session limit", NOW), null);
  assert.equal(parseResetTime("You've hit your weekly limit · resets Dec 25, 9am (UTC)", NOW), null);
});

test('a limit message: the window it names, and the fallback (the next 5-hour boundary, said as guessed) when it states no time', () => {
  assert.deepEqual(parseLimitMessage("You've hit your session limit · resets 11pm (UTC)", NOW), { window: 'session', resetsAtMs: Date.parse('2026-10-12T23:00:00Z'), guessed: false });
  assert.equal(parseLimitMessage("You've hit your weekly limit · resets Oct 15, 9am (UTC)", NOW)?.window, 'week');
  assert.equal(parseLimitMessage("You've hit your Opus limit · resets Oct 15, 9am (UTC)", NOW)?.window, 'week_opus');
  const g = parseLimitMessage("You've hit your session limit", NOW + 17 * MIN)!;
  assert.deepEqual(g, { window: 'session', resetsAtMs: NOW + 6 * HOUR, guessed: true }, '01:17 + 5 h, up to the hour: 07:00');
  assert.equal(fallbackReset(NOW), NOW + 5 * HOUR);
  assert.equal(parseLimitMessage('All done, the tests pass.', NOW), null);
});

/** A `<synthetic>` line as Claude Code streams it when the plan is out of quota (shape from this pod's streams, text made up here). */
const limitLine = (text: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { id: 'm1', model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, session_id: 'x', uuid: 'u1', timestamp: new Date(NOW).toISOString(), error: 'rate_limit', is_api_error_message: true, ...over });

test('the chat reader: Claude Code’s own limit line becomes a refusal of that window with the stated reset; a model talking about a limit does not', () => {
  const p = parseLine(limitLine("You've hit your session limit · resets 11pm (UTC)"));
  assert.deepEqual(p.rateLimitInfo, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.parse('2026-10-12T23:00:00Z') / 1000, reportedBy: LIMIT_MESSAGE_SOURCE, reportedAtMs: NOW, resetGuessed: false });
  // The text still shows in the chat as it did.
  assert.equal(p.stored[0]?.text, "You've hit your session limit · resets 11pm (UTC)");
  // A model's answer quoting the message is no signal.
  const quoted = JSON.parse(limitLine("The chat said: You've hit your session limit · resets 11pm (UTC)")) as Record<string, unknown>;
  (quoted.message as Record<string, unknown>).model = 'claude-sonnet-4-5';
  delete quoted.error;
  delete quoted.is_api_error_message;
  assert.equal(parseLine(JSON.stringify(quoted)).rateLimitInfo, undefined);
  // Claude Code's line with other text (another API error) is none either.
  assert.equal(parseLine(limitLine('API Error: 500 Internal server error')).rateLimitInfo, undefined);
});

const reset5h = NOW + 4 * HOUR;

test('a limit reported by a chat: the Claude is used up until the reset, shown with its source, and a probe reading 0 % with no reset meanwhile changes nothing', async () => {
  let answer: ProbeResult = planResult([win('session', 0, null, 'Session'), win('week', 0, null, 'Week')]);
  const h = await usageHarness({ probe: (async () => answer) as never });
  try {
    await h.usage.tick();
    await new Promise((r) => setTimeout(r, 5));
    let c = (await h.usage.report()).claudes[0]!;
    // No 0 % for unavailable: the snapshot says why, and the Claude is `unknown`, not `ok`.
    assert.equal(c.unavailable, 'no_reset_time');
    assert.equal(c.state, 'unknown');
    const s = await h.usage.summary({ tzOffsetMin: 0 });
    assert.equal(s.claudes[0]!.unavailable, 'no_reset_time');

    h.source.sessions.set('s1', { workspaceId: 'docker/ws1', claudeId: 'c1' });
    h.clock.t += 10 * MIN;
    h.usage.onRateLimit('s1', 'c1', parseLine(limitLine("You've hit your session limit · resets 11pm (UTC)", { timestamp: new Date(h.clock.t).toISOString() })).rateLimitInfo);
    c = (await h.usage.report()).claudes[0]!;
    assert.equal(c.state, 'exhausted');
    assert.equal(c.unavailable, null, 'a reported limit is measured: used up');
    assert.deepEqual(c.limitReport, { window: 'session', label: 'Session', at: new Date(NOW + 10 * MIN).toISOString(), until: '2026-10-12T23:00:00.000Z', guessed: false, sessionId: 's1' });
    assert.deepEqual(c.windows.find((w) => w.key === 'session')?.usedPct, 100);
    assert.equal(h.usage.headroom('c1').exhausted, true);

    // The next probe still reads 0 % with no reset: the report holds.
    h.clock.t += 20 * MIN;
    await h.usage.tick();
    await new Promise((r) => setTimeout(r, 5));
    c = (await h.usage.report()).claudes[0]!;
    assert.equal(c.state, 'exhausted');
    assert.equal(c.windows.find((w) => w.key === 'session')?.resetsAt, '2026-10-12T23:00:00.000Z');
    assert.equal(h.usage.headroom('c1').exhausted, true);

    // Past the reset the report is gone and the probe's reading counts again.
    answer = planResult([win('session', 3, Date.parse('2026-10-13T04:00:00Z'), 'Session')]);
    h.clock.t = Date.parse('2026-10-12T23:05:00Z');
    await h.usage.tick();
    await new Promise((r) => setTimeout(r, 5));
    c = (await h.usage.report()).claudes[0]!;
    assert.equal(c.limitReport, null);
    assert.equal(c.state, 'ok');
  } finally {
    h.done();
  }
});

test('a limit line read again after its reset (a reader that starts over) records nothing', async () => {
  const h = await usageHarness({ probe: (async () => planResult([win('session', 10, reset5h, 'Session')])) as never });
  try {
    await h.usage.tick();
    await new Promise((r) => setTimeout(r, 5));
    h.source.sessions.set('s1', { workspaceId: 'docker/ws1', claudeId: 'c1' });
    // Written yesterday, its reset (yesterday 11pm) long past.
    const old = limitLine("You've hit your session limit · resets 11pm (UTC)", { timestamp: new Date(NOW - 26 * HOUR).toISOString() });
    h.usage.onRateLimit('s1', 'c1', parseLine(old).rateLimitInfo);
    const c = (await h.usage.report()).claudes[0]!;
    assert.equal(c.limitReport, null);
    assert.equal(c.state, 'ok');
    assert.equal(c.source, 'probe');
  } finally {
    h.done();
  }
});

test('why there is no reading: not signed in, no usage endpoint, never read; never shown as 0 %', async () => {
  let answer: ProbeResult = { runsOn: 'none', plan: null, windows: [], extra: null, problem: null, failed: false };
  const h = await usageHarness({ probe: (async () => answer) as never });
  try {
    h.source.list = [claude({ id: 'c1' })];
    assert.equal((await h.usage.report()).claudes[0]!.unavailable, 'no_reading');
    await h.usage.tick();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await h.usage.report()).claudes[0]!.unavailable, 'signed_out');
    answer = { runsOn: 'plan', plan: 'max', windows: [], extra: null, problem: 'unavailable', failed: true };
    h.clock.t += HOUR;
    const fresh = await usageHarness({ probe: (async () => answer) as never });
    try {
      await fresh.usage.tick();
      await new Promise((r) => setTimeout(r, 5));
      const c = (await fresh.usage.report()).claudes[0]!;
      assert.equal(c.unavailable, 'no_usage_endpoint');
      assert.equal(c.windows.length, 0);
    } finally {
      fresh.done();
    }
  } finally {
    h.done();
  }
});
