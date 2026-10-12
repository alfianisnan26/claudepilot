// The agent's side of chat content, through the real controller: a tool's result in the stream makes an artifact, and the
// `artifact_publish` tool over MCP hands a file over on purpose. The workspace is a temporary folder run by the real
// cp-session script, so the copy-out and its path policy are the host's own.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ChatEvent } from '@portal/contracts';
import { ToolRegistry } from '../../portalmcp/registry.js';
import { portalMcpHarness } from '../../portalmcp/testkit.js';
import type { Workspaces } from '../../workspaces/manager.js';
import { ChatController } from '../controller.js';
import { freshStore, line, until, sleep } from '../testkit.js';
import { registerArtifactTools } from './portalTools.js';
import { blobFileFor } from './serve.js';
import { cleanup, StagingWorkspaces } from './testkit.js';

after(cleanup);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function rig() {
  const { store } = await freshStore();
  const ws = new StagingWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces);
  const proj = join(ws.local.files, 'proj');
  mkdirSync(proj, { recursive: true });
  const id = (await controller.create({ workspaceId: 'docker/ws1', cwd: proj })).id;
  await until(() => ws.tails.length === 1);
  await until(() => controller.get(id)?.state === 'idle');
  await sleep(20);
  const tail = ws.tails[0]!;
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  registerArtifactTools(controller, registry);
  h.alive.add(id);
  const artifacts = (): ChatEvent[] => controller.history(id).filter((e) => e.kind === 'artifact');
  /** What Claude Code writes when its Write tool ran and succeeded. */
  const written = (toolUseId: string, path: string, content: string) => {
    tail.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input: { file_path: path, content } }] } }));
    tail.push(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `File created successfully at: ${path} (file state is current in your context — no need to Read it back)` }] }, parent_tool_use_id: null }));
  };
  const done = async () => {
    h.done();
    await controller.end(id).catch(() => undefined);
    controller.stop();
    store.close();
  };
  return { store, ws, controller, id, proj, tail, h, artifacts, written, done };
}

test('the stream: a Write that succeeded shows up in the transcript as an artifact card, right after its result', async () => {
  const r = await rig();
  try {
    const path = join(r.proj, 'report.md');
    writeFileSync(path, '# Report\n');
    r.written('toolu_1', path, '# Report\n');
    await until(() => r.artifacts().length === 1);
    const events = r.controller.history(r.id);
    const at = events.findIndex((e) => e.kind === 'artifact');
    assert.equal(events[at - 1]!.kind, 'tool_result', 'it comes where the tool result came');
    const f = events[at]!.files![0]!;
    assert.deepEqual([f.name, f.mediaType, f.preview, f.source, f.path], ['report.md', 'text/markdown', 'text', 'write', path]);
    // The copy is served to this session only, from the blob store.
    assert.equal(blobFileFor(r.store, r.id, f.blobId)?.size, 9);
    assert.equal(r.controller.blobFile(r.id, f.blobId)?.name, 'report.md');
  } finally {
    await r.done();
  }
});

test('the stream: a workspace secret a text artifact carries is hidden in what is kept, by value and by shape', async () => {
  const r = await rig();
  try {
    r.controller.secretValues = () => ['hunter2-not-a-shape-xyz'];
    const path = join(r.proj, 'config.txt');
    writeFileSync(path, 'db_password = hunter2-not-a-shape-xyz\nkey=sk-ant-api03-' + 'a1B2c3D4e5'.repeat(5) + '\nname=pilot\n');
    r.written('toolu_2', path, 'x');
    await until(() => r.artifacts().length === 1);
    const f = r.artifacts()[0]!.files![0]!;
    assert.equal(f.redacted, true);
    const stored = readFileSync(r.controller.blobFile(r.id, f.blobId)!.path, 'utf8');
    assert.ok(!stored.includes('hunter2-not-a-shape-xyz') && !stored.includes('sk-ant-'), stored);
    assert.ok(stored.includes('name=pilot'));
    // The preview the browser asks for passes the same hiding.
    assert.ok(!r.controller.scrub('docker/ws1', 'x hunter2-not-a-shape-xyz y').includes('hunter2'));
  } finally {
    await r.done();
  }
});

test('artifact_publish: an agent hands over a file in its workspace; it is a card with source “publish”, copied now', async () => {
  const r = await rig();
  try {
    const path = join(r.proj, 'chart.png');
    writeFileSync(path, PNG);
    const a = await r.h.agentToken('docker/ws1', r.id);
    const res = await r.h.call(a.secret, 'artifact_publish', { path, name: 'Q3 chart.png' });
    assert.equal(res.result?.isError, undefined, JSON.stringify(res.raw));
    assert.deepEqual(res.result?.structuredContent.artifact, { name: 'Q3 chart.png', size: PNG.length, mediaType: 'image/png', preview: 'image' });
    assert.match(String(res.result?.structuredContent.summary ?? res.result?.content?.[0]?.text), /Showed Q3 chart.png/);
    const [e] = r.artifacts();
    assert.deepEqual([e!.files![0]!.name, e!.files![0]!.source, e!.files![0]!.width], ['Q3 chart.png', 'publish', 1]);
    // Changing the file afterwards doesn't change what was handed over.
    writeFileSync(path, 'something else');
    assert.ok(readFileSync(r.controller.blobFile(r.id, e!.files![0]!.blobId)!.path).equals(PNG));
    // Handing over the same file again shows it again: it was asked for.
    await r.h.call(a.secret, 'artifact_publish', { path });
    assert.equal(r.artifacts().length, 2);
  } finally {
    await r.done();
  }
});

test('artifact_publish: only the home folder, regular files, within the limit — and the reason is told; an admin’s token has no chat to show it in', async () => {
  const r = await rig();
  try {
    mkdirSync(join(r.ws.local.files, '.claude'), { recursive: true });
    mkdirSync(join(r.ws.local.files, '.claudepilot'), { recursive: true });
    writeFileSync(join(r.ws.local.files, '.claude/settings.json'), '{}');
    writeFileSync(join(r.ws.local.files, '.claudepilot/x.txt'), 'x');
    writeFileSync(join(r.proj, 'empty.txt'), '');
    const a = await r.h.agentToken('docker/ws1', r.id);
    const ask = async (args: Record<string, unknown>) => {
      const res = await r.h.call(a.secret, 'artifact_publish', args);
      return { error: res.result?.isError === true, text: JSON.stringify(res.result?.content ?? res.raw) };
    };
    for (const path of ['/etc/passwd', join(r.ws.local.files, '.claude/settings.json'), join(r.ws.local.files, '.claudepilot/x.txt'), r.proj]) {
      const x = await ask({ path });
      assert.ok(x.error, path);
      assert.match(x.text, /can’t be shared|can\\u2019t be shared/, path);
    }
    assert.match((await ask({ path: join(r.proj, 'empty.txt') })).text, /empty/);
    assert.ok((await ask({ path: 'relative/file.txt' })).error);
    assert.ok((await ask({ path: join(r.proj, 'missing.txt') })).error);
    assert.equal(r.artifacts().length, 0, 'nothing was shown');
    const admin = r.h.token('operate');
    const noChat = await r.h.call(admin.secret, 'artifact_publish', { path: join(r.proj, 'empty.txt') });
    assert.equal(noChat.result?.isError, true);
    assert.match(JSON.stringify(noChat.result?.content), /Only a chat session/);
  } finally {
    await r.done();
  }
});
