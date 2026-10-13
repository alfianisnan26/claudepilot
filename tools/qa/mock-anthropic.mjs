// A scripted stand-in for the Anthropic Messages API, for QA only (no network, no real key).
//
//   node tools/qa/mock-anthropic.mjs <port> [logFile]
//
// Claude Code points at it with ANTHROPIC_BASE_URL (an account on a "custom" endpoint whose base URL is
// http://127.0.0.1:<port>). What it answers is chosen by a directive in the newest user message:
//
//   [[echo]]                   (default) a short reply that quotes the message
//   [[md]]                     a long Markdown reply: headings, lists, table, code, links, raw HTML
//   [[xss]]                    stored-XSS probes in Markdown/HTML; any that runs sets window.__xss
//   [[bash <command>]]         a Bash tool call (asks for approval in Manual mode)
//   [[write <path> <text>]]    a Write tool call;  [[read <path>]] a Read tool call;  [[ask]] a question to answer
//   [[think <text>]]           a thinking block, then a reply
//   [[slow <seconds>]]         streams text for that long (to test Stop)
//   [[long <paragraphs>]]      that many paragraphs in one reply
//   [[big <kilobytes>]]        one reply of roughly that many kilobytes
//   [[err <status>]]           that HTTP error (429, 500, 529 …) with Anthropic's error body
//   [[usage <in> <out> <cacheRead> <cacheWrite>]]   a reply reporting exactly these token counts
//   [[agent <models> <directive> <arg>]]   sub-agents: one Task (Agent) call per comma-separated model (sonnet, opus, haiku, or - for none:
//                              the call carries no model argument), all in one message so they run side by side; each sub-agent's prompt is
//                              [[<directive> <arg>]], so `[[agent opus,- slow 8]]` starts two that stream for 8 s, `[[agent sonnet bash ls]]` one that runs ls
//   [[mcp <tool> <json>]]      a call of the MCP tool whose name ends with `__<tool>` (the browser's `browser_navigate`, say) with that JSON as input
//   [[steps <n> <seconds> <path>]]   n turns of "Step k." and a Read of <path>, each after a pause: an agent (or a session) that works for a while,
//                              one stored line at a time (Claude Code doesn't stream a sub-agent's text; its finished blocks arrive one by one)
//
// A request that only carries tool results gets "Tool finished: …". Requests without tools (titles) get "ok", except a side question (btw: its
// instructions say "answer one side question about a coding session"): the directive is read from its <side_question> text, so [[slow 5]], [[long 8]],
// [[err 429]], [[usage …]] and [[md]] work there too, and a tool directive ([[bash …]]) answers a tool call the tool-free run must refuse.
// Every request is appended to <logFile> as one JSON line (path, model, directive), never a key.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4599);
const logFile = process.argv[3];
let counter = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);
};

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('\n');

