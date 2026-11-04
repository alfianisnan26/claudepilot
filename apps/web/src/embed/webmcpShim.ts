import type { ModelContextLike, WebMcpTool } from './webmcp';

/*
 * A development stand-in for `document.modelContext` (PILOT-1128), never in a production build: main.tsx installs it only under
 * `import.meta.env.DEV` with `?webmcp=shim` on the panel's URL, and only when the browser has no model context of its own. It keeps the
 * spec's registration rules that matter here (name characters, no duplicates, the signal unregisters) and adds what a person or a test
 * needs to try the tools from the console: `document.modelContext.list()` and `document.modelContext.call(name, input)`.
 * It is not the reference polyfill (@mcp-b/webmcp-polyfill, @mcp-b/global): nothing is loaded from outside, the panel's CSP stays as it is.
 */

export interface ShimModelContext extends ModelContextLike {
  list(): {
    name: string;
    title?: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: WebMcpTool['annotations'];
  }[];
  /** Runs a tool and answers what the spec's executeTool answers: the result as a JSON string. */
  call(name: string, input?: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function createShim(): ShimModelContext {
  const tools = new Map<string, WebMcpTool>();
  return {
    registerTool(tool, options = {}) {
      const signal = options.signal;
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (!NAME.test(tool.name) || !tool.description) return Promise.reject(new DOMException('Invalid tool', 'InvalidStateError'));
      if (tools.has(tool.name)) return Promise.reject(new DOMException(`Duplicate tool ${tool.name}`, 'InvalidStateError'));
      JSON.stringify(tool.inputSchema ?? {});
      tools.set(tool.name, tool);
      signal?.addEventListener('abort', () => tools.get(tool.name) === tool && tools.delete(tool.name), { once: true });
      return Promise.resolve();
    },
    list: () =>
      [...tools.values()].map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      })),
    async call(name, input = {}, signal = new AbortController().signal) {
      const tool = tools.get(name);
      if (!tool) throw new DOMException(`No tool ${name}`, 'NotFoundError');
      return JSON.stringify(await tool.execute(input, { signal }));
    },
  };
}

/** Puts the shim on `document.modelContext` unless the browser has one. Returns the context in use. */
export function installShim(doc: Document): ModelContextLike {
  const own = (doc as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (own) return own;
  const shim = createShim();
  Object.defineProperty(doc, 'modelContext', { value: shim, configurable: true });
  return shim;
}
