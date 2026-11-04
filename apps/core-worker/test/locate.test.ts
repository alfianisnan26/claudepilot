import { describe, expect, it } from 'vitest';
import { LOCATION_HINT, locate } from '../src/locate.js';

describe('locate', () => {
  it('names the object and places it in apac', () => {
    const calls: { name?: string; options?: DurableObjectNamespaceGetDurableObjectOptions }[] = [];
    const id = { toString: () => 'id-of-x' } as DurableObjectId;
    const stub = {} as DurableObjectStub;
    const namespace = {
      idFromName(name: string) {
        calls.push({ name });
        return id;
      },
      get(got: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) {
        expect(got).toBe(id);
        calls.push({ options });
        return stub;
      },
    } as unknown as DurableObjectNamespace;
    expect(locate(namespace, 'cluster-1')).toBe(stub);
    expect(LOCATION_HINT).toBe('apac');
    expect(calls).toEqual([{ name: 'cluster-1' }, { options: { locationHint: 'apac' } }]);
  });

  it('no other source file calls idFromName or get(id) on a namespace', () => {
    const sources = import.meta.glob<string>('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(3);
    const offenders = files.filter((f) => !f.endsWith('/locate.ts') && /\.idFromName\(|\.newUniqueId\(/.test(sources[f]!));
    expect(offenders).toEqual([]);
  });
});
