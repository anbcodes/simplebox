/**
 * The directory: a small, separate server that keeps a list of boxes, so the
 * folders above them (`/`, `/com`, `/codes`, ...) can be listed.
 *
 * Nothing depends on it. Paths still find their box through
 * `/.well-known/simplebox`, as always. The directory only answers "what's in
 * /com?", which no single box can know. Anyone can run one, and boxes pick which
 * directory to use (BOX_DIRECTORY).
 *
 *   POST /register   {"domain": "anb.codes"}
 *     Adds a box. The directory checks https://anb.codes/.well-known/simplebox
 *     itself, so there's nothing to prove: a domain that serves a box is listed.
 *     Boxes register themselves every time they start.
 *
 *   GET /list?path=/codes
 *     {"path": "/codes", "entries": [{"name": "anb", "box": "anb.codes"}]}
 *     The folders under a path that's above boxes. `box` is set when that
 *     folder is a box's own root. Asking about a path inside a box answers
 *     {"path": ..., "box": "anb.codes"}: ask that box instead.
 *
 *   GET /boxes
 *     Every box: [{"domain", "api", "prefix", "checked"}]
 *
 * Boxes are checked again every few hours, and dropped after failing for a day.
 *
 * Settings: DIR_PORT (3500), DIR_HOST (0.0.0.0), DIR_DATA (./data-directory),
 * DIR_PEERS=domain=origin,... (where to find well-known files, for local testing).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = Number(process.env.DIR_PORT ?? 3500);
const HOST = process.env.DIR_HOST ?? "0.0.0.0";
const DATA = resolve(process.env.DIR_DATA ?? "./data-directory");
const PEERS: Record<string, string> = Object.fromEntries(
  (process.env.DIR_PEERS ?? "").split(",").filter(Boolean).map((s) => s.split("=", 2) as [string, string]),
);
const RECHECK = 6 * 60 * 60_000;
const GIVE_UP = 24 * 60 * 60_000;

mkdirSync(DATA, { recursive: true });
const db = new Database(join(DATA, "directory.sqlite"), { create: true });
db.run(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS boxes (
    domain TEXT PRIMARY KEY,
    api TEXT NOT NULL,
    prefix TEXT NOT NULL,
    checked INTEGER NOT NULL,  -- last time it answered
    tried INTEGER NOT NULL     -- last time we asked
  );
`);

type Box = { domain: string; api: string; prefix: string; checked: number };

const prefixOf = (domain: string) => "/" + domain.split(".").reverse().join("/");
const within = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/");
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** Fetch a domain's well-known file and check it describes a box for that domain. */
async function check(domain: string): Promise<Box | null> {
  const origin = PEERS[domain] ?? `https://${domain}`;
  try {
    const res = await fetch(`${origin}/.well-known/simplebox`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    const info = (await res.json()) as { simplebox?: number; domain?: string; api?: string };
    if (!res.ok || info.simplebox !== 1 || info.domain !== domain || typeof info.api !== "string") return null;
    const api = new URL(info.api);
    const own = PEERS[domain] ? api.origin === new URL(PEERS[domain]).origin
      : api.protocol === "https:" && (api.hostname === domain || api.hostname.endsWith("." + domain));
    if (!own) return null;
    return { domain, api: info.api.replace(/\/$/, ""), prefix: prefixOf(domain), checked: Date.now() };
  } catch {
    return null;
  }
}

function save(box: Box) {
  db.run("INSERT OR REPLACE INTO boxes (domain, api, prefix, checked, tried) VALUES (?, ?, ?, ?, ?)", [
    box.domain, box.api, box.prefix, box.checked, box.checked,
  ]);
}

const all = () => db.query<Box, []>("SELECT domain, api, prefix, checked FROM boxes ORDER BY prefix").all();

/** Check boxes that are due, and forget the ones that have been gone too long. */
async function recheck() {
  const due = db.query<{ domain: string; checked: number }, [number]>("SELECT domain, checked FROM boxes WHERE tried < ?").all(Date.now() - RECHECK);
  for (const { domain, checked } of due) {
    const box = await check(domain);
    if (box) save(box);
    else if (checked < Date.now() - GIVE_UP) db.run("DELETE FROM boxes WHERE domain = ?", [domain]);
    else db.run("UPDATE boxes SET tried = ? WHERE domain = ?", [Date.now(), domain]);
  }
}
setInterval(recheck, 10 * 60_000);

function list(path: string) {
  const boxes = all();
  // Inside a box (or its root): that box knows, not us.
  const owner = boxes.find((b) => within(path, b.prefix));
  if (owner && path !== owner.prefix) return { path, box: owner.domain };
  const names = new Map<string, string | undefined>();
  for (const b of boxes) {
    if (b.prefix === path || !within(b.prefix, path)) continue;
    const name = b.prefix.slice(path === "/" ? 1 : path.length + 1).split("/")[0]!;
    const child = (path === "/" ? "" : path) + "/" + name;
    // A box's root is a box, even if other boxes live below it.
    if (!names.has(name) || child === b.prefix) names.set(name, child === b.prefix ? b.domain : names.get(name));
  }
  const entries = [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, box]) => (box ? { name, box } : { name }));
  return { path, ...(owner ? { box: owner.domain } : {}), entries };
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "access-control-allow-origin": "*", "cache-control": "max-age=60" } });

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
      }
      if (req.method === "POST" && url.pathname === "/register") {
        const { domain } = (await req.json()) as { domain?: string };
        const d = String(domain ?? "").toLowerCase();
        if (!DOMAIN_RE.test(d) && !PEERS[d]) return json({ error: "not a domain" }, 400);
        const box = await check(d);
        if (!box) return json({ error: `no box at https://${d}/.well-known/simplebox` }, 404);
        save(box);
        return json(box);
      }
      if (req.method === "GET" && url.pathname === "/list") {
        const raw = url.searchParams.get("path") ?? "/";
        if (!raw.startsWith("/") || raw.includes("\0")) return json({ error: "bad path" }, 400);
        const path = "/" + raw.split("/").filter((s) => s && s !== "." && s !== "..").join("/");
        return json(list(path));
      }
      if (req.method === "GET" && url.pathname === "/boxes") return json(all());
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(`A directory of Shared Computer boxes (${all().length} so far). See /boxes and /list?path=/\n`);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  },
});

console.log(`directory on http://${HOST}:${PORT}, data in ${DATA}`);
