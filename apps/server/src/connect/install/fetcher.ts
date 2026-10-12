// The bootstrap fetcher (PRD §13.4): what the Docker, Swarm, Container and Kubernetes installers run inside the public `node` image
// (which has no curl) to download a file, check its checksum and only then write it. The Host installer uses it too once Node is there.
//
//   node -e "$FETCHER" <url> <sha256 hex | sha512-<base64> npm integrity> <out file>
//
// - A file already at <out> with the right checksum is kept (a restart needs no network).
// - Written to <out>.tmp and renamed, so a half download never sits at <out>.
// - Proxies: the caller sets NODE_USE_ENV_PROXY=1 (global fetch then honours HTTPS_PROXY/NO_PROXY); a private CA: NODE_EXTRA_CA_CERTS.
// - Extra headers (a Cloudflare Access service token): `Name: value` lines in the file named by PILOT_HEADERS_FILE. Never printed.
// - Exit 13 (CONNECT_INSTALL_EXIT.download) on any failure, with one line on stderr that names the file, never a header or a query.
// The text has no single quote, no backtick and no `$(` (Kubernetes would expand it in a container's command), so it sits unchanged in a
// single-quoted sh string, a PowerShell single-quoted here-string, a JSON/YAML string and an environment variable.

const LINES = [
  'const [u,h,o]=process.argv.slice(1),fs=require("fs"),p=require("path"),c=require("crypto");',
  'const die=(m)=>{console.error("fetch: "+m);process.exit(13)};',
  'if(!/^[0-9a-f]{64}$|^sha512-[A-Za-z0-9+\\/]{86}==$/.test(h||"")||!u||!o)die("usage: <url> <sha256|sha512-integrity> <out>");',
  'const sum=(b)=>h.startsWith("sha512-")?"sha512-"+c.createHash("sha512").update(b).digest("base64"):c.createHash("sha256").update(b).digest("hex");',
  'try{if(sum(fs.readFileSync(o))===h)process.exit(0)}catch{}',
  'const hd={},hf=process.env.PILOT_HEADERS_FILE;',
  'if(hf)for(const l of fs.readFileSync(hf,"utf8").split(/\\r?\\n/)){const i=l.indexOf(":");if(i>0)hd[l.slice(0,i).trim()]=l.slice(i+1).trim()}',
  'let n="";try{n=new URL(u).pathname}catch{die("not an address")}',
  'fetch(u,{headers:hd,redirect:"follow"}).then(async(r)=>{if(!r.ok)die("HTTP "+r.status+" for "+n);',
  'const b=Buffer.from(await r.arrayBuffer());if(sum(b)!==h)die("checksum mismatch for "+n);',
  'fs.mkdirSync(p.dirname(o),{recursive:true});fs.writeFileSync(o+".tmp",b,{mode:0o644});fs.renameSync(o+".tmp",o)},',
  '(e)=>die("download failed for "+n+" ("+String((e&&e.cause&&e.cause.code)||(e&&e.message)||e)+")"));',
];

/** The fetcher's source, for `node -e`: one line (it also travels in a Docker env file, which is line based). */
export const FETCHER = LINES.join('');

/** Where the text may go: nothing that a shell, PowerShell or YAML would interpret. A test keeps it so. */
export const FETCHER_FORBIDDEN = /['`]|\$\(/;

/** The scripts with their fetcher line brought up to date. The generator and the sync test use it. */
export function syncFetcher(text: string, kind: 'sh' | 'ps1'): string {
  const line = kind === 'sh' ? /^FETCHER='.*'$/m : /^\$script:Fetcher = '.*'$/m;
  if (!line.test(text)) throw new Error(`install.${kind} has no fetcher line`);
  return text.replace(line, () => (kind === 'sh' ? `FETCHER='${FETCHER}'` : `$script:Fetcher = '${FETCHER}'`));
}
