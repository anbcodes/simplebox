/**
 * The virtual filesystem. Every path is global: `/com/simplebox/andrew/notes.txt`
 * is `notes.txt` in the home of andrew@simplebox.com. Paths under our own
 * domain map onto `DATA/<user>/...`; anything else lives on another box.
 *
 * Symlinks are real symlinks on disk whose target is a *virtual* path, so a
 * link can point at another user's file or at a file on another box.
 */
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { DATA, DOMAIN, PREFIX } from "./config";
import { db } from "./db";
import { boxForPath, type Box } from "./discovery";
import { HttpError } from "./errors";

export { HttpError };

/** A place on this box. `owner` is the user whose home it's in. */
export type Local = { remote: false; virt: string; fsPath: string; owner: string };
/**
 * A place on another box. `via` is the local link we followed to get there
 * (whoever can read that link may learn where it points).
 */
export type Remote = { remote: true; virt: string; box: Box; via: Place | null };
export type Resolved = Local | Remote;
export type Place = { virt: string; owner: string };

export const USER_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function normalize(p: string): string {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) {
    throw new HttpError(400, `bad path: ${p}`);
  }
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

export const homeOf = (user: string) => `${PREFIX}/${user}`;
export const addressOf = (user: string) => `${user}@${DOMAIN}`;

/** Follow symlinks (including in the last component) until we land on a real place. */
export async function resolve(virt: string, hops = 0, via: Place | null = null): Promise<Resolved> {
  virt = normalize(virt);
  if (hops > 16) throw new HttpError(400, "too many levels of symlinks");
  if (!under(virt, PREFIX)) {
    const box = await boxForPath(virt);
    return { remote: true, virt, box, via };
  }
  const comps = virt.slice(PREFIX.length).split("/").filter(Boolean);
  const user = comps[0];
  if (!user || !USER_RE.test(user)) throw new HttpError(404, `no such user in ${virt}`);
  for (let j = 0; j < comps.length; j++) {
    const fsPath = join(DATA, ...comps.slice(0, j + 1));
    let st;
    try {
      st = lstatSync(fsPath);
    } catch {
      break; // doesn't exist (yet): the rest is plain
    }
    if (st.isSymbolicLink()) {
      const target = readlinkSync(fsPath);
      const linkDir = posix.join(PREFIX, ...comps.slice(0, j));
      const base = target.startsWith("/") ? target : posix.join(linkDir, target);
      const link = { virt: posix.join(PREFIX, ...comps.slice(0, j + 1)), owner: user };
      return resolve(posix.join(base, ...comps.slice(j + 1)), hops + 1, link);
    }
  }
  return { remote: false, virt, fsPath: join(DATA, ...comps), owner: user };
}

/** Resolve the parent, but not the last component (for remove/rename/link). */
export async function resolveNoFollow(virt: string): Promise<Resolved> {
  virt = normalize(virt);
  const parent = await resolve(posix.dirname(virt));
  const name = posix.basename(virt);
  if (parent.remote) return { ...parent, virt: posix.join(parent.virt, name) };
  if (parent.virt === PREFIX) throw new HttpError(403, "can't touch a home directory");
  return { ...parent, virt: posix.join(parent.virt, name), fsPath: join(parent.fsPath, name) };
}

// ---- Sharing ---------------------------------------------------------------

/** Addresses (`bob@simplebox.com`, on this box or any other), or "*" for everyone. */
export type Acl = { read: string[]; write: string[] };

const getAcl = db.query<{ read: string; write: string }, [string]>("SELECT read, write FROM acl WHERE path = ?");

export function aclOf(virt: string): Acl | null {
  const row = getAcl.get(virt);
  if (!row) return null;
  // Older lists held {who, ...keys} objects.
  const who = (l: (string | { who: string })[]) => l.map((e) => (typeof e === "string" ? e : e.who));
  return { read: who(JSON.parse(row.read)), write: who(JSON.parse(row.write)) };
}

/** The nearest ACL at or above a place, up to the owner's home. */
function effectiveAcl(p: Place): Acl | null {
  const home = homeOf(p.owner);
  for (let q = p.virt; under(q, home); q = posix.dirname(q)) {
    const acl = aclOf(q);
    if (acl) return acl;
    if (q === home) break;
  }
  return null;
}

/**
 * `who` is a local user's address, someone on another box whose box signed for
 * them (see fed.ts), or null for the public.
 */
export function can(who: string | null, p: Place, mode: "read" | "write"): boolean {
  if (who === addressOf(p.owner)) return true;
  const acl = effectiveAcl(p);
  if (!acl) return false;
  const list = mode === "read" ? [...acl.read, ...acl.write] : acl.write;
  return list.some((e) => e === "*" || e === who);
}

export function mustCan(who: string | null, p: Place, mode: "read" | "write") {
  if (!can(who, p, mode)) throw new HttpError(who ? 403 : 401, `no ${mode} access to ${p.virt}`);
}

export function setAcl(virt: string, acl: Acl) {
  if (!acl.read.length && !acl.write.length) db.run("DELETE FROM acl WHERE path = ?", [virt]);
  else
    db.run("INSERT OR REPLACE INTO acl (path, read, write) VALUES (?, ?, ?)", [
      virt, JSON.stringify(acl.read), JSON.stringify(acl.write),
    ]);
}

// ---- Listing ---------------------------------------------------------------

export type Entry = {
  name: string;
  type: "file" | "dir" | "link";
  size: number;
  mtime: number;
  target?: string;
};

export function statEntry(fsPath: string, name: string): Entry | null {
  try {
    const st = lstatSync(fsPath);
    if (st.isSymbolicLink()) {
      return { name, type: "link", size: 0, mtime: st.mtimeMs, target: readlinkSync(fsPath) };
    }
    return { name, type: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

export function kindOf(fsPath: string): "file" | "dir" | null {
  try {
    return statSync(fsPath).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}
