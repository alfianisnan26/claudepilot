// QA T-948 S1 (qa-t948-s1): independent checks, not part of the change under test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { after, before, test } from "node:test";
import { FOUNDING_USER_ID, isAppPortNext, parseAppPortHost } from "@portal/contracts";
import { ExecDuplex, bridgeCommand } from "./dial.js";
import { AppPortGrants } from "./grants.js";
import { AppPorts, routeAppHostUpgrades } from "./index.js";

const SUFFIX = "qa.test";
const SESSION = "qa-session-x";
const actor = { kind: "user", userId: FOUNDING_USER_ID, loginSessionId: "l1", via: "ui" } as never;
let appPort = 0;
let portalPort = 0;
let appServer: any;
let portalServer: any;
let ports: AppPorts;
const dials: string[] = [];
const audits: string[] = [];
const logs: string[] = [];
const sessionOf = (p: any) => {
  p.stdin.on("error", () => undefined);
  return { write: (d: any) => void p.stdin.write(d), close: () => void p.kill(), onData: (fn: any) => void p.stdout.on("data", fn), onExit: (fn: any) => void p.on("close", (c: any) => fn(c)) };
};

before(async () => {
  for (const k of ["log", "info", "warn", "error"]) {
    const orig = (console as any)[k].bind(console);
    (console as any)[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); orig(...a); };
  }
  appServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors *; script-src x" });
    res.end("app");
  });
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  appPort = appServer.address().port;
  portalServer = createServer();
  await new Promise<void>((r) => portalServer.listen(0, "127.0.0.1", r));
  portalPort = portalServer.address().port;
  const workspaces = {
    runtimeFor: () => undefined,
    exec: async () => { throw new Error("no exec"); },
    list: async () => [ { id: "docker/ws-a", name: "ws-a" }, { id: "docker/ws-b", name: "ws-b" }, { id: "docker/dup", name: "dup" }, { id: "kube/DUP", name: "DUP" } ],
    hooks: { audit: (e: unknown) => void audits.push(JSON.stringify(e)) },
    resolve: () => null,
  } as never;
  ports = new AppPorts({
    suffix: SUFFIX, portalPort, workspaces, sessionValid: (t) => t === SESSION, grants: new AppPortGrants(),
    dial: async (workspaceId, port) => {
      dials.push(workspaceId + ":" + port);
      const [, ...args] = bridgeCommand(port);
      return new ExecDuplex(sessionOf(spawn(process.execPath, args, { stdio: ["pipe", "pipe", "ignore"] })) as never);
    },
  });
  portalServer.on("request", (req: any, res: any) => { if (ports.proxy.owns(req.headers.host)) void ports.proxy.request(req, res); else res.end("portal"); });
  portalServer.on("upgrade", (_q: any, socket: any) => socket.end("HTTP/1.1 418 Portal\r\nContent-Length: 0\r\n\r\n"));
  routeAppHostUpgrades(portalServer, ports.proxy);
});

after(async () => {
  portalServer.closeAllConnections();
  appServer.closeAllConnections();
  await new Promise((r) => portalServer.close(r));
  await new Promise((r) => appServer.close(r));
});

function send(method: string, path: string, headers: Record<string, string>, ms = 3000): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve) => {
    const r = request({ host: "127.0.0.1", port: portalPort, method, path, headers }, (res) => {
      const c: Buffer[] = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c).toString() }));
    });
    r.on("upgrade", (_res, socket) => { socket.destroy(); resolve({ status: 101, headers: {}, body: "" }); });
    r.setTimeout(ms, () => { r.destroy(); resolve({ status: -1, headers: {}, body: "TIMEOUT" }); });
    r.on("error", (e) => resolve({ status: -2, headers: {}, body: String(e) }));
    r.end();
  });
}
const portalOrigin = () => "https://pilot." + SUFFIX + ":" + portalPort;
const open = (name: string, port: any, path: any = "/") =>
  ports.open("docker", name, { port, path }, { actor, actorString: "user:qa", userId: FOUNDING_USER_ID, sessionToken: SESSION, portalOrigin: portalOrigin() });
async function signIn(name: string) {
  const { url, host } = await open(name, appPort);
  const u = new URL(url);
  const r = await send("GET", u.pathname + u.search, { host: u.host });
  assert.equal(r.status, 302);
  return { host, setCookie: String(r.headers["set-cookie"]), cookie: String(r.headers["set-cookie"]).split(";")[0]!, code: u.searchParams.get("code")! };
}

