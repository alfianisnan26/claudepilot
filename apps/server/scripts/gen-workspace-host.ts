// Writes images/workspace/cp-session, the chat session host baked into the workspace image, from
// CP_SESSION in src/chat/host.ts. Kubernetes workspaces get the host only from their image, so run
// this after changing CP_SESSION and commit the result (src/chat/workspaceHost.test.ts fails until
// then): npm run gen:workspace-host -w @portal/server
import { chmodSync, writeFileSync } from 'node:fs';
import { CP_SESSION } from '../src/chat/host.js';
import { config } from '../src/config.js';

const file = `${config.workspaces.imageContext}/cp-session`;
writeFileSync(file, CP_SESSION);
chmodSync(file, 0o755);
console.log(`Wrote ${file}`);
