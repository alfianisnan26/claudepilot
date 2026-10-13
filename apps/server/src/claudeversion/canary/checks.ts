// The canary's checks (docs/prd/claude-version-pinning.md §11): each drives the REAL Claude Code CLI in the throwaway container against the
// in-container stand-in API and compares what it does with what the portal reads, using the portal's own code wherever there is some:
// `parseLine` and the message builders of chat/protocol.ts, `probeClaude` and `parseRateLimitInfo` of claudeusage, the session host script of
// chat/host.ts. A check passes only on what it observed; an assertion that fails says which behaviour changed, with the lines behind it.
// A check is `{ def, run }`; the definitions live in the contracts (`CLAUDE_CANARY_CHECKS`) so the web lists them, and other areas add theirs
// with `registerCanaryCheck`.

import { randomUUID } from 'node:crypto';
import { CLAUDE_CANARY_CHECKS } from '@portal/contracts';
import { parseRateLimitInfo, parseUsageReply } from '../../claudeusage/parse.js';
import { probeClaude, probeCommand } from '../../claudeusage/probe.js';
import { CP_SESSION } from '../../chat/host.js';
import { btwCommand } from '../../chat/btwRun.js';
import { allowResponse, controlRequest, denyResponse, interruptRequest, parseLine, userLine } from '../../chat/protocol.js';
import { BOX_DIR, BOX_HOME, CheckFailed, expect, type StreamSession } from './box.js';
import { MCP_CHECKS } from './mcpChecks.js';
import { CHAT_FLAGS, isObj, nextRequest, obj, pass, shq, tailOf, toolResults, turn, TURN_MS, type CanaryCheck, type CheckContext, type CheckOutcome } from './support.js';

/* ---------- version ---------- */

const version: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'version')!,
  async run({ box, version: want, firstReported }) {
    const r = await box.sh(`${shq(box.claude)} --version`);
    const m = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(r.stdout.trim());
    expect(r.code === 0 && m, 'claude --version did not print “<x.y.z> (Claude Code)”.', `${r.stdout}\n${r.stderr}`.trim());
    firstReported.value = m[1]!;
    expect(m[1] === want, `It reports ${m[1]}, not the version under test, ${want}.`, r.stdout);
    return pass(`${m[1]} (Claude Code)`, r.stdout.trim());
  },
};

/* ---------- stream-turn ---------- */

const streamTurn: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'stream-turn')!,
  async run({ box, version: want }) {
    await box.setScript({ id: 'stream-turn', messages: { text: 'canary reply' } });
    const s = await box.stream(CHAT_FLAGS);
    try {
      const result = await turn(s, 'hello');
      const lines = s.lines.filter((l): l is Record<string, unknown> => typeof l !== 'string');
      const parsed = lines.map((l) => ({ l, p: parseLine(JSON.stringify(l)) }));

      // The init line, as the portal's reader takes it: a session id, the model, the mode, the credential source.
      const init = parsed.find((x) => x.l.type === 'system' && x.l.subtype === 'init');
      expect(init, 'No system/init line came before the result.', tailOf(s));
      expect(init.p.init === true && typeof init.p.sessionIdSeen === 'string' && !!init.p.sessionIdSeen, 'The init line carries no session id the reader can use.', JSON.stringify(init.l).slice(0, 600));
      expect(typeof init.p.sessionPatch?.model === 'string' && init.p.modeSeen === 'default', 'The init line does not name the model and the permission mode.', JSON.stringify(init.l).slice(0, 600));
      expect(typeof init.l.apiKeySource === 'string', 'The init line has no apiKeySource (the portal’s credential check reads it).', JSON.stringify(init.l).slice(0, 600));
      const reportedVersion = typeof init.l.claude_code_version === 'string' ? init.l.claude_code_version : null;
      expect(reportedVersion === null || reportedVersion === want, `The init line says Claude Code ${reportedVersion}, not ${want}.`);

      // The assistant line and the partial deltas (`--include-partial-messages`).
      const assistant = parsed.find((x) => x.l.type === 'assistant');
      expect(assistant && assistant.p.stored.some((e) => e.kind === 'assistant' && /canary reply/.test(e.text ?? '')), 'The assistant line did not come out as the assistant’s text.', tailOf(s));
      expect(parsed.some((x) => x.p.delta?.text === 'canary reply'), 'No streamed delta carried the reply’s text.', tailOf(s));
      // The replay of the person's own message (`--replay-user-messages`).
      expect(parsed.some((x) => x.l.type === 'user' && x.p.replay), 'The user line was not replayed (isReplay).', tailOf(s));

      // The result: cost, tokens and the turn's end, in the shapes the reader keeps.
      const end = parsed.find((x) => x.l.type === 'result')!;
      expect(end.p.result === true && end.p.stored[0]?.kind === 'result', 'The result line did not come out as a finished turn.', JSON.stringify(result).slice(0, 800));
      expect(result.subtype === 'success' && result.is_error === false, `The turn did not succeed (${String(result.subtype)}).`, JSON.stringify(result).slice(0, 800));
      expect(typeof result.total_cost_usd === 'number' && typeof end.p.sessionPatch?.cost === 'number', 'The result has no numeric total_cost_usd.', JSON.stringify(result).slice(0, 800));
      const usage = result.usage;
      expect(isObj(usage) && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number', 'The result’s usage lacks input and output token counts.', JSON.stringify(result).slice(0, 800));
      expect((end.p.context?.usedTokens ?? 0) > 0, 'The reader computed no context size from the result.', JSON.stringify(end.p).slice(0, 600));
      expect(end.p.sessionPatch?.state === 'idle' && end.p.sessionPatch.turnsDelta === 1, 'The result did not read as one finished turn.', JSON.stringify(end.p).slice(0, 600));
      const ids = new Set(lines.map((l) => l.session_id).filter(Boolean));
      expect(ids.size === 1, `The lines name ${ids.size} session ids, not one.`);
      return pass(`init, assistant, deltas and a result of $${(result.total_cost_usd as number).toFixed(6)} (${(end.p.context?.usedTokens ?? 0)} tokens) all read by the portal`, [init, assistant, end].map((x) => JSON.stringify(x!.l).slice(0, 500)).join('\n'));
    } finally {
      await s.close();
    }
  },
};

