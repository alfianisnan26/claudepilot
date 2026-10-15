'use strict';
// Stand-in model API for the PoC: OpenAI Responses + Chat Completions, Gemini generateContent. Logs method, path, model and header NAMES
// (never values) to <dir>/requests.jsonl, so we can see that an agent's model traffic can be routed through a place pilot controls.
const http = require('http'), fs = require('fs'), path = require('path');
const dir = process.argv[2], port = +process.argv[3], TEXT = 'Hello from the stand-in model, through the tunnel.';
const log = (o) => fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');
const sse = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); return (ev, data) => res.write((ev ? `event: ${ev}\n` : '') + `data: ${JSON.stringify(data)}\n\n`); };
http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    const p = req.url.split('?')[0];
    log({ method: req.method, path: req.url, model: j.model || (p.match(/models\/([^:]+)/) || [])[1] || null, stream: j.stream ?? /stream/i.test(req.url), headerNames: Object.keys(req.headers) });
    if (req.method === 'POST' && p.endsWith('/responses')) {
      const id = 'resp_' + Date.now(), mid = 'msg_' + Date.now(), s = sse(res);
      const item = { type: 'message', id: mid, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: TEXT, annotations: [] }] };
      const resp = (status, output) => ({ id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: j.model, output, usage: { input_tokens: 10, output_tokens: 9, total_tokens: 19, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
      s('response.created', { type: 'response.created', response: resp('in_progress', []) });
      s('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      s('response.output_text.delta', { type: 'response.output_text.delta', item_id: mid, output_index: 0, content_index: 0, delta: TEXT });
      s('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
      s('response.completed', { type: 'response.completed', response: resp('completed', [item]) });
      return res.end();
    }
    if (req.method === 'POST' && p.endsWith('/chat/completions')) {
      const s = sse(res), base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: j.model };
      s(null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: TEXT }, finish_reason: null }] });
      s(null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 } });
      res.write('data: [DONE]\n\n'); return res.end();
    }
    if (req.method === 'POST' && /:streamGenerateContent/.test(p)) {
      const s = sse(res);
      s(null, { candidates: [{ content: { role: 'model', parts: [{ text: TEXT }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 9, totalTokenCount: 19 }, modelVersion: 'stand-in' });
      return res.end();
    }
    if (req.method === 'POST' && /:generateContent/.test(p)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '{"next_speaker":"user","reasoning":"done"}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }));
    }
    if (/:countTokens/.test(p)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"totalTokens":10}'); }
    if (p.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'stand-in', object: 'model' }], models: [] })); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log('fake-llm on', port));
