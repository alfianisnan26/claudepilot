// The stand-in's shim for tools/qa/restart-survive.mjs (T-136 slice 3, T-277): runs the REAL Claude Code CLI unchanged (stdin, stderr and
// every argument passed through) and copies its stdout line by line, except the answer to a control request the HARNESS wrote into the
// session's input FIFO (request ids starting with `qa-restart-`). Claude Code still applies that request (a permission mode change made
// while the portal was down, as a process that re-attached in another mode would have), but the portal never reads a reply to a request it
// did not send; what the portal then sees is the mode Claude Code itself reports at its next init. Every other line is untouched.
//   node tools/qa/claude-shim.mjs <real claude path> <claude args...>   (restart-survive.mjs writes a `claude` wrapper that calls this)
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [real, ...args] = process.argv.slice(2);
const child = spawn(real, args, { stdio: ['inherit', 'pipe', 'inherit'] });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));

const harnessReply = (line) => {
  if (!line.includes('qa-restart-')) return null;
  try {
    const o = JSON.parse(line);
    const id = o?.type === 'control_response' ? (o.response?.request_id ?? o.request_id) : null;
    return typeof id === 'string' && id.startsWith('qa-restart-') ? id : null;
  } catch {
    return null;
  }
};

const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on('line', (line) => {
  const id = harnessReply(line);
  if (id) process.stderr.write(`claude-shim: the reply to ${id} is not passed on\n`);
  else process.stdout.write(`${line}\n`);
});
// Exit with Claude Code's code once its output is fully copied (its stdout ended and it exited, in either order).
const closed = new Promise((r) => lines.on('close', r));
const exited = new Promise((r) => child.on('exit', (code, signal) => r(code ?? (signal ? 1 : 0))));
Promise.all([exited, closed]).then(([code]) => process.exit(code));
