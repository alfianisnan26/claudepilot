# App ports

Draft v0.1 (T-948, lead decision on T-948: subdomain mode). Code: `apps/server/src/appports/`, contract `packages/contracts/src/appPorts.ts`.

## 1. What it is

A web app that listens on the loopback inside a workspace (`127.0.0.1:<port>`, for example the Tradingbot on 8765 in `kohi-event`) opens in
the owner's browser through the portal, as real HTTP and WebSocket (not the remote browser's streamed screen). The Browser page can show it in
an iframe.

## 2. Hosts and the switch

- Each workspace and port has its own host: `app-<name>-<port>.<PORT_PROXY_HOST_SUFFIX>` (one DNS label; the name lowercased). The app's
  scripts never run on the portal's origin and never see the portal's cookie.
- `PORT_PROXY_HOST_SUFFIX` unset: the feature is off. The list answers `{ enabled: false, ports: [] }`, the open is 404, and no host is an
  app host.
- Parsing is strict (`parseAppPortHost`): one label, `app-<slug>-<port>`, port 1024 to 65535 without a leading zero. Ports never opened: the
  portal's own, the browser's CDP and supervisor ports, and `PORT_PROXY_DENY_PORTS` (comma-separated). A malformed `app-…` host under the
  suffix is still the proxy's, and gets its 404, never the portal.
- A workspace whose name has a `.` or `_`, or whose name is shared with a workspace on another target, cannot have an app host (409 on open).

## 3. Portal routes

| Route | Seam | What |
| --- | --- | --- |
| `GET /api/workspaces/:target/:name/ports` | `operate` | Listening TCP ports read from `/proc/net/tcp{,6}` in the workspace, with the process name when known and `openable`. |
| `POST /api/workspaces/:target/:name/ports/open` | `operate`, audited `workspace.port.open` | Body `{ port, path? }`. Answers `{ url, host, expiresAt }`; `url` is `<scheme>://<host>/__pilot/auth?code=…&next=<path>`. |

A denial is the same 404 as a missing workspace. The portal's CSRF guard refuses every mutation whose Origin is not the portal's own host, so
an app host's page can never drive the portal.

## 4. The handoff

1. The open mints a one-time code: 32 random bytes, valid 30 s, once, bound to the actor, the portal session, the workspace, the port and the
   exact app host. Only its SHA-256 is kept (in memory). It is audited (workspace and port; never the code).
2. The browser (a tab or the iframe) goes to `/__pilot/auth?code=&next=` on the app host. `next` must be a path: it starts with one `/`, has
   no `//`, no backslash, no scheme, no control character, at most 2,048 characters; anything else is 400 and the code is not spent.
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
- To the app: no hop-by-hop headers, no `Authorization`, no `Forwarded`/`X-Forwarded-*` from the browser, no `__pilot_app` or
  `portal_session` cookie. `Host: 127.0.0.1:<port>`, `X-Forwarded-Host` (the app host) and `X-Forwarded-Proto` are set. `Connection: close`.
- From the app: bodies stream as they come. `X-Frame-Options` and any `frame-ancestors` are dropped; `frame-ancestors <portal origin>` is
  added, so the portal can frame it and nothing else can. `Set-Cookie` loses its `Domain`, and cookies named like the portal's are dropped. A
  redirect to the app's own loopback address becomes a path.

## 7. Deploy

`deploy/k3s/portal.yaml`: `PORT_PROXY_HOST_SUFFIX=ai.isnan.me` and the IngressRoute `claudepilot-app-ports` (`HostRegexp` for
`app-*.ai.isnan.me`, the same Service, the existing `*.ai.isnan.me` certificate).

## 8. Not yet

- Connect targets (a bridge through the agent).
- Keep-alive or a pooled bridge (each request is one exec today).
- The Browser page's iframe and port list (Frontend lane).
