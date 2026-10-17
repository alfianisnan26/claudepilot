import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LIMIT, type CursorPage } from '@portal/contracts';

// One keyset query for every list route (D-58): an opaque cursor over the sort key plus the id, never an offset. The cursor is
// HMAC-signed and bound to a scope (the route and whatever filter it applies), so a forged cursor, or one from another list, is a 400
// and a client can't steer a query with it. The key lives in memory: a restart ends every cursor and the client lists again.
// A cursor only says where to resume; the caller's authz check (and any filter) runs BEFORE the query, so it never reveals a row.

const KEY = randomBytes(32);
const ENC_KEY = createHash('sha256').update(KEY).update('cursor-seal').digest();
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const mac = (body: string) => createHmac('sha256', KEY).update(body).digest('base64url');
const bad = () => new AppError('BAD_REQUEST', 'That cursor is not valid for this list. Load the list again.');

/** A list that filters rows by the caller's authz reads at most this many rows per request for each row it may show (limit x factor). */
export const SCAN_FACTOR = 10;

/** The page size a request asks for: 25 when absent or not a number, clamped to 1..100. */
export function clampLimit(limit: unknown): number {
  const n = typeof limit === 'string' && limit.trim() !== '' ? Number(limit) : typeof limit === 'number' ? limit : NaN;
  if (!Number.isFinite(n)) return CURSOR_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), CURSOR_MAX_LIMIT);
}

/** A cursor that resumes just after the row with this sort key and id (for a route that filters rows and must point at the last row it SHOWED, never at a hidden one). */
export function cursorAfter(scope: string, sort: string | number, id: string | number): string {
  // The body is encrypted (AES-CTR under a key kept in memory) and then signed: a cursor may have to rest on a row the caller may not see (a
  // bounded scan that ended on hidden rows), and its holder can then read neither the id nor the sort key of it.
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-ctr', ENC_KEY, iv);
  const sealed = Buffer.concat([iv, c.update(JSON.stringify({ s: scope, k: sort, i: id }), 'utf8'), c.final()]);
  const body = sealed.toString('base64url');
  return `${body}.${mac(body)}`;
}

/** The position a cursor rests on, without the scope check. For tests only: it shows what a cursor holds, which a client can't read. */
export function peekCursor(cursor: string): { scope: string; sort: string | number; id: string | number } {
  const [body, sig, ...rest] = cursor.split('.');
  if (!body || !sig || rest.length) throw bad();
  const v = open(body, sig);
  return { scope: v.s as string, sort: v.k as string | number, id: v.i as string | number };
}

function open(body: string, sig: string): { s?: unknown; k?: unknown; i?: unknown } {
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw bad();
  const raw = Buffer.from(body, 'base64url');
  if (raw.length < 17) throw bad();
  const d = createDecipheriv('aes-256-ctr', ENC_KEY, raw.subarray(0, 16));
  try {
    return JSON.parse(Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8')) as { s?: unknown; k?: unknown; i?: unknown };
  } catch {
    throw bad();
  }
}

/** The key and id a cursor resumes after; a bad, forged or foreign-scope cursor is a 400. For a list whose order is more than one column. */
export function decodeCursor(cursor: string, scope: string): { sort: string | number; id: string | number } {
  return decode(cursor, scope);
}

function decode(cursor: string, scope: string): { sort: string | number; id: string | number } {
  const [body, sig, ...rest] = cursor.split('.');
  if (!body || !sig || rest.length) throw bad();
  try {
    const v = open(body, sig);
    if (v.s !== scope || (typeof v.k !== 'string' && typeof v.k !== 'number') || !(typeof v.i === 'string' || (typeof v.i === 'number' && Number.isInteger(v.i)))) throw bad();
    return { sort: v.k, id: v.i };
  } catch (e) {
    throw e instanceof AppError ? e : bad();
  }
}

export interface KeysetSpec {
  /** Names the list; a cursor made for another scope is refused. Include any filter value that shapes the rows. */
  scope: string;
  table: string;
  /** Column to sort by, newest (largest) first unless `dir` is `asc`. */
  sortCol: string;
  /** Unique column (integer or text) that breaks ties. */
  idCol: string;
  dir?: 'asc' | 'desc';
  /** A fixed SQL condition (from code, never from the request) and its parameters. */
  where?: string;
  params?: SQLInputValue[];
}

/** One page of rows, in order, and the cursor of the next page. Rows are inserted or removed during a walk without a skip or a repeat. */
export function keysetPage<R extends Record<string, unknown>>(db: DatabaseSync, spec: KeysetSpec, args: { cursor?: string | undefined; limit?: unknown }): { rows: R[]; next: string | null } {
  for (const name of [spec.table, spec.sortCol, spec.idCol]) if (!IDENT.test(name)) throw new Error(`keysetPage: unsafe identifier ${name}`);
  const desc = spec.dir !== 'asc';
  const limit = clampLimit(args.limit);
  const conds: string[] = [];
  const params: SQLInputValue[] = [];
  if (spec.where) {
    conds.push(`(${spec.where})`);
    params.push(...(spec.params ?? []));
  }
  if (args.cursor) {
    const at = decode(args.cursor, spec.scope);
    conds.push(`(${spec.sortCol}, ${spec.idCol}) ${desc ? '<' : '>'} (?, ?)`);
    params.push(at.sort, at.id);
  }
  const order = desc ? 'DESC' : 'ASC';
  const sql = `SELECT * FROM ${spec.table}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${spec.sortCol} ${order}, ${spec.idCol} ${order} LIMIT ?`;
  const got = db.prepare(sql).all(...params, limit + 1) as R[];
  const rows = got.slice(0, limit);
  const last = rows[rows.length - 1];
  const next = got.length > limit && last ? cursorAfter(spec.scope, last[spec.sortCol] as string | number, last[spec.idCol] as string | number) : null;
  return { rows, next };
}

export type { CursorPage };