/** The newest user message's text, without Claude Code's injected <system-reminder> blocks. */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    return textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  }
  return '';
}
/** The newest message carries a tool result (Claude Code may add text blocks next to it). */
const onlyToolResults = (messages) => {
  const m = messages.at(-1);
  return !!m && m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
};
const resultText = (messages) =>
  (messages.at(-1).content ?? [])
    .filter((b) => b.type === 'tool_result')
    .map((b) => (typeof b.content === 'string' ? b.content : textOf(b.content)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 160);

const MD = [
  '# Heading one',
  '',
  'Some **bold**, _italic_, `inline code`, ~~strike~~ and a [link](https://example.com/page).',
  '',
  '## A list',
  '- first item',
  '- second item with a very long unbroken token: ' + 'x'.repeat(120),
  '  - nested item',
  '1. one',
  '2. two',
  '',
  '> A blockquote that goes on for a while so that it wraps on a phone-sized screen, twice over, to see the wrapping.',
  '',
  '| Column A | Column B | Column C |',
  '| --- | --- | --- |',
  '| a1 | b1 | a very long cell that should not blow the layout of the page on a narrow screen at all |',
  '| a2 | b2 | c2 |',
  '',
  '```ts',
  'export function greet(name: string): string {',
  '  return `Hello, ${name}!` + "a really long line of code that needs to scroll sideways instead of widening the page: " + name.repeat(10);',
  '}',
  '```',
  '',
  '- [x] done task',
  '- [ ] open task',
  '',
  '---',
  '',
  'Raw HTML: <b>not bold</b> <i>not italic</i> <u>x</u>',
].join('\n');

const XSS = [
  'XSS probes (nothing here should execute, set window.__xss, or navigate):',
  '',
  '<img src=x onerror="window.__xss=(window.__xss||0)+1">',
  '',
  '<script>window.__xss=(window.__xss||0)+1</script>',
  '',
  '<svg onload="window.__xss=(window.__xss||0)+1"><circle r=5></svg>',
  '',
  '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
  '',
  '<a href="javascript:window.__xss=1">raw html javascript link</a>',
  '',
  '[markdown javascript link](javascript:window.__xss=1)',
  '',
  '[markdown data link](data:text/html;base64,PHNjcmlwdD53aW5kb3cucGFyZW50Ll9feHNzPTE8L3NjcmlwdD4=)',
  '',
  '![markdown javascript image](javascript:window.__xss=1)',
  '',
  '![onerror via title](x "\\" onerror=\\"window.__xss=1")',
  '',
  '[ref link][r]',
  '',
  '[r]: javascript:window.__xss=1',
  '',
  '<details open ontoggle="window.__xss=1"><summary>d</summary></details>',
  '',
  '<form action="javascript:window.__xss=1"><button>go</button></form>',
  '',
  '`</code><img src=x onerror=window.__xss=1>`',
  '',
  '```html',
  '<img src=x onerror="window.__xss=1">',
  '```',
].join('\n');

/** What to say for the newest user message: { text } or { tool, input } or { thinking, text } or { error }. */
/** The system prompt as text (a string, or blocks). */
const systemText = (body) => (typeof body.system === 'string' ? body.system : (body.system ?? []).map((b) => b?.text ?? '').join('\n'));
/** A side question (btw): a request with no tools whose instructions say so. Its directive is in <side_question>, not in the newest message. */
const isBtw = (body) => /answer one side question about a coding session/.test(systemText(body));
const btwQuestion = (messages) => {
  // Claude Code adds its own reminder messages around ours: the newest message that carries the question block is the one.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = /<side_question>\n([\s\S]*?)\n<\/side_question>/.exec(textOf(messages[i]?.content ?? ''));
    if (m) return m[1].trim();
  }
  return '';
};

