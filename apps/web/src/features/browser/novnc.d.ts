// noVNC ships no types: the part of its RFB class the live view uses (https://github.com/novnc/noVNC/blob/v1.4.0/docs/API.md).
declare module '@novnc/novnc/core/rfb.js' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; wsProtocols?: string[] });
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    blur(): void;
  }
}