/* ---------- control-requests ---------- */

const controlRequests: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'control-requests')!,
  async run({ box }) {
    const s = await box.stream(CHAT_FLAGS);
    const notes: string[] = [];
    try {
      // 1. A tool that needs permission raises `can_use_tool`; the portal's allow answer lets it run.
      await box.setScript({ id: 'allow', steps: [{ tool: 'Bash', input: { command: 'touch canary-allowed.txt', description: 'canary' } }, { text: 'allowed' }] });
      let from = s.lines.length;
      s.sendRaw(userLine('run it'));
      const ask = await nextRequest(s, from);
      const parsed = parseLine(JSON.stringify(ask));
      expect(parsed.request?.kind === 'tool' && parsed.request.toolName === 'Bash' && !!parsed.request.toolUseId && !!parsed.request.requestId, 'The permission request did not come out as a tool request.', JSON.stringify(ask).slice(0, 700));
      expect(isObj(parsed.toolInput) && parsed.toolInput.command === 'touch canary-allowed.txt', 'The request’s tool input was not what the model asked for.', JSON.stringify(ask).slice(0, 700));
      expect(parsed.sessionPatch?.state === 'waiting', 'A permission request did not put the session in waiting.');
      s.sendRaw(allowResponse(String(ask.request_id)));
      await s.waitFor((l) => l.type === 'result' && s.lines.indexOf(l) >= from, TURN_MS, 'the result after allowing');
      const allowed = toolResults(s.lines, from);
      expect(allowed.length === 1 && !allowed[0]!.error, 'The allowed tool did not run.', tailOf(s));
      notes.push(`allow: ${parsed.request!.title} ran (${allowed[0]!.content.slice(0, 60)})`);

      // 2. The same tool, denied with a message: the agent gets an error result that carries it.
      await box.setScript({ id: 'deny', steps: [{ tool: 'Bash', input: { command: 'touch canary-denied.txt', description: 'canary' } }, { text: 'denied' }] });
      from = s.lines.length;
      s.sendRaw(userLine('run it again'));
      const ask2 = await nextRequest(s, from);
      s.sendRaw(denyResponse(String(ask2.request_id), 'canary says no'));
      await s.waitFor((l) => l.type === 'result' && s.lines.indexOf(l) >= from, TURN_MS, 'the result after denying');
      const denied = toolResults(s.lines, from);
      expect(denied.length === 1 && denied[0]!.error && /canary says no/.test(denied[0]!.content), 'A denied tool did not come back as an error carrying the message.', tailOf(s));
      notes.push('deny: the tool result is an error with the portal’s message');

      // 3. `set_model`: answered with success, and the next request names the new model.
      await box.setScript({ id: 'model', messages: { text: 'after the switch' } });
      await box.resetSeen();
      s.sendRaw(controlRequest('canary-set-model', 'set_model', { model: 'claude-sonnet-4-5' }));
      const sm = await s.waitFor((l) => l.type === 'control_response' && (l.response as { request_id?: string } | undefined)?.request_id === 'canary-set-model', 30_000, 'the set_model answer');
      const smParsed = parseLine(JSON.stringify(sm));
      expect(smParsed.controlResponse?.ok === true, `set_model was refused: ${JSON.stringify(sm).slice(0, 300)}`, JSON.stringify(sm).slice(0, 600));
      await turn(s, 'which model');
      const models = (await box.seen()).filter((x) => x.path.startsWith('/v1/messages') && (x.tools?.length ?? 0) > 0).map((x) => x.model);
      expect(models.at(-1) === 'claude-sonnet-4-5', `The turn after set_model used ${models.at(-1) ?? 'no model'}.`, JSON.stringify(models));
      notes.push('set_model: answered, the next turn used claude-sonnet-4-5');

      // 4. `interrupt` during a held reply: answered, and the turn ends.
      await box.setScript({ id: 'slow', steps: [{ text: 'a slow reply', delayMs: 40_000 }] });
      from = s.lines.length;
      s.sendRaw(userLine('a slow one'));
      await s.waitFor((l) => l.type === 'system' && l.subtype === 'status' && s.lines.indexOf(l) >= from, 30_000, 'the slow turn to start');
      await new Promise((r) => setTimeout(r, 1200));
      s.sendRaw(interruptRequest('canary-interrupt'));
      const ir = await s.waitFor((l) => l.type === 'control_response' && (l.response as { request_id?: string } | undefined)?.request_id === 'canary-interrupt', 20_000, 'the interrupt answer');
      expect((ir.response as { subtype?: string }).subtype === 'success', `interrupt was refused: ${JSON.stringify(ir).slice(0, 300)}`, JSON.stringify(ir).slice(0, 600));
      await s.waitFor((l) => l.type === 'result' && s.lines.indexOf(l) >= from, 30_000, 'the interrupted turn to end');
      notes.push('interrupt: answered, the turn ended');
      return pass('can_use_tool allow and deny, set_model and interrupt all behave as the chat host expects', notes.join('\n'));
    } finally {
      await s.close();
    }
  },
};

/* ---------- get-usage ---------- */

const iso = (ms: number) => new Date(ms).toISOString();

