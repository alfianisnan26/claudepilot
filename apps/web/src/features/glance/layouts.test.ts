// D-111 D6: the Home and Glance layouts follow the person and the org context; the device's layout is copied up once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LayoutKind, Layouts } from '@portal/contracts';
import { layoutCacheKey, legacyLayoutKey, migratedKey, planLayout, registerLayout, saveLayout, setLayoutApi, syncLayouts, type LayoutStorage } from './layouts.js';

const memory = (): LayoutStorage & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

/** A fake portal: layouts per `user|context|kind`, and who is signed in. */
function server() {
  const rows = new Map<string, Record<string, unknown>>();
  const saves: string[] = [];
  let user = '';
  return {
    rows,
    saves,
    as(u: string) {
      user = u;
    },
    api: {
      get: async (scope: string): Promise<Layouts> => ({ glance: rows.get(`${user}|${scope}|glance`) ?? null, home: rows.get(`${user}|${scope}|home`) ?? null }),
      save: async (scope: string, kind: LayoutKind, layout: Record<string, unknown>) => {
        saves.push(`${user}|${scope}|${kind}`);
        rows.set(`${user}|${scope}|${kind}`, layout);
        return { saved: true };
      },
    },
  };
}

const shown: Record<LayoutKind, Record<string, unknown> | null> = { glance: null, home: null };
registerLayout('glance', { apply: (v) => void (shown.glance = v) });
registerLayout('home', { apply: (v) => void (shown.home = v) });

test('planLayout: the server wins; Personal copies the device up once; an org never copies up', () => {
  const a = { order: ['quota'] };
  const b = { order: ['ci'] };
  assert.deepEqual(planLayout(a, { cache: b, legacy: b }, false, true), { value: a, upload: false });
  assert.deepEqual(planLayout(null, { cache: null, legacy: b }, false, true), { value: b, upload: true }, 'the old key goes up');
  assert.deepEqual(planLayout(null, { cache: a, legacy: b }, false, true), { value: a, upload: true }, 'this person’s cache before the old key');
  assert.deepEqual(planLayout(null, { cache: a, legacy: b }, true, true), { value: null, upload: false }, 'once only: then the defaults');
  assert.deepEqual(planLayout(null, { cache: a, legacy: b }, false, false), { value: a, upload: false }, 'an org shows its cache, never uploads');
  assert.deepEqual(planLayout(null, { cache: null, legacy: null }, false, true), { value: null, upload: false });
});

test('first load copies the device layout up once, removes the pre-people key, and two people never share a layout', async () => {
  const st = memory();
  const srv = server();
  setLayoutApi(srv.api, () => st);
  const old = { order: ['tickets'], hidden: [] };
  st.setItem(legacyLayoutKey('home'), JSON.stringify(old));

  // Ana signs in on this device first: the device's layout becomes hers, on the server.
  srv.as('u_ana');
  await syncLayouts('u_ana', 'personal');
  assert.deepEqual(shown.home, old);
  assert.deepEqual(srv.saves, ['u_ana|personal|home']);
  assert.equal(st.getItem(legacyLayoutKey('home')), null, 'the old key is gone, so nobody else inherits it');
  assert.equal(st.getItem(migratedKey('u_ana')), '1');

  // Again: nothing is copied twice.
  await syncLayouts('u_ana', 'personal');
  assert.equal(srv.saves.length, 1);

  // Ben on the same browser: his own (none yet), never Ana's.
  srv.as('u_ben');
  await syncLayouts('u_ben', 'personal');
  assert.equal(shown.home, null, 'Ben starts from the defaults');
  assert.equal(srv.saves.length, 1, 'nothing of Ana’s is copied to Ben');

  // Ben arranges Home: cached under his key, saved on the server as his.
  saveLayout('home', { order: ['ci'], hidden: [] }, 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(srv.rows.get('u_ben|personal|home'), { order: ['ci'], hidden: [] });
  assert.deepEqual(srv.rows.get('u_ana|personal|home'), old, 'Ana’s untouched');
  assert.ok(st.getItem(layoutCacheKey('home', 'u_ben', 'personal')));

  // Ana on another device (an empty cache): the server's layout follows her.
  const other = memory();
  setLayoutApi(srv.api, () => other);
  srv.as('u_ana');
  await syncLayouts('u_ana', 'personal');
  assert.deepEqual(shown.home, old, 'per person, not per device');
});

test('per org context: an org has its own layout; Personal is not copied into it', async () => {
  const st = memory();
  const srv = server();
  setLayoutApi(srv.api, () => st);
  srv.as('u_cy');
  srv.rows.set('u_cy|personal|glance', { order: ['quota'] });
  await syncLayouts('u_cy', 'personal');
  assert.deepEqual(shown.glance, { order: ['quota'] });
  await syncLayouts('u_cy', 'org_aaaaaaaaaaaa');
  assert.equal(shown.glance, null, 'the org starts from the defaults');
  saveLayout('glance', { order: ['sessions'] }, 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(srv.rows.get('u_cy|org_aaaaaaaaaaaa|glance'), { order: ['sessions'] });
  assert.deepEqual(srv.rows.get('u_cy|personal|glance'), { order: ['quota'] }, 'Personal unchanged');
  await syncLayouts('u_cy', 'personal');
  assert.deepEqual(shown.glance, { order: ['quota'] });
  setLayoutApi(null);
});
