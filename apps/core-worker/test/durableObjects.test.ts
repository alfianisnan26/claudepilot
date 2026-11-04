import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DoKind, SchemaDO } from '../src/do/schema.js';
import { locate } from '../src/locate.js';

const shards: ['PLATFORM' | 'ORG' | 'WORKSPACE' | 'CHAT_SESSION' | 'BRIDGE', DoKind][] = [
  ['PLATFORM', 'platform'],
  ['ORG', 'org'],
  ['WORKSPACE', 'workspace'],
  ['CHAT_SESSION', 'chat-session'],
  ['BRIDGE', 'bridge'],
];

describe('Durable Object stubs', () => {
  for (const [binding, kind] of shards) {
    it(`${kind}: ping() answers over RPC at schema version 1`, async () => {
      const stub = locate(env[binding] as DurableObjectNamespace<SchemaDO>, `test-${kind}`);
      expect(await stub.ping()).toEqual({ ok: true, kind, schemaVersion: 1 });
    });

    it(`${kind}: the schema-version table holds one row per migration, applied once`, async () => {
      const stub = locate(env[binding] as DurableObjectNamespace<SchemaDO>, `schema-${kind}`);
      await stub.ping();
      await stub.ping();
      const rows = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ version: number }>('SELECT version FROM schema_version ORDER BY version').toArray(),
      );
      expect(rows.map((r) => r.version)).toEqual([1]);
      const tables = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'schema_version') ORDER BY name",
          )
          .toArray()
          .map((r) => r.name),
      );
      expect(tables).toEqual(['meta', 'schema_version']);
    });
  }

  it('the same name reaches the same object, another name another one', async () => {
    const a = locate(env.WORKSPACE, 'ws-a');
    const again = locate(env.WORKSPACE, 'ws-a');
    const b = locate(env.WORKSPACE, 'ws-b');
    expect(a.id.equals(again.id)).toBe(true);
    expect(a.id.equals(b.id)).toBe(false);
  });
});