const getUsage: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'get-usage')!,
  async run({ box }) {
    const at5h = Date.now() + 3 * 3600_000;
    const atWeek = Date.now() + 4 * 86_400_000;
    await box.setScript({
      usage: {
        body: {
          five_hour: { utilization: 41, resets_at: iso(at5h) },
          seven_day: { utilization: 63, resets_at: iso(atWeek) },
          seven_day_oauth_apps: null,
          seven_day_opus: { utilization: 12.5, resets_at: iso(atWeek) },
          seven_day_sonnet: null,
          extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
        },
      },
    });
    await box.resetSeen();
    // The portal's own probe, unchanged, over an exec into the container.
    const r = await probeClaude({ exec: (_target, _name, command) => box.exec(command) }, 'canary', 'canary', '');
    const shown = JSON.stringify({ runsOn: r.runsOn, plan: r.plan, problem: r.problem, windows: r.windows.map((w) => [w.key, w.usedPct]) });
    expect(!r.failed && r.runsOn === 'plan' && r.plan === 'max', `The usage probe did not read a plan (${r.problem ?? r.runsOn}).`, shown);
    expect(JSON.stringify(r.windows.map((w) => [w.key, w.usedPct, w.resetsAtMs])) === JSON.stringify([['session', 41, Date.parse(iso(at5h))], ['week', 63, Date.parse(iso(atWeek))], ['week_opus', 12.5, Date.parse(iso(atWeek))]]), 'The usage windows did not come out as the stand-in sent them.', shown);
    const seen = await box.seen();
    expect(seen.some((q) => q.path.startsWith('/api/oauth/usage')), 'Claude Code did not ask the usage endpoint.', JSON.stringify(seen.map((q) => q.path)));
    expect(!seen.some((q) => q.path.includes('/v1/messages')), 'The usage probe made a model request.', JSON.stringify(seen.map((q) => q.path)));
    expect(!seen.some((q) => q.method === 'CONNECT-REFUSED'), 'Claude Code tried to reach a host the stand-in refuses.', JSON.stringify(seen.filter((q) => q.method === 'CONNECT-REFUSED')));
    return pass('get_usage answered with the plan’s windows (session 41, week 63, Opus 12.5), no model request', shown);
  },
};

/* ---------- rate-limit-event ---------- */

const rateLimitEvent: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'rate-limit-event')!,
  async run({ box }) {
    const reset5h = Math.floor(Date.now() / 1000) + 7200;
    const resetWeek = reset5h + 200_000;
    const unified = (status: string, five: string, seven: string): Record<string, string> => ({
      'anthropic-ratelimit-unified-status': status,
      'anthropic-ratelimit-unified-reset': String(reset5h),
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-5h-utilization': five,
      'anthropic-ratelimit-unified-5h-reset': String(reset5h),
      'anthropic-ratelimit-unified-7d-utilization': seven,
      'anthropic-ratelimit-unified-7d-reset': String(resetWeek),
    });
    const notes: string[] = [];

    // 1. A turn whose response carries the unified headers streams a rate_limit_event the usage parser reads.
    await box.setScript({ id: 'rl-warn', messages: { text: 'ok', headers: unified('allowed_warning', '0.82', '0.63') } });
    let s = await box.stream(CHAT_FLAGS);
    try {
      await turn(s, 'hello');
      const ev = s.lines.map(obj).find((l) => l?.type === 'rate_limit_event' && isObj((l.rate_limit_info as Record<string, unknown>)?.unifiedWindows));
      expect(ev, 'No rate_limit_event carried the unified windows.', tailOf(s));
      const p = parseRateLimitInfo(ev.rate_limit_info);
      const got = JSON.stringify(p?.windows.map((w) => [w.key, w.usedPct, w.resetsAtMs]));
      expect(got === JSON.stringify([['session', 82, reset5h * 1000], ['week', 63, resetWeek * 1000]]) && p?.rejected.length === 0, 'The usage parser did not read the event’s windows.', JSON.stringify(ev).slice(0, 800));
      expect(parseLine(JSON.stringify(ev)).rateLimitEvent === true, 'The chat reader did not take the line as a rate-limit event.');
      notes.push(`warning headers: windows ${got}`);
    } finally {
      await s.close();
    }

    // 2. A refused turn (429, rejected): the event, the usage_limit_reached line and an error result, and no retry.
    await box.setScript({
      id: 'rl-rejected',
      messages: { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }, headers: { ...unified('rejected', '1.0', '0.71'), 'retry-after': '3600' } },
    });
    s = await box.stream(CHAT_FLAGS);
    try {
      const result = await turn(s, 'hello again');
      const ev = s.lines.map(obj).find((l) => l?.type === 'rate_limit_event');
      expect(ev, 'A refused turn streamed no rate_limit_event.', tailOf(s));
      const p = parseRateLimitInfo(ev.rate_limit_info);
      expect(JSON.stringify(p?.rejected) === JSON.stringify(['session']) && p?.windows.find((w) => w.key === 'session')?.usedPct === 100, 'The refused turn’s event did not read as the session window rejected.', JSON.stringify(ev).slice(0, 800));
      const refusal = s.lines.map(obj).find((l) => l?.type === 'assistant' && l.api_error === 'usage_limit_reached');
      expect(refusal, 'No assistant line said usage_limit_reached.', tailOf(s));
      expect(parseRateLimitInfo((refusal.api_error_params as { rate_limit_info?: unknown } | undefined)?.rate_limit_info)?.rejected[0] === 'session', 'The usage_limit_reached line carries no rate_limit_info the parser reads.', JSON.stringify(refusal).slice(0, 800));
      expect(!s.lines.some((l) => obj(l)?.type === 'api_retry') && result.is_error === true, 'A usage limit was retried, or the result was not an error.', tailOf(s));
      notes.push('429 rejected: event, usage_limit_reached line and an error result, no retry');
    } finally {
      await s.close();
    }
    return pass('rate_limit_event and usage_limit_reached are read by the usage parser', notes.join('\n'));
  },
};

