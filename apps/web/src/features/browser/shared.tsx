/** What a live view says about its connection. `private`: control is held privately and this device may not see the screen. */
export type ViewPhase = { kind: 'connecting' } | { kind: 'open' } | { kind: 'private' } | { kind: 'closed'; reason: string };

/** Close codes the portal's sockets use (apps/server/src/browser/view.ts): the page acts on them. */
export const CLOSE = { roleChanged: 4001, private: 4002, refused: 4003, unavailable: 4004 } as const;

/** A frame over the screen while this device has control (PRD §15.5): on top of the view's own canvas, which would hide a ring on its container. */
export function ControlFrame() {
  return <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] rounded-[2px] ring-2 ring-inset ring-emerald-400/70" />;
}