function plan(body) {
  const messages = body.messages ?? [];
  const btw = isBtw(body);
  if (!(body.tools ?? []).length && !btw) return { text: 'ok' };
  // [[steps n s path]] in the first message: keep going until n tool results are in (Claude Code may add its own text after a result).
  const first = messages.find((m) => m.role === 'user');
  const steps = btw ? null : /\[\[steps (\d+) (\d+(?:\.\d+)?) (\S+)\]\]/.exec(first ? textOf(first.content) : '');
  const results = messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')).length;
  if (steps && results > 0) {
    if (results < Number(steps[1])) return { delay: Number(steps[2]), text: `Step ${results + 1}.`, tool: 'Read', input: { file_path: steps[3] } };
    return { delay: Number(steps[2]), text: `All ${steps[1]} steps done.` };
  }
  if (!btw && onlyToolResults(messages)) return { text: `Tool finished: ${resultText(messages)}` };
  const user = btw ? btwQuestion(messages) : lastUserText(messages);
  const m = /\[\[(\w+)(?: ([^\]]*))?\]\]/.exec(user);
  const [kind, arg = ''] = m ? [m[1], m[2]] : ['echo', ''];
  switch (kind) {
    case 'md':
      return { text: MD };
    case 'xss':
      return { text: XSS };
    case 'bash':
      return { text: 'Running it.', tool: 'Bash', input: { command: arg || 'echo qa', description: 'QA command' } };
    case 'write': {
      const [path, ...rest] = arg.split(' ');
      return { tool: 'Write', input: { file_path: path || '/home/node/qa-out.txt', content: rest.join(' ') || 'written by qa\n' } };
    }
    case 'read':
      return { tool: 'Read', input: { file_path: arg || '/home/node/qa-out.txt' } };
    case 'ask':
      return {
        tool: 'AskUserQuestion',
        input: { questions: [{ question: 'Which colour should the QA bar be?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] },
      };
    case 'think':
      return { thinking: arg || 'Let me think about this for a moment.', text: 'Done thinking.' };
    case 'slow':
      return { slow: Math.max(1, Number(arg) || 20) };
    case 'long':
      return { text: Array.from({ length: Math.max(1, Number(arg) || 10) }, (_, i) => `Paragraph ${i + 1}. ${'The quick brown fox jumps over the lazy dog. '.repeat(6)}`).join('\n\n') };
    case 'big':
      return { text: Array.from({ length: Math.max(1, Math.round((Number(arg) || 10) * 1024 / 80)) }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog, again.`).join('\n') };
    case 'err':
      return { error: Number(arg) || 500 };
    case 'agent': {
      // The tool Claude Code offers for sub-agents (`Agent` in newer versions, `Task` before).
      const tool = (body.tools ?? []).map((t) => t?.name).find((n) => n === 'Agent' || n === 'Task') ?? 'Task';
      const [models = '-', inner = 'echo', ...rest] = arg.split(' ');
      const tools = models.split(',').map((model, i) => ({
        tool,
        input: {
          description: `QA agent ${i + 1}${model === '-' ? '' : ` (${model})`}`,
          subagent_type: 'general-purpose',
          prompt: `[[${inner}${rest.length ? ` ${rest.join(' ')}` : ''}]]`,
          ...(model === '-' ? {} : { model }),
        },
      }));
      return { text: 'Starting agents.', tools };
    }
    case 'mcp': {
      const [name = '', ...rest] = arg.split(' ');
      const tool = (body.tools ?? []).map((t) => t?.name).find((n) => n === name || n?.endsWith(`__${name}`));
      if (!tool) return { text: `No tool named ${name} here.` };
      let input = {};
      try {
        input = JSON.parse(rest.join(' ') || '{}');
      } catch {
        return { text: 'That input is not JSON.' };
      }
      return { text: `Calling ${tool}.`, tool, input };
    }
    case 'steps': {
      const [, seconds = '2', path = '/etc/hostname'] = arg.split(' ');
      return { delay: Number(seconds) || 2, text: 'Step 1.', tool: 'Read', input: { file_path: path } };
    }
    case 'usage': {
      const [i = 1000, o = 200, cr = 0, cw = 0] = arg.split(/\s+/).map(Number);
      return { text: `Usage reported: in ${i}, out ${o}, cache read ${cr}, cache write ${cw}.`, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw } };
    }
    default:
      return { text: `Echo: ${user.slice(0, 200)}` };
  }
}

const usageOf = (p, outTokens = 20) => ({
  input_tokens: 30,
  output_tokens: outTokens,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...(p.usage ?? {}),
});

async function stream(res, p, body) {
  if (p.delay) await sleep(p.delay * 1000);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `msg_qa${++counter}`;
  ev('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage: usageOf(p, 1) } });
  let index = 0;
  const chunks = (s, n) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) ?? [];
  if (p.thinking) {
    ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    for (const c of chunks(p.thinking, 30)) {
      ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: c } });
      await sleep(40);
    }
    ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'qa-signature' } });
    ev('content_block_stop', { index });
    index++;
  }
  if (p.slow) {
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
    const until = Date.now() + p.slow * 1000;
    let n = 0;
    while (Date.now() < until && !res.destroyed && !res.writableEnded) {
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: `tick ${++n} ` } });
      await sleep(500);
    }
    ev('content_block_stop', { index });
    index++;
  } else if (p.text !== undefined) {
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
    for (const c of chunks(p.text, 60)) {
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: c } });
      if (p.text.length < 4000) await sleep(12);
    }
    ev('content_block_stop', { index });
    index++;
  }
  for (const call of p.tools ?? (p.tool ? [{ tool: p.tool, input: p.input }] : [])) {
    ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_qa${++counter}`, name: call.tool, input: {} } });
    ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
    ev('content_block_stop', { index });
    index++;
  }
  ev('message_delta', { delta: { stop_reason: p.tool || p.tools ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: usageOf(p) });
  ev('message_stop', {});
  res.end();
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      // not JSON
    }
    const url = req.url ?? '/';
    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      log({ path: url });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', type: 'model', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z' }, { id: 'claude-haiku-4-5', type: 'model', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' }], has_more: false, first_id: 'claude-sonnet-4-5', last_id: 'claude-haiku-4-5' }));
    }
    if (url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"input_tokens":1}');
    }
    if (req.method === 'POST' && url.startsWith('/v1/messages')) {
      const p = plan(body);
      log({ path: url, model: body.model, tools: (body.tools ?? []).length, stream: !!body.stream, user: lastUserText(body.messages ?? []).slice(0, 80), plan: Object.keys(p) });
      if (p.error) {
        res.writeHead(p.error, { 'content-type': 'application/json', ...(p.error === 429 ? { 'retry-after': '1' } : {}) });
        return res.end(JSON.stringify({ type: 'error', error: { type: p.error === 429 ? 'rate_limit_error' : p.error === 529 ? 'overloaded_error' : 'api_error', message: `QA mock error ${p.error}` } }));
      }
      if (body.stream) return stream(res, p, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: `msg_qa${++counter}`, type: 'message', role: 'assistant', model: body.model ?? 'mock', content: [{ type: 'text', text: p.text ?? 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: usageOf(p) }));
    }
    log({ path: url, other: true });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(port, '0.0.0.0', () => console.log(`qa mock anthropic on :${port}`));
