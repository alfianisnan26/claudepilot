// ProxyCommand for the desktop: one WebSocket to the portal with the person's token (read from a mode-600 file, never an argument).
import fs from 'node:fs';
const ws = new WebSocket(`${process.env.PILOT_URL}/api/ssh/${process.argv[2]}`,
  { headers: { Authorization: 'Bearer ' + fs.readFileSync(process.env.PILOT_TOKEN_FILE, 'utf8').trim() } });
ws.binaryType = 'arraybuffer';
ws.onopen = () => { process.stdin.on('data', (d) => ws.send(d)); process.stdin.on('end', () => ws.close()); };
ws.onmessage = (e) => process.stdout.write(Buffer.from(e.data));
ws.onclose = (e) => { if (e.code === 1008) process.stderr.write('pilot-ssh: access revoked\n'); process.exit(0); };
ws.onerror = () => { process.stderr.write('pilot-ssh: refused or unreachable\n'); process.exit(1); };