/* ---------- probe-safe-mode ---------- */

/** One probe run in a project with hooks: the get_usage reply (null when none came), the last output, and the hook markers left (space separated). */
export interface SafeModeRun {
  reply: Record<string, unknown> | null;
  out: string;
  ran: string;
}

/** What the probe-safe-mode check observed; `judgeSafeMode` applies the four guards to it (pure, so each guard is tested passing and failing). */
export interface SafeModeObservation {
  /** `claude --help` lists `--safe-mode`. */
  helpListsFlag: boolean;
  helpOut: string;
  /** The portal's own probe command, as `probeCommand` builds it. */
  own: string[];
  /** The probe with the flag, without it (the control), and with `CLAUDE_CODE_SAFE_MODE=1` in the environment alone. */
  safe: SafeModeRun;
  bare: SafeModeRun;
  envOnly: SafeModeRun;
}

const windowsOf = (p: ReturnType<typeof parseUsageReply> | null) => (p && p.kind === 'plan' ? JSON.stringify(p.windows.map((w) => [w.key, w.usedPct, w.resetsAtMs])) : null);

/**
 * The four safe-mode guards (docs/prd/claude-version-pinning.md §16.1), in order; the first that fails fails the check with its own words.
 * (a) flag: the CLI's help lists `--safe-mode` (2.1.168 and older answer "unknown option" and start nothing).
 * (b) hook marker: under the flag no SessionStart or SessionEnd hook of the Claude's or the project's settings leaves a marker, AND without it they do
 *     (else the marker test proves nothing: the hooks did not run at all).
 * (c) get_usage: under the flag it still answers, as a plan with windows, the same windows as without the flag.
 * (d) the variable is not a substitute: the portal's command must pass the flag itself. `CLAUDE_CODE_SAFE_MODE=1` in the environment alone was
 *     observed to stop no hook (2.1.296), so a command that carries only the variable counts as unsafe; what the variable alone does is reported.
 */
export function judgeSafeMode(o: SafeModeObservation): CheckOutcome {
  const notes: string[] = [];
  // (a)
  expect(o.helpListsFlag, '`claude --help` does not list --safe-mode.', o.helpOut);
  notes.push('flag: --safe-mode is listed in the help');
  // (b)
  expect(o.safe.ran === '', `With --safe-mode these hooks still ran during a probe: ${o.safe.ran}.`, o.safe.out);
  expect(o.bare.ran !== '', 'Without --safe-mode no hook left its marker either: the hook marker test proves nothing on this version.', o.bare.out);
  notes.push(`hooks: none ran under the flag; without it ${o.bare.ran} ran`);
  // (c)
  expect(o.safe.reply, 'get_usage did not answer under --safe-mode.', o.safe.out);
  const parsed = parseUsageReply(o.safe.reply);
  expect(parsed.kind === 'plan' && parsed.windows.length >= 2, `get_usage under --safe-mode did not read as a plan with windows (${parsed.kind}).`, JSON.stringify(o.safe.reply).slice(0, 700));
  const bare = o.bare.reply ? parseUsageReply(o.bare.reply) : null;
  expect(windowsOf(bare) === windowsOf(parsed), 'get_usage answers differently under --safe-mode than without it (plan or windows changed).', `${windowsOf(parsed)} against ${windowsOf(bare) ?? JSON.stringify(bare)}`);
  notes.push(`get_usage: a plan with ${parsed.windows.length} windows under the flag, the same as without it`);
  // (d)
  const claudeAt = o.own.indexOf('claude');
  const flagged = claudeAt >= 0 && o.own.slice(claudeAt + 1).includes('--safe-mode');
  const envOnly = o.own.some((a) => /^CLAUDE_CODE_SAFE_MODE=/.test(a));
  expect(
    flagged,
    envOnly
      ? 'The usage probe’s command sets CLAUDE_CODE_SAFE_MODE but does not pass --safe-mode: the variable alone is not a substitute, every poll runs the user’s own hooks.'
      : `The usage probe’s own command does not pass --safe-mode: every poll of a workspace runs the user’s own hooks (observed: ${o.bare.ran}).`,
    `${notes.join('\n')}\n${o.own.slice(Math.max(0, claudeAt)).join(' ')}`,
  );
  notes.push(o.envOnly.ran ? `variable: CLAUDE_CODE_SAFE_MODE=1 alone is not a substitute (hooks ran: ${o.envOnly.ran}); the probe passes the flag` : 'variable: CLAUDE_CODE_SAFE_MODE=1 alone now stops the hooks too; the probe still passes the flag');
  return pass('the probe passes --safe-mode: it is in the help, no hook runs under it (and they do without it), get_usage reads the same plan and windows', notes.join('\n'));
}

