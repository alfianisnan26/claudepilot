# App ports

Draft v0.1 (T-948, lead decision on T-948: subdomain mode). Code: `apps/server/src/appports/`, contract `packages/contracts/src/appPorts.ts`.

## 1. What it is

A web app that listens on the loopback inside a workspace (`127.0.0.1:<port>`, for example the Tradingbot on 8765 in `kohi-event`) opens in
the owner's browser through the portal, as real HTTP and WebSocket (not the remote browser's streamed screen). The Browser page can show it in
an iframe.

## 2. Hosts and the switch

- Each workspace and port has its own host: `<port>[-<app>]-<workspace>.<PORT_PROXY_HOST_SUFFIX>` (one DNS label; owner, 2026-10-18). `<workspace>` is the workspace's label as a slug (`isnan-pod`, else its name), `<app>` an optional name the person gives the port (kept on that device; the toolbar's Name button). Two workspaces with one slug can't open app hosts (409). The app's
  scripts never run on the portal's origin and never see the portal's cookie.
- `PORT_PROXY_HOST_SUFFIX` unset: the feature is off. The list answers `{ enabled: false, ports: [] }`, the open is 404, and no host is an
  app host.
- Parsing is strict (`parseAppPortHost`): one label, `<port>-<rest>`, a 4- or 5-digit port 1024 to 65535 without a leading zero; the grant is bound to the exact host at open, so only the port is read back. Ports never opened: the
  portal's own, the browser's CDP and supervisor ports, and `PORT_PROXY_DENY_PORTS` (comma-separated). A malformed `app-…` host under the
  suffix is still the proxy's, and gets its 404, never the portal.
