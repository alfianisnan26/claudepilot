import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { config } from '../config.js';
import { CP_SESSION } from './host.js';

// Kubernetes workspaces get the session host only from their image, which bakes in this file.
const file = `${config.workspaces.imageContext}/cp-session`;

test('images/workspace/cp-session is CP_SESSION, so the workspace image ships the current chat host', () => {
  const baked = existsSync(file) ? readFileSync(file, 'utf8') : null;
  assert.ok(
    baked === CP_SESSION,
    `images/workspace/cp-session ${baked === null ? 'is missing' : 'differs from CP_SESSION in apps/server/src/chat/host.ts'}. ` +
      'Regenerate it with `npm run gen:workspace-host -w @portal/server` and commit it.',
  );
});