const probeSafeMode: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'probe-safe-mode')!,
  async run({ box }) {
    const HOOKS = ['SessionStart', 'SessionEnd'];
    const PROJECT = `${BOX_HOME}/work/proj`;
    const hook = (where: string, n: string) => [{ hooks: [{ type: 'command', command: `touch ${BOX_DIR}/hook-${where}-${n}` }] }];
    const settingsOf = (where: string) => JSON.stringify({ hooks: Object.fromEntries(HOOKS.map((n) => [n, hook(where, n)])) });
    const markers = async () => (await box.sh(`ls ${BOX_DIR} 2>/dev/null | grep '^hook-' | sed 's/^hook-//' | sort | tr '\\n' ' '`)).stdout.trim();
    const at5h = Date.now() + 3 * 3600_000;
    const body = { five_hour: { utilization: 41, resets_at: new Date(at5h).toISOString() }, seven_day: { utilization: 63, resets_at: new Date(at5h + 86_400_000).toISOString() }, seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null } };
    // The portal's OWN probe command, as it is now; the runs below add or take away the flag, to learn what the CLI does either way.
    const own = probeCommand('');
    const withFlag = own.includes('--safe-mode') ? own : [...own, '--safe-mode'];
    const withoutFlag = own.filter((a) => a !== '--safe-mode');
    // The variable alone, in the one place the probe's `env -i` wrapper takes assignments: before `timeout`.
    const at = withoutFlag.indexOf('timeout');
    const envOnly = [...withoutFlag.slice(0, at), 'CLAUDE_CODE_SAFE_MODE=1', ...withoutFlag.slice(at)];
    const ask = async (command: string[]): Promise<SafeModeRun> => {
      await box.sh(`rm -f ${BOX_DIR}/hook-*`);
      // In a project that has its own hooks, as a probe in an agent's working folder would.
      const session = await box.exec(command, { cwd: PROJECT });
      let out = '';
      let ended = false;
      session.onData((d) => (out += d.toString('utf8')));
      session.onExit(() => (ended = true));
      session.write(`${JSON.stringify({ type: 'control_request', request_id: 'canary-usage', request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
      let reply: Record<string, unknown> | null = null;
      for (let i = 0; i < 300 && !reply && !ended; i++) {
        await new Promise((r) => setTimeout(r, 100));
        for (const line of out.split('\n')) {
          if (!line.includes('"control_response"')) continue;
          try {
            const o = JSON.parse(line) as { response?: { request_id?: string; subtype?: string; response?: Record<string, unknown> } };
            if (o.response?.request_id === 'canary-usage' && o.response.subtype === 'success') reply = o.response.response ?? {};
          } catch {
            // not a whole line yet
          }
        }
      }
      session.close(); // stdin ends: the session ends, and SessionEnd hooks run
      for (let i = 0; i < 40 && !ended; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 600));
      return { reply, out: out.slice(-600), ran: await markers() };
    };

    await box.put([box.dir(`${BOX_HOME}/.claude`, 0o700), box.file(`${BOX_HOME}/.claude/settings.json`, settingsOf('user')), box.dir(PROJECT), box.dir(`${PROJECT}/.claude`), box.file(`${PROJECT}/.claude/settings.json`, settingsOf('project'))]);
    try {
      await box.setScript({ usage: { body } });
      await box.resetSeen();
      const help = await box.sh(`${shq(box.claude)} --help 2>&1 | grep -c -- '--safe-mode' || true`, { timeoutMs: 60_000 });
      const helpListsFlag = Number(help.stdout.trim()) > 0;
      // Without the flag in the help, the runs below would only show "unknown option": fail on the help alone.
      if (!helpListsFlag) return judgeSafeMode({ helpListsFlag, helpOut: help.stdout, own, safe: { reply: null, out: '', ran: '' }, bare: { reply: null, out: '', ran: '' }, envOnly: { reply: null, out: '', ran: '' } });
      return judgeSafeMode({ helpListsFlag, helpOut: help.stdout, own, safe: await ask(withFlag), bare: await ask(withoutFlag), envOnly: await ask(envOnly) });
    } finally {
      await box.sh(`rm -f ${shq(`${BOX_HOME}/.claude/settings.json`)} ${shq(`${PROJECT}/.claude/settings.json`)} ${BOX_DIR}/hook-*`).catch(() => undefined);
    }
  },
};

/* ---------- managed-settings ---------- */

const DROPINS = '/etc/claude-code/managed-settings.d';

const managedSettings: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'managed-settings')!,
  async run({ box }) {
    const notes: string[] = [];
    const root = (script: string) => box.sh(script, { user: 'root' });
    await box.sh(`printf '%s' 'top secret' > ${BOX_HOME}/work/secret-one.txt; printf '%s' 'also secret' > ${BOX_HOME}/work/secret-two.txt`);
    // The folder must exist when a session starts (Claude Code watches it only then). An image from before the pin does not bake it in: the
    // delivery engine creates it in such workspaces, so the canary does too and tests the CLI, not the image's age.
    await root(`mkdir -p -m 755 ${DROPINS}`);
    try {
      // Two drop-ins before the session starts: a deny rule and an env entry in one, another env entry in the other.
      await root(`printf '%s' '{"permissions":{"deny":["Read(/${BOX_HOME}/work/secret-one.txt)"]},"env":{"CANARY_ENV_A":"alpha"}}' > ${DROPINS}/50-canary-a.json; printf '%s' '{"env":{"CANARY_ENV_B":"beta"}}' > ${DROPINS}/60-canary-b.json`);
      await box.setScript({ id: 'managed-1', steps: [{ tool: 'Read', input: { file_path: `${BOX_HOME}/work/secret-one.txt` } }, { tool: 'Bash', input: { command: 'printenv CANARY_ENV_A CANARY_ENV_B', description: 'env' } }, { text: 'done' }] });
      const s = await box.stream(CHAT_FLAGS);
      try {
        const from = s.lines.length;
        s.sendRaw(userLine('go'));
        // The Bash call may ask for permission; allow it (the point is its environment, not the prompt).
        const handled = new Set<string>();
        const deadline = Date.now() + TURN_MS;
        while (Date.now() < deadline && !s.lines.some((l, i) => i >= from && obj(l)?.type === 'result')) {
          const ask = s.lines.map(obj).find((l, i) => i >= from && l?.type === 'control_request' && !handled.has(String(l.request_id)));
          if (ask) {
            handled.add(String(ask.request_id));
            s.sendRaw(allowResponse(String(ask.request_id)));
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        const results = toolResults(s.lines, from);
        expect(results.length === 2, 'The scripted tool calls did not both return.', tailOf(s));
        expect(results[0]!.error && /denied/.test(results[0]!.content), 'A deny rule in a managed drop-in did not stop the Read.', JSON.stringify(results));
        expect(!results[1]!.error && /alpha\s+beta/.test(results[1]!.content), 'The env entries of two managed drop-ins were not both in the tool’s environment.', JSON.stringify(results));
        notes.push('deny rule: Read refused; env: two drop-ins merged (alpha, beta)');

        // The folder is watched: a drop-in rewritten while this session runs reaches it.
        await root(`printf '%s' '{"permissions":{"deny":["Read(/${BOX_HOME}/work/secret-one.txt)","Read(/${BOX_HOME}/work/secret-two.txt)"]},"env":{"CANARY_ENV_A":"alpha"}}' > ${DROPINS}/50-canary-a.json.tmp && mv ${DROPINS}/50-canary-a.json.tmp ${DROPINS}/50-canary-a.json`);
        await new Promise((r) => setTimeout(r, 2500));
        await box.setScript({ id: 'managed-2', steps: [{ tool: 'Read', input: { file_path: `${BOX_HOME}/work/secret-two.txt` } }, { text: 'done again' }] });
        const second = s.lines.length;
        await turn(s, 'go again');
        const again = toolResults(s.lines, second);
        expect(again.length === 1 && again[0]!.error && /denied/.test(again[0]!.content), 'A drop-in rewritten during a session did not reach it (the folder is not watched).', tailOf(s));
        notes.push('watched folder: a rule added during the session applied');
      } finally {
        await s.close();
      }

      // The MCP lockdown keys: a server the user's own config names disappears, and `claude mcp add` is refused.
      await box.sh(`node -e "const f='${BOX_HOME}/.claude.json';const j=JSON.parse(require('fs').readFileSync(f,'utf8'));j.mcpServers={'canary-user':{type:'stdio',command:'node',args:['-e','0']}};require('fs').writeFileSync(f,JSON.stringify(j))"`);
      const before = await box.sh(`${shq(box.claude)} mcp list 2>&1 | head -6`, { timeoutMs: 60_000 });
      expect(/canary-user/.test(before.stdout), 'Before the lockdown, claude mcp list did not show the user’s own server.', before.stdout);
      await root(`printf '%s' '{"allowManagedMcpServersOnly":true,"allowedMcpServers":[]}' > ${DROPINS}/05-canary-lock.json`);
      const after = await box.sh(`${shq(box.claude)} mcp list 2>&1 | head -6`, { timeoutMs: 60_000 });
      expect(!/canary-user/.test(after.stdout), 'The MCP lockdown keys did not hide the user’s own server.', after.stdout);
      const add = await box.sh(`${shq(box.claude)} mcp add canary-two -- node -e 0 2>&1 | head -4`, { timeoutMs: 60_000 });
      expect(/not allowed by enterprise policy/.test(add.stdout), 'claude mcp add was not refused under the lockdown.', add.stdout);
      notes.push('MCP lockdown: the user’s server is hidden and `claude mcp add` is refused (“not allowed by enterprise policy”)');
      return pass('managed drop-ins: deny rule, merged env, watched folder and the MCP lockdown keys work', notes.join('\n'));
    } finally {
      await root(`rm -f ${DROPINS}/50-canary-a.json ${DROPINS}/50-canary-a.json.tmp ${DROPINS}/60-canary-b.json ${DROPINS}/05-canary-lock.json`).catch(() => undefined);
      await box.sh(`node -e "const f='${BOX_HOME}/.claude.json';const j=JSON.parse(require('fs').readFileSync(f,'utf8'));delete j.mcpServers;require('fs').writeFileSync(f,JSON.stringify(j))"`).catch(() => undefined);
    }
  },
};

/* ---------- session-host ---------- */

const sessionHost: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'session-host')!,
  async run({ box }) {
    const host = `${BOX_DIR}/cp-session`;
    const base = `${BOX_DIR}/sessions`;
    const id = randomUUID();
    const env = { CLAUDEPILOT_SESSIONS_DIR: base };
    await box.put([box.dir(BOX_DIR), box.file(host, CP_SESSION, 0o755)]);
    await box.setScript({ id: 'host', messages: { text: 'through the host' } });
    const sh = (script: string, ms = 60_000) => box.sh(`${script}`, { env, timeoutMs: ms });
    try {
      // The same call the chat controller makes: `start <id> <seg> <cwd> -- <flags> --session-id <id>`; it prints "<pid> <time>".
      const start = await sh(`${shq(host)} start ${id} 1 ${BOX_HOME}/work -- -p ${CHAT_FLAGS.map(shq).join(' ')} --session-id ${id}`);
      expect(start.code === 0 && /^\d+ \d{4}-\d\d-\d\dT/.test(start.stdout.trim()), 'cp-session start did not print "<pid> <time>".', `${start.stdout}\n${start.stderr}`.trim());
      const line = userLine('hello through the host');
      const send = await sh(`printf '%s' ${shq(line)} | ${shq(host)} send ${id} canary-1 ${Buffer.byteLength(line)}`);
      expect(send.code === 0, `cp-session send failed (exit ${send.code}).`, `${send.stdout}\n${send.stderr}`.trim());
      // The segment file is what the portal's reader tails; wait for the turn's result in it.
      let out = '';
      for (let i = 0; i < 300 && !/"type":"result"/.test(out); i++) {
        await new Promise((r) => setTimeout(r, 300));
        out = (await box.read(`${base}/${id}/out.1.jsonl`)) ?? '';
      }
      const lines = out.split('\n').filter((l) => l.startsWith('{'));
      expect(/"type":"result"/.test(out), 'The segment file never got the turn’s result.', `${out.slice(-800)}\n${(await box.read(`${base}/${id}/err.log`)) ?? ''}`.trim());
      const parsed = lines.map((l) => parseLine(l));
      expect(parsed.some((p) => p.init === true && p.sessionIdSeen === id), 'The segment’s init line does not carry the session id the host started it under.', lines.slice(0, 3).join('\n').slice(0, 600));
      expect(parsed.some((p) => p.stored.some((e) => e.kind === 'assistant' && /through the host/.test(e.text ?? ''))), 'The segment has no assistant line with the reply.', lines.slice(-4).join('\n').slice(0, 800));
      expect(parsed.some((p) => p.result === true), 'The reader found no result in the segment.');
      const status = await sh(`${shq(host)} status ${id}`);
      expect(/^live \d+/.test(status.stdout.trim()), `cp-session status said “${status.stdout.trim()}”, not live.`);
      await sh(`${shq(host)} stop ${id}`);
      let gone = '';
      for (let i = 0; i < 40 && !/^gone/.test(gone); i++) {
        await new Promise((r) => setTimeout(r, 250));
        gone = (await sh(`${shq(host)} status ${id}`)).stdout.trim();
      }
      expect(/^gone/.test(gone), `After stop, cp-session status said “${gone}”.`);
      return pass('cp-session started a session, took a message, wrote the turn to its segment file and stopped it', `${start.stdout.trim()}\n${lines.length} lines in out.1.jsonl; status live, then gone`);
    } finally {
      await sh(`${shq(host)} stop ${id}; true`).catch(() => undefined);
      await box.killClaude();
    }
  },
};

/* ---------- btw-oneshot ---------- */

const btwOneshot: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'btw-oneshot')!,
  async run({ box }) {
    const HOOKS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
    const marker = (n: string) => `${BOX_DIR}/hook-${n}`;
    const settings = `${BOX_HOME}/.claude/settings.json`;
    const markers = async () => (await box.sh(`ls ${BOX_DIR} 2>/dev/null | grep '^hook-' | sed 's/^hook-//' | sort | tr '\\n' ' '`)).stdout.trim();
    const sessionFiles = async () => Number((await box.sh(`find ${BOX_HOME}/.claude/projects -name '*.jsonl' 2>/dev/null | wc -l`)).stdout.trim() || '0');
    const prompt = userLine('<session_transcript>The user asked for a haiku. The assistant wrote one.</session_transcript>\nQuestion: what did the user ask for?');
    // The portal's OWN side-question command (chat/btwRun.ts), the wrapper and all: the canary asks what this Claude Code does with it.
    const ownCommand = btwCommand({ claudeDir: '', model: null, effort: 'low', maxCostUsd: 0.5, limitSeconds: 90, maxOutputTokens: 1024 });
    const absent = ['--safe-mode', '--no-session-persistence', '--tools', '--strict-mcp-config'].filter((f) => !ownCommand.includes(f));
    expect(absent.length === 0, `The portal’s own side-question command lacks ${absent.join(', ')}: a side question would not be tool-free and hook-free.`, ownCommand.slice(ownCommand.indexOf('claude')).join(' ').slice(0, 400));
    const oneShot = async (command: string[]) => {
      const s = await box.streamCommand(command, { cwd: BOX_HOME });
      try {
        s.sendRaw(prompt);
        const result = await s.waitFor((l) => l.type === 'result', TURN_MS, 'the one-shot’s result');
        await new Promise((r) => setTimeout(r, 1500)); // a Stop hook runs after the result
        return { s, result, init: s.lines.map(obj).find((l) => l?.type === 'system' && l.subtype === 'init') };
      } finally {
        await s.close();
      }
    };
    const notes: string[] = [];
    // A user's own hooks, which a side question must never run.
    await box.put([box.file(settings, JSON.stringify({ hooks: Object.fromEntries(HOOKS.map((n) => [n, [{ hooks: [{ type: 'command', command: `touch ${marker(n)}` }] }]])) }))]);
    try {
      await box.sh(`rm -f ${BOX_DIR}/hook-*`);
      await box.setScript({ id: 'btw', messages: { text: 'btw answer', always: true } });
      await box.resetSeen();
      const filesBefore = await sessionFiles();
      const { s, result, init } = await oneShot(ownCommand);
      const shown = tailOf(s);
      // 1. The init line the portal reads before it shows anything: no tools, no MCP servers.
      expect(init && Array.isArray(init.tools) && Array.isArray(init.mcp_servers), 'The one-shot’s init line has no tools and mcp_servers lists.', shown);
      expect((init.tools as unknown[]).length === 0 && (init.mcp_servers as unknown[]).length === 0, `The one-shot’s init line lists tools ${JSON.stringify(init.tools).slice(0, 120)} and servers ${JSON.stringify(init.mcp_servers).slice(0, 120)}: the portal would refuse the answer as unsafe.`, shown);
      // 2. No model request of the run offered a tool.
      const asked = (await box.seen()).filter((x) => x.path.startsWith('/v1/messages'));
      expect(asked.length > 0 && asked.every((x) => (x.tools?.length ?? 0) === 0), `A model request of the one-shot offered tools: ${JSON.stringify(asked.map((x) => x.tools))}.`, shown);
      // 3. --safe-mode: no user hook ran.
      const ran = await markers();
      expect(ran === '', `With --safe-mode these user hooks still ran: ${ran}.`, shown);
      // 4. --no-session-persistence: no session file.
      const filesAfter = await sessionFiles();
      expect(filesAfter === filesBefore, `The one-shot wrote ${filesAfter - filesBefore} session file(s).`, shown);
      // 5. The result carries what the portal records.
      expect(result.subtype === 'success' && result.is_error === false && result.result === 'btw answer', `The one-shot’s result was not a plain success with the answer (${String(result.subtype)}).`, JSON.stringify(result).slice(0, 700));
      const usage = result.usage;
      expect(isObj(usage) && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number' && typeof result.total_cost_usd === 'number', 'The one-shot’s result lacks usage tokens or total_cost_usd.', JSON.stringify(result).slice(0, 700));
      notes.push(`no tools, no MCP servers, no hook ran, no session file, result usage ${usage.input_tokens}/${usage.output_tokens} tokens at $${(result.total_cost_usd as number).toFixed(6)}`);

      // The control: the same run without --safe-mode does run the hooks (which is what the flag is for). Reported, not required.
      await box.sh(`rm -f ${BOX_DIR}/hook-*`);
      await oneShot(ownCommand.filter((a) => a !== '--safe-mode'));
      const control = await markers();
      notes.push(control ? `control: without --safe-mode these hooks ran: ${control}` : 'control: no hook ran without --safe-mode either, so the flag could not be shown to matter');
      await box.sh(`rm -f ${BOX_DIR}/hook-*`);

      // Observed, never failed: `/btw` as a stream-json user line, and the `side_question` control request on a live process.
      const live = await box.stream(CHAT_FLAGS);
      try {
        let from = live.lines.length;
        live.sendRaw(userLine('/btw what is this'));
        const local = await live.waitFor((l) => l.type === 'result' && live.lines.indexOf(l) >= from, 60_000, 'the /btw result').catch(() => null);
        notes.push(local && /isn't available in this environment/.test(String(local.result)) ? 'info: /btw as a user line is answered locally (“isn’t available in this environment”)' : `info: /btw as a user line now does something else (${String(local?.result ?? 'no result').slice(0, 80)}): the side-question design assumed it is answered locally`);
        from = live.lines.length;
        live.sendRaw(controlRequest('canary-side-question', 'side_question', { question: 'what was the last thing?' }));
        const sq = await live.waitFor((l) => l.type === 'control_response' && (l.response as { request_id?: string } | undefined)?.request_id === 'canary-side-question', 30_000, 'the side_question answer').catch(() => null);
        const body = sq?.response as { subtype?: string; error?: string } | undefined;
        notes.push(body?.subtype === 'success' ? 'info: the side_question control request answers on a live process' : `info: side_question ${body ? `was refused (${String(body.error).slice(0, 80)})` : 'got no answer'}`);
      } finally {
        await live.close();
      }
      const info = notes.filter((n) => n.startsWith('info:')).length;
      return pass(`tool-free one-shot: ${notes[0]}${info ? ` (${info} informational items in the detail)` : ''}`, notes.join('\n'));
    } finally {
      await box.sh(`rm -f ${shq(settings)} ${BOX_DIR}/hook-*`).catch(() => undefined);
    }
  },
};

/* ---------- update-pin ---------- */

const updatePin: CanaryCheck = {
  def: CLAUDE_CANARY_CHECKS.find((d) => d.id === 'update-pin')!,
  async run({ box, firstReported }) {
    const claude = shq(box.claude);
    const doctor = await box.sh(`${claude} doctor 2>&1 | grep -E '^(Running|Auto-update)'`, { timeoutMs: 60_000 });
    expect(/^Auto-updates:\s*disabled/m.test(doctor.stdout), 'claude doctor does not report auto-updates as disabled.', doctor.stdout);
    // The switch must hold without the environment too: it is also a managed-settings entry in the image.
    const bare = await box.sh(`env -u DISABLE_AUTOUPDATER -u DISABLE_UPDATES ${claude} doctor 2>&1 | grep -E '^Auto-update'`, { timeoutMs: 60_000 });
    expect(/^Auto-updates:\s*disabled/m.test(bare.stdout), 'With the DISABLE_* variables removed, claude doctor reports auto-updates on: the managed-settings entry is missing or ignored.', bare.stdout);
    const update = await box.sh(`${claude} update 2>&1 | head -3`, { timeoutMs: 60_000 });
    expect(/Updates are disabled by your administrator/.test(update.stdout), '`claude update` did not refuse.', update.stdout);
    const now = await box.sh(`${claude} --version`);
    const after = /^(\d+\.\d+\.\d+)/.exec(now.stdout.trim())?.[1] ?? null;
    expect(after !== null && after === firstReported.value, `The installed version changed during the run: ${firstReported.value ?? 'unknown'} then ${after ?? 'unreadable'}.`, now.stdout);
    return pass(`auto-updates disabled (also without the environment), claude update refuses, still ${after} after the run`, `${doctor.stdout.trim()}\n${update.stdout.trim()}`);
  },
};

/* ---------- The registry of checks ---------- */

const CORE: CanaryCheck[] = [version, streamTurn, controlRequests, getUsage, rateLimitEvent, probeSafeMode, ...MCP_CHECKS, managedSettings, sessionHost, btwOneshot];
const extra: CanaryCheck[] = [];

/**
 * Other areas add a check here (a definition and its runner): it runs after the core ones and before `update-pin`, which stays last because it
 * asserts the version is unchanged after everything else ran. A duplicate id is a programming error.
 */
export function registerCanaryCheck(check: CanaryCheck): void {
  if ([...CORE, ...extra, updatePin].some((c) => c.def.id === check.def.id)) throw new Error(`A canary check “${check.def.id}” is already registered.`);
  extra.push(check);
}

/** Every check in the order they run: the contracts' order, then registered extras, `update-pin` last. */
export function canaryChecks(): CanaryCheck[] {
  const core = [...CORE];
  const order = new Map(CLAUDE_CANARY_CHECKS.map((d, i) => [d.id, i]));
  core.sort((a, b) => (order.get(a.def.id) ?? 999) - (order.get(b.def.id) ?? 999));
  return [...core, ...extra, updatePin];
}

export { CheckFailed };
export { CHAT_FLAGS };
