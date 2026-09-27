import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, posix } from "node:path";
import { ALLOW_SIGNUP, DATA, DEV, DOMAIN, HOST, PORT, PREFIX, PUBLIC_URL, SYSTEM_USER } from "./config";
import { createUser } from "./accounts";
import type { Bytes } from "./crypto";
import { db } from "./db";
import { boxFor, boxForPath, splitAddress, wellKnown } from "./discovery";
import { boxFetch, signedBy } from "./fed";
import { bundle as bundleProgram, type Source } from "./programs";
import { above, register, users } from "./tree";
import {
  HttpError, aclOf, addressOf, homeOf, kindOf, mustCan, normalize, resolve, resolveNoFollow, setAcl, statEntry,
  type Entry, type Local, type Remote,
} from "./vfs";

const ROOT = join(import.meta.dir, "..");

// ---- System apps: copied from ./system into the world-readable `system` home ----

function installSystem() {
  const home = join(DATA, SYSTEM_USER);
  mkdirSync(home, { recursive: true });
  cpSync(join(ROOT, "system"), home, { recursive: true, force: true });
  setAcl(homeOf(SYSTEM_USER), { read: ["*"], write: [] });
}
installSystem();

// ---- Client bundle ------------------------------------------------------------

let bundle: Map<string, Blob> | null = null;
async function buildClient() {
  const out = await Bun.build({
    entrypoints: [join(ROOT, "client/main.ts"), join(ROOT, "client/worker.ts")],
    target: "browser",
    minify: !DEV,
    sourcemap: DEV ? "inline" : "none",
  });
  if (!out.success) {
    console.error(out.logs);
    throw new Error("client build failed");
  }
  bundle = new Map(out.outputs.map((o) => ["/" + posix.basename(o.path), o]));
}

// Programs run in workers loaded from here. This CSP is what actually keeps them
// off the network and from loading other code: they only get what the OS gives them.
const WORKER_CSP = "default-src 'none'; script-src blob:";

