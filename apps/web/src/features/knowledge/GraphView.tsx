import { cn, usePrefersReducedMotion, useTheme } from '@isnanme/ui';
import type { GraphNode, GraphResponse } from '@portal/contracts';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { GraphEngine, type EngineColors } from './graphEngine';

/** The same answer again keeps the object it was, so a refresh that found nothing new doesn't move the graph. */
export function useStableGraph(data: GraphResponse | null): GraphResponse | null {
  const prev = useRef<{ sig: string; graph: GraphResponse } | null>(null);
  if (!data) return prev.current?.graph ?? null;
  const sig = `${data.lens}|${data.center}|${data.nodes.map((n) => `${n.id}:${n.degree}:${n.state ?? ''}`).join(',')}|${data.edges.map((e) => `${e.from}>${e.to}:${e.kind}:${e.weight}`).join(',')}`;
  if (prev.current?.sig === sig) return prev.current.graph;
  prev.current = { sig, graph: data };
  return data;
}

export interface GraphViewHandle {
  fit(): void;
  zoomBy(factor: number): void;
}

/** The theme's own colours, read from where the graph sits (so a change of theme or a custom property is followed). */
function readColors(el: HTMLElement, dark: boolean): EngineColors {
  const s = getComputedStyle(el);
  const get = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return { ink: get('--color-ink', dark ? '#eee' : '#222'), muted: get('--color-muted', '#888'), line: get('--color-line', '#ccc'), bg: get('--color-bg', dark ? '#111' : '#fff'), accent: get('--color-accent', '#2563eb'), dark };
}

/**
 * The graph as a canvas you can pan, zoom, tap and hold. `cacheKey` is what the answer is for (the query): the layout and the view are
 * remembered under it, so a refresh or coming back doesn't start over. The canvas has a text alternative; the list view is the other way in.
 */
export const GraphView = forwardRef<
  GraphViewHandle,
  {
    graph: GraphResponse;
    cacheKey: string;
    selected: string | null;
    onTap: (node: GraphNode) => void;
    onHold: (node: GraphNode) => void;
    onBlank: () => void;
    /** A panel rather than a page: labels only for what is picked or central. */
    compact?: boolean;
    label: string;
    className?: string;
  }
>(function GraphView({ graph, cacheKey, selected, onTap, onHold, onBlank, compact, label, className }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<GraphEngine | null>(null);
  const { resolvedTheme } = useTheme();
  const reduced = usePrefersReducedMotion();
  const handlers = useRef({ onTap, onHold, onBlank });
  handlers.current = { onTap, onHold, onBlank };
  const dark = resolvedTheme === 'dark';

  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const e = new GraphEngine(cv, { tap: (n) => handlers.current.onTap(n), hold: (n) => handlers.current.onHold(n), blank: () => handlers.current.onBlank() });
    engine.current = e;
    e.resize(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver(() => e.resize(el.clientWidth, el.clientHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      e.destroy();
      engine.current = null;
    };
  }, []);

  // The theme: the attribute that says which is shown is set after React renders, so colours are read a frame later and on every change of it.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const apply = () => engine.current?.setColors(readColors(el, document.documentElement.getAttribute('data-theme') ? document.documentElement.getAttribute('data-theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches));
    apply();
    const id = requestAnimationFrame(apply);
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      cancelAnimationFrame(id);
      mo.disconnect();
    };
  }, [dark]);

  useEffect(() => {
    engine.current?.setGraph(graph, cacheKey, { compact, reduced });
  }, [graph, cacheKey, compact, reduced]);

  useEffect(() => {
    engine.current?.setSelected(selected);
  }, [selected, graph]);

  useImperativeHandle(ref, () => ({ fit: () => engine.current?.fit(), zoomBy: (f) => engine.current?.zoomBy(f) }), []);

  return (
    <div ref={wrap} className={cn('relative size-full touch-none overflow-hidden select-none', className)}>
      <canvas ref={canvas} role="img" aria-label={label} tabIndex={0} className="absolute inset-0 size-full cursor-grab rounded-[inherit] outline-hidden focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset active:cursor-grabbing" />
    </div>
  );
});
