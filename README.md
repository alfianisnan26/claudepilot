# portal

A small admin portal served over plain HTTP on port 3000. Sign in with a **server code**; once in, the
admin view rotates or replaces the code, turns sign-in on or off, and signs out.

Styled with pay's design system through [`isnanme/shared`](https://github.com/isnanme/shared)
(`@isnanme/tokens`, `@isnanme/ui`), so it looks and behaves like pay on phones and desktops.

## Layout

```
apps/
  server/        Node + Hono. Serves /api, and the web app (Vite middleware in dev,
                 apps/web/dist in production) on the same port.
  web/           React 19 + Vite + Tailwind v4 on @isnanme/ui.
    src/app/        providers, routes, nav (add a page to NAV and it shows in sidebar + tab bar)
    src/components/ app frame: AppShell (sidebar / app bar / tab bar), AuthLayout, PageHeader…
    src/features/   one folder per feature (auth, admin)
    src/lib/        API client, auth context, formatting
packages/
  contracts/     Wire types, routes and code rules shared by server and web (TS source).
```

The API speaks `@isnanme/core`'s wire contract: `{ data }` on success,
`{ error: { code, message, details? } }` on failure.

## Setup

`@isnanme/*` packages come from GitHub Packages, which needs a token with `read:packages`:

```sh
gh auth refresh -h github.com -s read:packages   # once
NODE_AUTH_TOKEN=$(gh auth token) npm install
```

## Run

```sh
npm run dev        # http://localhost:3000 (API + Vite with HMR on one port)
npm run build      # web → apps/web/dist, server → apps/server/dist
npm start          # production server
```

The devcontainer forwards port 3000.

## Configuration

Environment variables (see [.env.example](.env.example)):

| Variable | Default | |
| --- | --- | --- |
| `PORTAL_SERVER_CODE` | generated | Sign-in code. Unset: an 8-character code is generated at startup and printed in the log. |
| `PORTAL_HOST` | `0.0.0.0` | Bind address. |
| `PORTAL_PORT` | `3000` | Port. |

Codes are letters and digits, at least 6. Case, spaces and dashes are ignored when signing in.

## Behaviour

- State lives in memory. A restart goes back to `PORTAL_SERVER_CODE` (or a new generated code),
  turns sign-in back on and signs everyone out.
- Rotating or setting a custom code signs out every other session.
- Turning sign-in off keeps existing sessions; nobody new can sign in until it's turned back on or
  the server restarts.
- Sessions: random token in an `HttpOnly; SameSite=Strict` cookie, 12 hours. Wrong codes are
  limited to 10 per address per 10 minutes. Cross-origin form posts are rejected (Hono `csrf`).
