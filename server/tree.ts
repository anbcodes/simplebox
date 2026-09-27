/**
 * The folders that aren't in anyone's home: this box's root, which lists its
 * users like an old `/home`, and the folders above boxes (`/`, `/com`), which
 * come from a directory server if the box has one (see directory/index.ts).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA, DIRECTORY, DOMAIN, PREFIX } from "./config";
import { USER_RE, statEntry, type Entry } from "./vfs";

const within = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/");
const folder = (name: string): Entry => ({ name, type: "dir", size: 0, mtime: 0 });

/** Everyone's home on this box. */
export function users(): Entry[] {
  return readdirSync(DATA)
    .filter((n) => USER_RE.test(n))
    .map((n) => statEntry(join(DATA, n), n))
    .filter((e): e is Entry => !!e && e.type !== "file")
    .sort((a, b) => a.name.localeCompare(b.name));
}

const cache = new Map<string, { names: string[]; until: number }>();

async function fromDirectory(path: string): Promise<string[]> {
  if (!DIRECTORY) return [];
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return hit.names;
  let names: string[] = [];
  try {
    const res = await fetch(`${DIRECTORY}/list?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(4000) });
    const data = (await res.json()) as { entries?: { name: string }[] };
    names = (data.entries ?? []).map((e) => String(e.name)).filter((n) => /^[a-z0-9-]+$/.test(n));
  } catch {}
  cache.set(path, { names, until: Date.now() + 60_000 });
  return names;
}

/** What's in a folder above boxes: the boxes the directory knows of, and always this one. */
export async function above(path: string): Promise<Entry[]> {
  const names = new Set(await fromDirectory(path));
  if (within(PREFIX, path) && PREFIX !== path) names.add(PREFIX.slice(path === "/" ? 1 : path.length + 1).split("/")[0]!);
  return [...names].sort().map(folder);
}

/** Tell the directory about this box, now and every so often (it forgets boxes it can't reach). */
export function register() {
  if (!DIRECTORY) return;
  const go = () =>
    fetch(`${DIRECTORY}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: DOMAIN }),
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => console.log(`directory ${DIRECTORY}: ${res.ok ? "registered" : (await res.json()).error}`))
      .catch((e) => console.log(`directory ${DIRECTORY}: ${e.message}`));
  setTimeout(go, 2000); // once we're listening, so it can check us
  setInterval(go, 6 * 60 * 60_000);
}
