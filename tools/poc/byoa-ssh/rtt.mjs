import { spawn } from 'node:child_process';
const ch = spawn('ssh', ['-F', process.argv[2], 'poc-ws', 'cat']); const out = []; let buf = '', t, i = 0, N = 200;
const next = () => { t = process.hrtime.bigint(); ch.stdin.write(`ping ${i}\n`); };
ch.stdout.on('data', (d) => { buf += d; while (buf.includes('\n')) { buf = buf.slice(buf.indexOf('\n') + 1); out.push(Number(process.hrtime.bigint() - t) / 1e6); if (++i < N) next(); else { ch.stdin.end(); const s = out.slice(20).sort((a, b) => a - b); console.log(`echo RTT over ${s.length} msgs: p50 ${s[Math.floor(s.length * .5)].toFixed(2)} ms, p95 ${s[Math.floor(s.length * .95)].toFixed(2)} ms, max ${s[s.length - 1].toFixed(2)} ms`); } } });
setTimeout(next, 1500);
