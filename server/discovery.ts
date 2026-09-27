/**
 * Finding other boxes, and the keys of the people on them.
 *
 * A box for domain `d` publishes `https://d/.well-known/simplebox`:
 *   { "simplebox": 1, "domain": "d", "api": "https://…/api", "prefix": "/…", "key": "…" }
 * `key` is the box's Ed25519 public key, which it signs its users' requests to
 * other boxes with (see fed.ts).
 *
 * For a path like `/com/simplebox/andrew/x`, we ask `com`, then `simplebox.com`,
 * then `andrew.simplebox.com`, …: the first (shortest) domain with a box owns the
 * path. That makes paths unambiguous without any central registry.
 */
import { DOMAIN, PEERS, PREFIX, PUBLIC_URL, domainPrefix, wellKnownOrigin } from "./config";
import { isKey, newSigningKey } from "./crypto";
import { db } from "./db";
import { HttpError } from "./errors";

export type Box = { domain: string; api: string; prefix: string; key: string };

/** This box's signing key, made the first time the box starts. */
async function boxKey(): Promise<{ pub: string; priv: string }> {
  const get = () => db.query<{ value: string }, []>("SELECT value FROM meta WHERE name = 'key'").get();
  if (!get()) db.run("INSERT OR IGNORE INTO meta (name, value) VALUES ('key', ?)", [JSON.stringify(await newSigningKey())]);
  return JSON.parse(get()!.value);
}
export const KEY = await boxKey();

export const LOCAL: Box = { domain: DOMAIN, api: `${PUBLIC_URL}/api`, prefix: PREFIX, key: KEY.pub };

const FOUND_TTL = 60 * 60_000;
const MISSING_TTL = 10 * 60_000;
const cache = new Map<string, { box: Box | null; until: number }>();

export function wellKnown() {
  return { simplebox: 1, domain: DOMAIN, api: LOCAL.api, prefix: PREFIX, key: KEY.pub };
}

/**
 * Only accept an API that belongs to the domain: https, on the domain or one of
 * its subdomains, with no query string. Otherwise anyone could point us at an
 * internal address and have this box fetch it for them. (Configured peers are
 * trusted to live wherever the config says.)
 */
function apiAllowed(domain: string, api: string) {
  let u: URL;
  try {
    u = new URL(api);
  } catch {
    return false;
  }
  if (u.search || u.hash || u.username || u.password) return false;
  if (PEERS[domain]) return u.origin === new URL(PEERS[domain]).origin;
  return u.protocol === "https:" && (u.hostname === domain || u.hostname.endsWith("." + domain));
}

/**
 * The box for exactly this domain, or null if it doesn't have one. `fresh` skips
 * the cache (when a box may have changed its key), at most once a minute.
 */
export async function boxFor(domain: string, fresh = false): Promise<Box | null> {
  if (domain === DOMAIN) return LOCAL;
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith(".") || domain.includes("..")) return null;
  const hit = cache.get(domain);
  const tooSoon = hit && hit.until - (hit.box ? FOUND_TTL : MISSING_TTL) > Date.now() - 60_000;
  if (hit && hit.until > Date.now() && (!fresh || tooSoon)) return hit.box;
  let box: Box | null = null;
  try {
    const res = await fetch(`${wellKnownOrigin(domain)}/.well-known/simplebox`, {
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    const info = (await res.json()) as Partial<Box> & { simplebox?: number };
    if (res.ok && info.simplebox === 1 && info.domain === domain && apiAllowed(domain, info.api ?? "") && isKey(info.key)) {
      box = { domain, api: info.api!.replace(/\/$/, ""), prefix: domainPrefix(domain), key: info.key };
    }
  } catch {}
  cache.set(domain, { box, until: Date.now() + (box ? FOUND_TTL : MISSING_TTL) });
  return box;
}

/** The box that owns a path (or whose root it is): the shortest domain along it that has one. */
export async function boxForPath(virt: string): Promise<Box> {
  const segs = virt.split("/").filter(Boolean);
  // A box needs a domain with a dot in it, so skip a lone first segment ("com").
  for (let n = 2; n <= segs.length; n++) {
    const box = await boxFor(segs.slice(0, n).reverse().join("."));
    if (box) return box;
  }
  throw new HttpError(404, `no box owns ${virt}`);
}

export function splitAddress(address: string): [string, string] {
  const m = /^([a-z0-9][a-z0-9_-]{0,31})@([a-z0-9.-]+)$/.exec(address);
  if (!m) throw new HttpError(400, `not an address: ${address}`);
  return [m[1]!, m[2]!];
}
