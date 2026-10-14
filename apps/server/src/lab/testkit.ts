// Efficiency lab tests: a small synthetic session tape, built at runtime (no real transcript, no token-shaped literal). It has the shapes
// the reference script reacts to: an orchestrator that starts two sub-agents (one with a ticket in its prompt), a message reported on two
// lines (the last report wins), 5 minute, 1 hour and legacy cache writes, a cache miss that re-writes context, two requests at the same
// time, an RTK command, inspection, a Claude Code `<synthetic>` message, a result whose call was never seen, non-ASCII result text, and a
// slice whose length in minutes is an exact tie for rounding. `marker` is put in every place that holds text, so a test can prove that
// none of it is stored.

export const TAPE_SESSION = 'a1b2c3d4-0000-4000-8000-00000000c0de';
export const T0 = Date.UTC(2026, 9, 14, 5, 0, 0);

const iso = (ms: number) => new Date(ms).toISOString();

interface Usage {
  input?: number;
  read?: number;
  /** cache_creation_input_tokens */
  write?: number;
  /** the TTL split; absent: the legacy shape without `cache_creation` */
  w5?: number;
  w1?: number;
  out?: number;
}

function usage(u: Usage) {
  return {
    input_tokens: u.input ?? 2,
    cache_read_input_tokens: u.read ?? 0,
    cache_creation_input_tokens: u.write ?? 0,
    ...(u.w5 !== undefined || u.w1 !== undefined ? { cache_creation: { ephemeral_5m_input_tokens: u.w5 ?? 0, ephemeral_1h_input_tokens: u.w1 ?? 0 } } : {}),
    output_tokens: u.out ?? 0,
  };
}

const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command, description: 'step' } });

function assistant(par: string | null, id: string, at: number | null, model: string, u: Usage, content: unknown[]) {
  return JSON.stringify({
    type: 'assistant',
    message: { id, type: 'message', role: 'assistant', model, content, usage: usage(u) },
    parent_tool_use_id: par,
    session_id: TAPE_SESSION,
    ...(at !== null ? { timestamp: iso(at) } : {}),
  });
}

function results(par: string | null, at: number, items: { id: string; content: unknown }[]) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: items.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) },
    parent_tool_use_id: par,
    session_id: TAPE_SESSION,
    timestamp: iso(at),
  });
}