test("QA host: two workspaces whose names map to one slug (dup, DUP on another target) are refused at open; nothing minted", async () => {
  const n = ports.grants.size.codes;
  await assert.rejects(open("dup", appPort), /same name/);
  assert.equal(ports.grants.size.codes, n);
});

test("QA authz: a cookie or a code for workspace A never reaches workspace B or another port", async () => {
  const a = await signIn("ws-a");
  const hostB = "app-ws-b-" + appPort + "." + SUFFIX + ":" + portalPort;
  const otherPort = "app-ws-a-" + (appPort === 65535 ? 65534 : appPort + 1) + "." + SUFFIX + ":" + portalPort;
  const d = dials.length;
  assert.equal((await send("GET", "/", { host: hostB, cookie: a.cookie })).status, 404);
  assert.equal((await send("GET", "/", { host: otherPort, cookie: a.cookie })).status, 404);
  assert.equal((await send("GET", "/", { host: hostB, cookie: a.cookie, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" })).status, 404);
  const { url } = await open("ws-a", appPort);
  const u = new URL(url);
  assert.equal((await send("GET", u.pathname + u.search, { host: hostB })).status, 404, "code on the wrong host");
  assert.equal((await send("GET", u.pathname + u.search, { host: u.host })).status, 404, "burned by the wrong-host try");
  assert.equal(dials.length, d, "nothing dialed");
  const ok = await send("GET", "/", { host: a.host, cookie: a.cookie });
  assert.equal(ok.status, 200);
  assert.equal(dials.at(-1), "docker/ws-a:" + appPort);
  const upper = await send("GET", "/", { host: a.host.toUpperCase(), cookie: a.cookie });
  assert.equal(upper.status, 200, "host compared case-insensitively");
  const otherHostPort = await send("GET", "/", { host: a.host.replace(/:\d+$/, ":1"), cookie: a.cookie });
  assert.equal(otherHostPort.status, 404, "the cookie is bound to the exact host:port");
});

test("QA one-time: a code is redeemed once; a replay is 404", async () => {
  const { url } = await open("ws-a", appPort);
  const u = new URL(url);
  assert.equal((await send("GET", u.pathname + u.search, { host: u.host })).status, 302);
  const again = await send("GET", u.pathname + u.search, { host: u.host });
  assert.equal(again.status, 404);
  assert.equal(again.headers["set-cookie"], undefined);
});

test("QA secrets: no code or cookie value in audit rows or console output", async () => {
  const s = await signIn("ws-a");
  const value = s.cookie.split("=")[1]!;
  const all = audits.join("\n") + "\n" + logs.join("\n");
  assert.ok(audits.length > 0, "the open is audited");
  assert.ok(audits.every((a) => a.includes("workspace.port.open")));
  assert.ok(!all.includes(s.code), "code leaked");
  assert.ok(!all.includes(value), "cookie leaked");
  assert.ok(!all.includes(SESSION), "portal session token leaked");
});

test("QA cookie flags: https gives HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age, and no Domain", async () => {
  const s = await signIn("ws-a");
  const attrs = s.setCookie.split(";").map((x) => x.trim().toLowerCase());
  assert.ok(attrs[0]!.startsWith("__pilot_app="));
  for (const want of ["httponly", "secure", "samesite=lax", "path=/"]) assert.ok(attrs.includes(want), want + " in " + s.setCookie);
  assert.ok(attrs.some((x) => x.startsWith("max-age=")));
  assert.ok(!attrs.some((x) => x.startsWith("domain")), "host-only");
});

test("QA next: //, backslashes, schemes and control characters are refused", async () => {
  for (const n of ["//evil.test", "/\\evil", "\\\\evil", "\\/evil", "https://evil", "javascript:alert(1)", "/javascript:x", "/\t/evil.test", "/\r\nset-cookie: x=1", "/\u0000", "/x\u007f", "", "evil", "/a//b", " /x", "/" + "a".repeat(2048)])
    assert.equal(isAppPortNext(n), false, JSON.stringify(n));
  for (const n of ["/", "/a/b?c=d#e", "/x:y"]) assert.equal(isAppPortNext(n), true, n);
  const { url } = await open("ws-a", appPort);
  const u = new URL(url);
  const code = encodeURIComponent(u.searchParams.get("code")!);
  for (const raw of ["%2F%2Fevil.test", "%5C%5Cevil.test", "%2F%5Cevil.test", "https%3A%2F%2Fevil.test", "%2F%09%2Fevil.test", "%2F%0D%0ALocation:%20x", "%2Fjavascript:alert(1)"]) {
    const r = await send("GET", u.pathname + "?code=" + code + "&next=" + raw, { host: u.host });
    assert.equal(r.status, 400, raw);
    assert.equal(r.headers.location, undefined, raw);
  }
  await assert.rejects(open("ws-a", appPort, "//evil.test"), /path/i);
  await assert.rejects(open("ws-a", appPort, 5), /path/i);
});

test("QA ports: outside 1024-65535 refused at host parse, open and the bridge", async () => {
  for (const p of [0, 1, 80, 1023, 65536, 99999]) {
    assert.equal(parseAppPortHost("app-ws-a-" + p + "." + SUFFIX, SUFFIX), null, String(p));
    await assert.rejects(open("ws-a", p), /port/i, String(p));
    assert.throws(() => bridgeCommand(p), String(p));
  }
  assert.equal(parseAppPortHost("app-ws-a-01024." + SUFFIX, SUFFIX), null);
  assert.deepEqual(parseAppPortHost("app-ws-a-1024." + SUFFIX, SUFFIX), { slug: "ws-a", port: 1024 });
  assert.deepEqual(parseAppPortHost("app-ws-a-65535." + SUFFIX + ":443", SUFFIX), { slug: "ws-a", port: 65535 });
  await assert.rejects(open("ws-a", 3000.5), /port/i);
  await assert.rejects(open("ws-a", "3000"), /port/i);
  await assert.rejects(open("ws-a", portalPort), /port/i);
});

test("QA containment and frames: an absolute URI or spoofed forwarding headers never change where the proxy dials; frame-ancestors is the portal only", async () => {
  const a = await signIn("ws-a");
  const d = dials.length;
  const r = await send("GET", "http://169.254.169.254/latest/meta-data", { host: a.host, cookie: a.cookie, "x-forwarded-host": "evil.test", forwarded: "host=evil.test" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "app");
  assert.deepEqual(dials.slice(d), ["docker/ws-a:" + appPort]);
  assert.equal(r.headers["x-frame-options"], undefined);
  const csp = String(r.headers["content-security-policy"]);
  assert.equal((csp.match(/frame-ancestors/g) ?? []).length, 1, csp);
  assert.ok(csp.endsWith("frame-ancestors " + portalOrigin()), csp);
  assert.ok(!csp.includes("*"), csp);
  const p = await send("GET", "http://" + a.host + "/", { host: "pilot." + SUFFIX, cookie: a.cookie });
  assert.equal(p.body, "portal", "the Host header decides, not the request target");
  assert.deepEqual(dials.slice(d), ["docker/ws-a:" + appPort]);
});

test("QA off: no suffix: no app host is owned, open is 404, list touches nothing", async () => {
  const off = new AppPorts({ suffix: undefined, portalPort, workspaces: { list: async () => { throw new Error("touched"); }, exec: async () => { throw new Error("touched"); } } as never, sessionValid: () => true, dial: async () => { throw new Error("dialed"); } });
  for (const h of ["app-ws-a-3000." + SUFFIX, "app-ws-a-3000.undefined", "app-ws-a-3000."]) assert.equal(off.proxy.owns(h), false, h);
  assert.equal(off.proxy.enabled, false);
  assert.deepEqual(await off.list("docker", "ws-a"), { enabled: false, ports: [] });
  await assert.rejects(off.open("docker", "ws-a", { port: 3000 }, { actor, actorString: "x", userId: null, sessionToken: SESSION, portalOrigin: "http://p" }), /Not found/);
});


test("QA recheck: non-ASCII next refused raw and encoded without spending the code; an encoded ASCII path lands as it is", async () => {
  await assert.rejects(open("ws-a", appPort, "/café"), /path/i);
  await assert.rejects(open("ws-a", appPort, "/中"), /path/i);
  const { url } = await open("ws-a", appPort, "/caf%C3%A9?q=%E4%B8%AD");
  const u = new URL(url);
  const code = encodeURIComponent(u.searchParams.get("code")!);
  for (const raw of ["%2F%E4%B8%AD", "%2Fcaf%C3%A9", "%2F%F0%9F%98%80", "%2F%C2%A0", "%2F%ED%A0%80"]) {
    const r = await send("GET", u.pathname + "?code=" + code + "&next=" + raw, { host: u.host });
    assert.equal(r.status, 400, raw);
  }
  const r = await send("GET", u.pathname + u.search, { host: u.host });
  assert.equal(r.status, 302, "code still good after the 400s");
  assert.equal(r.headers.location, "/caf%C3%A9?q=%E4%B8%AD");
});
