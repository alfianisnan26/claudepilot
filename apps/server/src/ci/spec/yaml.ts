// Pipeline files: YAML in, a value and a way to say where in the text something is out (PRD §9.7). The value is built
// by js-yaml's safe core schema (no tags that run code, `<<` merge on, aliases and depth limited); the places come from
// the parser's own source offsets, so a diagnostic can say `ci.yml:14:7` and not only `jobs.test.steps[1]`.

import { CORE_SCHEMA, EVENT_ID, constructFromEvents, getScalarValue, mergeTag, parseEvents, YAMLException } from 'js-yaml';
import { CI_LIMITS } from '../limits.js';

export interface Place {
  /** Both start at 1. */
  line: number;
  column: number;
}

export type PathSeg = string | number;

type PNode =
  | { k: 'scalar'; at: number; text: string }
  | { k: 'map'; at: number; keys: PNode[]; vals: PNode[] }
  | { k: 'seq'; at: number; items: PNode[] }
  | { k: 'alias'; at: number };

export interface ParsedYaml {
  value: unknown;
  /**
   * Where `path` is in the text: the value's place, or the key's when `what` is `key`. A part that isn't in the
   * text literally (it came from an alias or a merge) resolves to the nearest part that is.
   */
  where(path: readonly PathSeg[], what?: 'key' | 'value'): Place;
}

export type ParseResult = { ok: true; doc: ParsedYaml } | { ok: false; place: Place; message: string };

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function placeAt(starts: number[], offset: number): Place {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

/** The reason of a parser error, without js-yaml's snippet of the text. */
function reasonOf(e: unknown): string {
  if (e instanceof YAMLException) return e.reason;
  return e instanceof Error ? e.message : String(e);
}

/** Parses one YAML document. Never throws: a file that can't be read comes back with the place of the first problem. */
export function parseYaml(text: string): ParseResult {
  const starts = lineStarts(text);
  try {
    const events = parseEvents(text, { maxDepth: CI_LIMITS.yamlDepth });
    const docs = events.filter((e) => e.type === EVENT_ID.DOCUMENT).length;
    if (docs === 0) return { ok: false, place: { line: 1, column: 1 }, message: 'The file is empty.' };
    if (docs > 1) return { ok: false, place: { line: 1, column: 1 }, message: 'One document per file: remove the extra `---`.' };

    // A tree of where each node starts: children close before their parent, so a stack is enough.
    type Open = { k: 'map' | 'seq' | 'doc'; at: number; kids: PNode[] };
    const docEntry: Open = { k: 'doc', at: 0, kids: [] };
    const stack: Open[] = [docEntry];
    for (const e of events) {
      const top = stack[stack.length - 1]!;
      switch (e.type) {
        case EVENT_ID.DOCUMENT:
          break;
        case EVENT_ID.MAPPING:
          stack.push({ k: 'map', at: e.start, kids: [] });
          break;
        case EVENT_ID.SEQUENCE:
          stack.push({ k: 'seq', at: e.start, kids: [] });
          break;
        case EVENT_ID.SCALAR:
          top.kids.push({ k: 'scalar', at: e.valueStart, text: getScalarValue(text, e) });
          break;
        case EVENT_ID.ALIAS:
          top.kids.push({ k: 'alias', at: e.anchorStart });
          break;
        case EVENT_ID.POP: {
          const done = stack.pop()!;
          if (done.k === 'doc') break;
          const parent = stack[stack.length - 1]!;
          if (done.k === 'map') {
            const keys: PNode[] = [];
            const vals: PNode[] = [];
            done.kids.forEach((n, i) => (i % 2 === 0 ? keys : vals).push(n));
            parent.kids.push({ k: 'map', at: done.at, keys, vals });
          } else parent.kids.push({ k: 'seq', at: done.at, items: done.kids });
          break;
        }
      }
    }
    const root = docEntry.kids[0];

    const docsValue = constructFromEvents(events, {
      source: text,
      schema: CORE_SCHEMA.withTags(mergeTag),
      maxAliases: CI_LIMITS.yamlAliases,
      maxTotalMergeKeys: 1000,
    });
    const value = docsValue[0];
    if (value === undefined || value === null || !root) return { ok: false, place: { line: 1, column: 1 }, message: 'The file is empty.' };

    return {
      ok: true,
      doc: {
        value,
        where(path, what = 'value') {
          let node: PNode = root;
          let keyNode: PNode | null = null;
          for (const seg of path) {
            if (node.k === 'map' && typeof seg === 'string') {
              const i = node.keys.findIndex((k) => k.k === 'scalar' && k.text === seg);
              if (i < 0) break;
              keyNode = node.keys[i]!;
              node = node.vals[i]!;
            } else if (node.k === 'seq' && typeof seg === 'number') {
              const n = node.items[seg];
              if (!n) break;
              keyNode = null;
              node = n;
            } else break;
          }
          return placeAt(starts, what === 'key' && keyNode ? keyNode.at : node.at);
        },
      },
    };
  } catch (e) {
    const mark = e instanceof YAMLException ? e.mark : undefined;
    // js-yaml counts lines and columns from 0.
    return { ok: false, place: mark ? { line: mark.line + 1, column: mark.column + 1 } : { line: 1, column: 1 }, message: reasonOf(e) };
  }
}