/** The tape's lines, in stream order. */
export function buildTape(marker: string): string[] {
  const A = 'toolu_lab_impl1';
  const B = 'toolu_lab_qa1';
  const OPUS = 'claude-opus-5-5';
  const SONNET = 'claude-sonnet-5-5';
  const s = 1000;
  const L: string[] = [];
  // The orchestrator (main thread): one request that starts both sub-agents, then the turn's end.
  L.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `please run ${marker}` }, session_id: TAPE_SESSION }));
  L.push(
    assistant(null, 'msg_main_1', T0, OPUS, { read: 50000, w1: 3000, write: 3000, out: 300 }, [
      { type: 'text', text: `starting ${marker}` },
      { type: 'tool_use', id: A, name: 'Agent', input: { description: 'build slice', subagent_type: 'implementer', prompt: `${'x'.repeat(100)} ROLE implementer for T-287 slice 1 ${marker}` } },
      { type: 'tool_use', id: B, name: 'Agent', input: { description: `verify ${marker}`, subagent_type: 'qa', model: 'sonnet', prompt: `check the work ${marker}` } },
    ]),
  );
  // Sub-agent A (opus, ticket T-287): six requests.
  L.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `brief ${marker}` }, parent_tool_use_id: A, session_id: TAPE_SESSION, timestamp: iso(T0 + s) }));
  L.push(assistant(A, 'msg_a_1', T0 + 2 * s, OPUS, { input: 3, write: 30000, out: 100 }, [bash('toolu_a_1', `grep -n ${marker} src/a.ts`)]));
  L.push(results(A, T0 + 3 * s, [{ id: 'toolu_a_1', content: `${marker}\n${'r'.repeat(1200)}` }]));
  L.push(assistant(A, 'msg_a_2', T0 + 61 * s, OPUS, { read: 30000, write: 2000, w5: 2000, out: 200 }, [bash('toolu_a_2', 'rtk git status')]));
  // The same message reported again with its next block and a larger output: the last report wins, its tool call counts too.
  L.push(assistant(A, 'msg_a_2', T0 + 61 * s, OPUS, { read: 30000, write: 2000, w5: 2000, out: 250 }, [bash('toolu_a_3', `cd /w && npm test -- ${marker}`)]));
  L.push(results(A, T0 + 120 * s, [
    { id: 'toolu_a_2', content: [{ type: 'text', text: `${'é'.repeat(10)}${'\u{1F600}'.repeat(5)}` }, { type: 'image' }] },
    { id: 'toolu_a_3', content: [{ type: 'text', text: `ok ${marker}` }, { type: 'text', text: 'y'.repeat(400) }] },
  ]));
  L.push(assistant(A, 'msg_a_3', T0 + 125 * s, OPUS, { read: 32000, write: 1500, w1: 1500, out: 50 }, [
    bash('toolu_a_4', 'git log --oneline -5'),
    { type: 'tool_use', id: 'toolu_a_5', name: 'Read', input: { file_path: `/w/${marker}.ts` } },
  ]));
  L.push(results(A, T0 + 126 * s, [{ id: 'toolu_a_4', content: 'z'.repeat(333) }, { id: 'toolu_a_5', content: 'q'.repeat(2048) }, { id: 'toolu_unseen', content: 'u'.repeat(17) }]));
  // After a 30 minute gap the cache is gone: the context is written again (a re-write the script counts).
  L.push(assistant(A, 'msg_a_4', T0 + 1925 * s, OPUS, { read: 5000, write: 29000, w5: 29000, out: 20 }, [bash('toolu_a_6', 'sleep 20')]));
  L.push(assistant(A, 'msg_a_5', T0 + 1925 * s, OPUS, { read: 34000, write: 800, w5: 800, out: 10 }, [bash('toolu_a_7', `FOO=1 rtk npm test ${marker}`)]));
  L.push(results(A, T0 + 1980 * s, [{ id: 'toolu_a_6', content: '' }, { id: 'toolu_a_7', content: `${marker} ${'p'.repeat(90)}` }]));
  L.push(assistant(A, 'msg_a_6', T0 + 1987 * s, OPUS, { read: 34800, out: 400 }, [{ type: 'text', text: `done ${marker}` }]));
  // Sub-agent B (sonnet, no ticket): three requests over exactly 15 seconds (0.25 minutes: rounds to 0.2, half to even).
  const b0 = T0 + 4 * s;
  L.push(assistant(B, 'msg_b_1', b0, SONNET, { read: 0, write: 12000, w1: 12000, out: 30 }, [bash('toolu_b_1', `cat > /tmp/${marker} <<EOF`)]));
  L.push(results(B, b0 + 2 * s, [{ id: 'toolu_b_1', content: 'k'.repeat(64) }]));
  L.push(JSON.stringify({ type: 'assistant', message: { id: 'msg_b_syn', model: '<synthetic>', content: [bash('toolu_b_syn', 'ls')], usage: usage({ read: 999999 }) }, parent_tool_use_id: B, timestamp: iso(b0 + 3 * s) }));
  L.push(assistant(B, 'msg_b_2', b0 + 5 * s, SONNET, { read: 12000, write: 900, w1: 900, out: 60 }, [bash('toolu_b_2', `kubectl get pods -n ${marker}`)]));
  L.push(results(B, b0 + 9 * s, [{ id: 'toolu_b_2', content: `${marker} ${'n'.repeat(250)}` }]));
  L.push(assistant(B, 'msg_b_3', b0 + 15 * s, SONNET, { read: 12900, write: 100, w1: 100, out: 500 }, [{ type: 'text', text: `verdict ${marker}` }]));
  // The main thread hears both and ends the turn.
  L.push(results(null, T0 + 1990 * s, [{ id: A, content: `report ${marker}` }, { id: B, content: `report ${marker}` }]));
  L.push(assistant(null, 'msg_main_2', T0 + 1995 * s, OPUS, { read: 53000, w1: 900, write: 900, out: 80 }, [bash('toolu_main_1', 'git status -sb')]));
  L.push(JSON.stringify({ type: 'result', subtype: 'success', result: `summary ${marker}`, session_id: TAPE_SESSION }));
  return L;
}