async function serveStatic(path: string): Promise<Response | null> {
  if (path === "/" || path === "/index.html") {
    if (DEV) installSystem(); // pick up edits to ./system without a restart
    if (DEV || !bundle) await buildClient();
    return new Response(Bun.file(join(ROOT, "client/index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (!bundle) await buildClient();
  const file = bundle!.get(path);
  if (!file) return null;
  const headers: Record<string, string> = { "content-type": "text/javascript; charset=utf-8" };
  if (path === "/worker.js") headers["content-security-policy"] = WORKER_CSP;
  return new Response(file, { headers });
}

// ---- Auth -----------------------------------------------------------------------

/**
 * `user` is one of our users, logged in with a token. `who` is whoever is asking:
 * that user's address, someone on another box (a request their box signed), or
 * null for the public.
 */
type Ctx = { req: Request; url: URL; user: string | null; who: string | null; bytes: Bytes };

const getSession = db.query<{ user: string }, [string]>("SELECT user FROM sessions WHERE token = ?");

function authed(ctx: Ctx): string {
  if (!ctx.user) throw new HttpError(401, "log in first");
  return ctx.user;
}

function newSession(user: string) {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  db.run("INSERT INTO sessions (token, user, created) VALUES (?, ?, ?)", [token, user, Date.now()]);
  return { token, address: addressOf(user), home: homeOf(user) };
}

// ---- Helpers -------------------------------------------------------------------

const json = (data: unknown, status = 200) => Response.json(data, { status });
const ok = () => json({ ok: true });
const decode = (b: Bytes) => new TextDecoder().decode(b);

async function body<T>(ctx: Ctx): Promise<T> {
  try {
    return JSON.parse(decode(ctx.bytes)) as T;
  } catch {
    throw new HttpError(400, "expected a JSON body");
  }
}

function param(ctx: Ctx, name: string): string {
  const v = ctx.url.searchParams.get(name);
  if (v === null) throw new HttpError(400, `missing ?${name}`);
  return v;
}

function local(r: Awaited<ReturnType<typeof resolve>>, what: string): Local {
  if (r.remote) throw new HttpError(403, `can't ${what} on another box (${r.box.domain})`);
  return r;
}

function listDir(r: Local): Entry[] {
  let names: string[];
  try {
    names = readdirSync(r.fsPath);
  } catch {
    throw new HttpError(404, `no such folder: ${r.virt}`);
  }
  return names
    .filter((n) => !n.startsWith("."))
    .map((n) => statEntry(join(r.fsPath, n), n))
    .filter((e): e is Entry => !!e)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Paths outside every home: this box's root lists its users, and folders above
 * boxes (`/`, `/com`) list the boxes under them. Null for everything else.
 */
async function outside(virt: string): Promise<Entry[] | null> {
  virt = normalize(virt);
  if (virt === PREFIX) return users();
  if (virt.startsWith(PREFIX + "/")) return null;
  const box = await boxForPath(virt).catch(() => null);
  if (box) return null;
  const entries = await above(virt);
  if (!entries.length && virt !== "/") throw new HttpError(404, `nothing at ${virt}`);
  return entries;
}

// ---- Reaching into other boxes ----------------------------------------------------

type Op = "stat" | "list" | "read";

/** A path another box reports back, if it's really one of its own. */
const theirs = (r: Remote, p: unknown) =>
  typeof p === "string" && p.startsWith(r.box.prefix + "/") ? p : r.virt;

async function failed(res: Response): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new HttpError(res.status, data.error ?? res.statusText);
}

/**
 * Find a path, wherever it lives. Local things come back as a place to check
 * access on. For another box we ask it as the logged-in user (a request we sign,
 * see fed.ts), following links from box to box. Everyone else (the public, and
 * other boxes) is just told where a link to another box points, so no box ever
 * fetches things on behalf of another box's users.
 */
async function locate(ctx: Ctx, virt: string, op: Op): Promise<{ local: Local } | { remote: Response; r: Remote }> {
  for (let hop = 0; hop < 8; hop++) {
    const r = await resolve(virt);
    if (!r.remote) return { local: r };
    if (r.via) mustCan(ctx.who, r.via, "read");
    if (!ctx.user) throw new HttpError(307, `moved to ${r.virt}`, { redirect: r.virt });
    const res = await boxFetch(ctx.user, r.box, "GET", `/fs/${op}?path=${encodeURIComponent(r.virt)}`);
    if (res.status === 307) {
      virt = ((await res.json()) as { redirect: string }).redirect;
      continue;
    }
    if (!res.ok) await failed(res);
    return { remote: res, r };
  }
  throw new HttpError(508, "too many hops between boxes");
}

/** Read a file as whoever is asking. */
async function readAs(ctx: Ctx, virt: string): Promise<Source> {
  const f = await locate(ctx, virt, "read");
  if ("remote" in f) return { path: theirs(f.r, f.remote.headers.get("x-box-path")), text: await f.remote.text() };
  mustCan(ctx.who, f.local, "read");
  if (kindOf(f.local.fsPath) !== "file") throw new HttpError(404, `not a file: ${f.local.virt}`);
  return { path: f.local.virt, text: await Bun.file(f.local.fsPath).text() };
}

/** Read a file only if everyone may: asking other boxes without saying who we are. */
async function readPublic(virt: string): Promise<Source> {
  for (let hop = 0; hop < 8; hop++) {
    const r = await resolve(virt);
    if (!r.remote) {
      mustCan(null, r, "read");
      if (kindOf(r.fsPath) !== "file") throw new HttpError(404, `not a file: ${r.virt}`);
      return { path: r.virt, text: await Bun.file(r.fsPath).text() };
    }
    if (r.via) mustCan(null, r.via, "read");
    const res = await fetch(`${r.box.api}/fs/read?path=${encodeURIComponent(r.virt)}`, {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (res.status === 307) {
      virt = ((await res.json()) as { redirect: string }).redirect;
      continue;
    }
    if (!res.ok) await failed(res);
    return { path: theirs(r, res.headers.get("x-box-path")), text: await res.text() };
  }
  throw new HttpError(508, "too many hops between boxes");
}

// ---- Sharing ----------------------------------------------------------------------

/** "bob" means bob on this box. For someone on another box, check that their box exists. */
async function toEntry(name: string): Promise<string> {
  name = name.trim().toLowerCase();
  if (name === "*") return "*";
  const address = name.includes("@") ? name : `${name}@${DOMAIN}`;
  const [, domain] = splitAddress(address);
  if (!(await boxFor(domain))) throw new HttpError(404, `no box found for ${domain}`);
  return address;
}

// ---- Routes -----------------------------------------------------------------

type Handler = (ctx: Ctx) => Promise<Response> | Response;

const routes: Record<string, Handler> = {
  "GET /.well-known/simplebox": () => json(wellKnown()),

  "POST /api/signup": async (ctx) => {
    if (!ALLOW_SIGNUP) throw new HttpError(403, "signups are closed on this box");
    const { user, password } = await body<{ user: string; password: string }>(ctx);
    await createUser(user, password);
    return json(newSession(user));
  },

  "POST /api/login": async (ctx) => {
    const { user, password } = await body<{ user: string; password: string }>(ctx);
    const row = db.query<{ hash: string }, [string]>("SELECT hash FROM users WHERE name = ?").get(user);
    if (!row || !(await Bun.password.verify(password ?? "", row.hash))) {
      throw new HttpError(401, "wrong name or password");
    }
    const home = await resolve(homeOf(user));
    if (home.virt !== homeOf(user)) {
      throw new HttpError(410, `this account moved to ${home.virt}`);
    }
    return json(newSession(user));
  },

  "POST /api/logout": (ctx) => {
    const token = ctx.req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (token) db.run("DELETE FROM sessions WHERE token = ?", [token]);
    return ok();
  },

  "GET /api/me": (ctx) => {
    const user = authed(ctx);
    return json({ address: addressOf(user), home: homeOf(user) });
  },

  // -- files --

  "GET /api/fs/stat": async (ctx) => {
    if (await outside(param(ctx, "path"))) return json({ path: normalize(param(ctx, "path")), type: "dir", size: 0, mtime: 0 });
    const f = await locate(ctx, param(ctx, "path"), "stat");
    if ("remote" in f) {
      const st = (await f.remote.json()) as { path: string; type: string; size: number; mtime: number };
      return json({ path: theirs(f.r, st.path), type: st.type, size: st.size, mtime: st.mtime });
    }
    const r = f.local;
    mustCan(ctx.who, r, "read");
    const type = kindOf(r.fsPath);
    if (!type) throw new HttpError(404, `not found: ${r.virt}`);
    const st = statSync(r.fsPath);
    return json({ path: r.virt, type, size: st.size, mtime: st.mtimeMs });
  },

  "GET /api/fs/list": async (ctx) => {
    const top = await outside(param(ctx, "path"));
    if (top) return json({ path: normalize(param(ctx, "path")), entries: top });
    const f = await locate(ctx, param(ctx, "path"), "list");
    if ("remote" in f) {
      const { path, entries } = (await f.remote.json()) as { path: string; entries: Entry[] };
      return json({ path: theirs(f.r, path), entries });
    }
    mustCan(ctx.who, f.local, "read");
    return json({ path: f.local.virt, entries: listDir(f.local) });
  },

  "GET /api/fs/read": async (ctx) => {
    const f = await locate(ctx, param(ctx, "path"), "read");
    const headers = { "content-type": "application/octet-stream", "x-box-path": "" };
    if ("remote" in f) {
      return new Response(f.remote.body, { headers: { ...headers, "x-box-path": theirs(f.r, f.remote.headers.get("x-box-path")) } });
    }
    const r = f.local;
    mustCan(ctx.who, r, "read");
    if (kindOf(r.fsPath) !== "file") throw new HttpError(404, `not a file: ${r.virt}`);
    return new Response(Bun.file(r.fsPath), { headers: { ...headers, "x-box-path": r.virt } });
  },

  "PUT /api/fs/write": async (ctx) => {
    if (!ctx.who) throw new HttpError(401, "log in first");
    let virt = param(ctx, "path");
    for (let hop = 0; hop < 8; hop++) {
      const r = await resolve(virt);
      if (!r.remote) {
        mustCan(ctx.who, r, "write");
        if (kindOf(r.fsPath) === "dir") throw new HttpError(409, "that's a folder");
        if (kindOf(posix.dirname(r.fsPath)) !== "dir") throw new HttpError(404, "no such folder");
        await Bun.write(r.fsPath, ctx.bytes);
        return ok();
      }
      if (r.via) mustCan(ctx.who, r.via, "read");
      if (!ctx.user) throw new HttpError(307, `moved to ${r.virt}`, { redirect: r.virt });
      const res = await boxFetch(ctx.user, r.box, "PUT", `/fs/write?path=${encodeURIComponent(r.virt)}`, ctx.bytes);
      if (res.status === 307) {
        virt = ((await res.json()) as { redirect: string }).redirect;
        continue;
      }
      if (!res.ok) await failed(res);
      return ok();
    }
    throw new HttpError(508, "too many hops between boxes");
  },

  "POST /api/fs/mkdir": async (ctx) => {
    authed(ctx);
    const { path } = await body<{ path: string }>(ctx);
    const r = local(await resolve(path), "make folders");
    mustCan(ctx.who, r, "write");
    if (kindOf(r.fsPath)) throw new HttpError(409, "already exists");
    mkdirSync(r.fsPath, { recursive: true });
    return ok();
  },

  "POST /api/fs/remove": async (ctx) => {
    authed(ctx);
    const { path } = await body<{ path: string }>(ctx);
    const r = local(await resolveNoFollow(path), "remove");
    mustCan(ctx.who, r, "write");
    if (!statEntry(r.fsPath, "")) throw new HttpError(404, "not found");
    rmSync(r.fsPath, { recursive: true });
    db.run("DELETE FROM acl WHERE path = ? OR path LIKE ?", [r.virt, r.virt + "/%"]);
    return ok();
  },

  "POST /api/fs/rename": async (ctx) => {
    authed(ctx);
    const { from, to } = await body<{ from: string; to: string }>(ctx);
    const a = local(await resolveNoFollow(from), "rename");
    const b = local(await resolveNoFollow(to), "rename");
    mustCan(ctx.who, a, "write");
    mustCan(ctx.who, b, "write");
    if (statEntry(b.fsPath, "")) throw new HttpError(409, "something is already there");
    renameSync(a.fsPath, b.fsPath);
    db.run("UPDATE acl SET path = ? || substr(path, ?) WHERE path = ? OR path LIKE ?", [
      b.virt, a.virt.length + 1, a.virt, a.virt + "/%",
    ]);
    return ok();
  },

  "POST /api/fs/link": async (ctx) => {
    authed(ctx);
    const { path, target } = await body<{ path: string; target: string }>(ctx);
    const r = local(await resolveNoFollow(path), "make links");
    mustCan(ctx.who, r, "write");
    if (statEntry(r.fsPath, "")) throw new HttpError(409, "something is already there");
    symlinkSync(target.startsWith("/") ? posix.normalize(target) : target, r.fsPath);
    return ok();
  },

  // -- sharing (owner only) --

  "GET /api/acl": async (ctx) => {
    const user = authed(ctx);
    const r = local(await resolve(param(ctx, "path")), "share");
    if (r.owner !== user) throw new HttpError(403, "only the owner can see sharing");
    const acl = aclOf(r.virt) ?? { read: [], write: [] };
    return json({ path: r.virt, ...acl });
  },

  "POST /api/acl": async (ctx) => {
    const user = authed(ctx);
    const { path, read, write } = await body<{ path: string; read: string[]; write: string[] }>(ctx);
    const r = local(await resolve(path), "share");
    if (r.owner !== user) throw new HttpError(403, "only the owner can share this");
    const uniq = (l: string[]) => [...new Set((l ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))];
    const acl = { read: await Promise.all(uniq(read).map(toEntry)), write: await Promise.all(uniq(write).map(toEntry)) };
    setAcl(r.virt, acl);
    return json({ path: r.virt, ...acl });
  },

  // -- programs --

  // The program with everything it imports, bundled (see programs.ts).
  "GET /api/program": async (ctx) => {
    authed(ctx);
    return json(await bundleProgram(param(ctx, "path"), { mine: (p) => readAs(ctx, p), anyone: readPublic }));
  },

  // -- app permissions --

  "GET /api/grants": (ctx) => {
    const user = authed(ctx);
    return json(db.query("SELECT id, app, kind, target, access FROM grants WHERE user = ? ORDER BY app, kind, target").all(user));
  },

  "POST /api/grants": async (ctx) => {
    const user = authed(ctx);
    const g = await body<{ app: string; kind: string; target: string; access?: string }>(ctx);
    if (!["folder", "app", "net"].includes(g.kind)) throw new HttpError(400, "bad kind");
    db.run(
      "INSERT OR REPLACE INTO grants (user, app, kind, target, access) VALUES (?, ?, ?, ?, ?)",
      [user, g.app, g.kind, g.target, g.access ?? ""],
    );
    return ok();
  },

  "DELETE /api/grants": (ctx) => {
    const user = authed(ctx);
    db.run("DELETE FROM grants WHERE user = ? AND id = ?", [user, Number(param(ctx, "id"))]);
    return ok();
  },
};

// The SPA can be served from anywhere and talks to any box, so the API is open
// to all origins. Auth is a bearer token, never a cookie.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-expose-headers": "x-box-path",
};

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    let res: Response;
    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const bytes = new Uint8Array(await req.arrayBuffer());
        const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
        const user = token ? (getSession.get(token)?.user ?? null) : null;
        const who = user ? addressOf(user) : await signedBy(req, url, bytes);
        res = await route({ req, url, user, who, bytes });
      } else {
        res = (await serveStatic(url.pathname)) ?? json({ error: "not found" }, 404);
      }
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message, ...e.body }, e.status);
      else {
        console.error(e);
        res = json({ error: String((e as Error)?.message ?? e) }, 500);
      }
    }
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  },
});

register();
console.log(`box for ${DOMAIN} (${PREFIX}) on http://${HOST}:${PORT}, API advertised at ${PUBLIC_URL}/api, data in ${DATA}`);
