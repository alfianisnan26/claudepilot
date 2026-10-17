import type { Portal } from './portal.js';

/**
 * What a sign-out or a new server code cuts at once (QA-001, T-948 review 10219): the portal's own sockets (SocketGuard) and the app hosts'
 * live requests and upgraded sockets (AppPortProxy), without waiting for their periodic sweeps. index.ts calls it: revoke.test.ts checks that call, and
 * appports/limits.test.ts ("the server wiring (cutOnRevoke ...)") checks what it does on a real sign-out.
 */
export function cutOnRevoke(portal: Pick<Portal, 'onRevoked'>, sockets: { sweep(): void }, appPorts: { proxy: { sweep(): void } }): void {
  portal.onRevoked = () => {
    sockets.sweep();
    appPorts.proxy.sweep();
  };
}
