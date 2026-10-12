// Builds `pilot-agent` (docs/prd/targets-connect.md §11.1) from `agent/bin.ts` (which runs `main.ts`) into ONE ES module: `agent.mjs`, run by Node 22.13 or newer.
// Used by `npm run gen:connect-agent` and by tests; the portal itself never imports this (it carries the generated text, `agent.generated.ts`).
//
// Bundled: the agent's own code, the tunnel library it shares with the portal, `workspaces/hostexec.ts`, the contract's constants (`connect.ts`
// only: the web's and the server's other contracts stay out) and the two packages it needs, `ws` (its optional native add-ons are not) and
// `tar-stream`. Not bundled: `@lydell/node-pty`, loaded at run time from `<dir>/node_modules` when present (a Host and a Container need it
// for terminals; a Docker or Kubernetes agent doesn't). Everything else must be a `node:` built-in: a test fails the build if it isn't.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildSync, type Metafile } from 'esbuild';

const SERVER = fileURLToPath(new URL('../../../', import.meta.url));
const CONTRACTS = fileURLToPath(new URL('../../../../../packages/contracts/src/connect.ts', import.meta.url));

export interface AgentBundle {
  /** The bundle text, byte for byte what the installer downloads. */
  text: string;
  /** Hex SHA-256 of the text as UTF-8. */
  sha256: string;
  /** The first 12 hex of it: what the agent calls its build. */
  build: string;
  metafile: Metafile;
}

export function buildAgent(): AgentBundle {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL('./bin.ts', import.meta.url))],
    absWorkingDir: SERVER,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.13',
    write: false,
    metafile: true,
    legalComments: 'none',
    logLevel: 'silent',
    // The contract's constants only: nothing else of @portal/contracts (and nothing it imports) belongs in an agent.
    alias: { '@portal/contracts': CONTRACTS },
    external: ['@lydell/node-pty', 'bufferutil', 'utf-8-validate'],
    // `ws` and `tar-stream` are CommonJS and call `require` on built-ins: give the ES module one.
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __pilotCreateRequire } from 'node:module';\nconst require = __pilotCreateRequire(import.meta.url);" },
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error('esbuild produced nothing');
  const text = out.text;
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  return { text, sha256, build: sha256.slice(0, 12), metafile: result.metafile };
}
