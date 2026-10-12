// node tools/qa/chat-once.mjs <sessionId> "<message>" [waitMs]  - sends one message and prints the transcript events until the turn ends.
import { api, login, openChat, sleep } from './lib.mjs';
const [id, text, wait = '60000'] = process.argv.slice(2);
const cookie = await login();
const chat = await openChat(cookie, id);
await chat.until((c) => c.session, 15000, 'session');
console.log('state before:', chat.session.state, 'events so far:', chat.events.length);
const before = chat.events.length;
const ack = await chat.send(text);
console.log('ack', JSON.stringify(ack));
await sleep(800);
await chat.until((c) => c.session && ['idle', 'ended', 'interrupted', 'waiting'].includes(c.session.state) && c.events.length > before, Number(wait), 'turn end').catch((e) => console.log('!!', e.message));
for (const e of chat.events.slice(before)) console.log(e.seq, e.kind, e.toolName ?? '', JSON.stringify(e.text ?? e.request ?? '').slice(0, 160), e.isError ? 'ERROR' : '');
console.log('state after:', chat.session.state, 'waiting', chat.session.waiting, 'cost', chat.session.costUsd, 'model', chat.session.model);
chat.close();
process.exit(0);