- Only those ports are denied by default. Any other loopback service in the workspace (an agent's own helper, a database console) can be
  opened by whoever may `operate` the workspace. That is not an escalation, because `operate` already gives a terminal there. List such ports
  in `PORT_PROXY_DENY_PORTS` to keep them shut.
- A workspace whose name has a `.` or `_`, or whose name is shared with a workspace on another target, cannot have an app host (409 on open).

## 3. Portal routes

| Route                                           | Seam                                     | What                                                                                                                      |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:target/:name/ports`       | `operate`                                | Listening TCP ports read from `/proc/net/tcp{,6}` in the workspace, with the process name when known and `openable`.      |
| `POST /api/workspaces/:target/:name/ports/open` | `operate`, audited `workspace.port.open` | Body `{ port, path? }`. Answers `{ url, host, expiresAt }`; `url` is `<scheme>://<host>/__pilot/auth?code=…&next=<path>`. |

A denial is the same 404 as a missing workspace. The portal's CSRF guard refuses every mutation whose Origin is not the portal's own host, so
an app host's page can never drive the portal.

## 4. The handoff

1. The open mints a one-time code: 32 random bytes, valid 30 s, once, bound to the actor, the portal session, the workspace, the port and the
   exact app host. Only its SHA-256 is kept (in memory). It is audited (workspace and port; never the code).
2. The browser (a tab or the iframe) goes to `/__pilot/auth?code=&next=` on the app host. `next` must be a path: it starts with one `/`, has
   no `//`, no backslash, no scheme, only printable ASCII (a non-ASCII path is sent percent-encoded), at most 2,048 characters; anything
   else is 400 (and the open refuses it) and the code is not spent. The 302 percent-encodes anything outside printable ASCII as a second guard.
3. The code is burned on the first try, whatever the answer. A good one gives the cookie `__pilot_app`: `HttpOnly; SameSite=Lax; Path=/`,
   host-only (no `Domain`), `Secure` when the portal page was https, 12 h. Then a 302 to `next`.
4. The cookie dies with the portal session (sign-out, server code change, expiry) and with a portal restart (in memory). Neither the code nor
   the cookie is ever logged.

## 5. Reaching the app

The target is always `127.0.0.1:<port>` inside the workspace, over the channel each runtime already has: `exec` of a small Node bridge
(`node -e BRIDGE <port>`; the address is a literal, only an integer port in range is an argument). One exec per TCP connection.

- Built: Kubernetes (pod exec), Docker (docker exec), This machine.
- Connect (enrolled targets): 501 in this slice.

## 6. The proxy

- Every request and WebSocket upgrade whose Host is an app host goes to the proxy before the portal's own routes and sockets.
- On every request: the host parses, the port is allowed, the cookie is for this exact host, the portal session is alive, and the seam still
  says `operate` on the workspace. Any failure is the same bare 404.
- A request that changes state, and every upgrade, with a foreign Origin (or `Sec-Fetch-Site: cross-site`) is 404.
- A `GET`, `HEAD` or `OPTIONS` has **no Origin check**. A top-level link from another site carries the `SameSite=Lax` cookie, so such a
  request reaches the app signed in. An app that changes state on a `GET` is the app's own bug; the proxy does not guard against it.
- To the app: no hop-by-hop headers, no `Authorization`, no `Forwarded`/`X-Forwarded-*` from the browser, no `__pilot_app` cookie, and no
  portal session cookie (the name from `config.session.cookie`, and its `__Host-` form). `Host: 127.0.0.1:<port>`, `X-Forwarded-Host` (the app host) and `X-Forwarded-Proto` are set. `Connection: close`.
- From the app: bodies stream as they come. `X-Frame-Options` and any `frame-ancestors` are dropped; `frame-ancestors <portal origin>` is
  added, so the portal can frame it and nothing else can. `Set-Cookie` loses its `Domain`, and cookies named like the portal's are dropped. A
  redirect to the app's own loopback address becomes a path.
- An exception while handling a request is a 502 (a cut connection once headers went out), never a hung request.
- An upgrade waits at most 30 s for the workspace to connect and the app to answer; then it is a 504.
- **Bounds.** Each open connection is one exec into the workspace (one held exec API call on Kubernetes), so connections are bounded:
  - A request whose dial, app or browser moves no byte for `PORT_PROXY_IDLE_MS` (default 60 s) is a 504. If the answer has already started,
    it is cut instead. A stream that keeps moving is never cut.
  - An upgraded socket with no byte either way for `PORT_PROXY_SOCKET_IDLE_MS` (default 10 min) is closed.
  - An upgraded socket never outlives the `__pilot_app` cookie it was opened with.
  - Live requests and sockets are re-checked every 15 s, and at once on sign-out, a new server code and `grants.forgetWorkspace` (workspace
    removal). One whose cookie, portal session or `operate` right is gone is closed.
  - At most `PORT_PROXY_MAX_PER_GRANT` (16) connections may be open per app-host cookie, and `PORT_PROXY_MAX_PER_WORKSPACE` (64) per
    workspace, requests and sockets together. Past either cap the answer is 503 with `Retry-After: 5`.
- Two workspaces with the same name on different targets would share an app host: the open refuses it (409 CONFLICT) and mints no code.

## 7. Deploy

`deploy/k3s/portal.yaml`: `PORT_PROXY_HOST_SUFFIX=pilot.ai.isnan.me` and the IngressRoute `claudepilot-app-ports` (`HostRegexp` for
`<port>-*.pilot.ai.isnan.me`, the same Service, a `*.pilot.ai.isnan.me` certificate from the cloudflare resolver). The 2026-10-17 form `app-<name>-<port>.ai.isnan.me` is gone.

**Untrusted apps only after T-976.** An app host is a subdomain of the portal host (`*.pilot.ai.isnan.me`). Its scripts can set a
`Domain=pilot.ai.isnan.me` cookie that the portal host receives. That cannot read the portal session, but it can shadow it (a broken sign-in or
fixation). The `__Host-` session cookie of T-976 closes this. Until T-976 is live, open only the owner's own apps (the Tradingbot)
through app ports; never an app whose code is untrusted.

## 8. Not yet

- Connect targets (a bridge through the agent).
- Keep-alive or a pooled bridge (each request is one exec today).
- The Browser page's iframe and port list (Frontend lane).
