/**
 * Sharing between boxes.
 *
 * Boxes talk to each other through the same API the computer uses. Instead of a
 * login token, a request from another box says who it's for and is signed by
 * that person's box:
 *
 *   Box-As: carol@b.test
 *   Box-Signature: <ts>.<nonce>.<Ed25519 signature>
 *
 * The signature covers the target box, method, path and query, `Box-As`, the
 * time, the nonce, and a hash of the body. The receiving box finds b.test's
 * public key in `https://b.test/.well-known/simplebox` and checks it. After that
 * carol is just `carol@b.test` in sharing lists, like a local user.
 *
 * Each box is trusted for its own users, exactly like email: b.test can speak
 * for anyone @b.test and no one else. Replies are ordinary HTTPS responses.
 */
import { DOMAIN } from "./config";
import { b64, sha256, sign, utf8, verify, type Bytes } from "./crypto";
import { db } from "./db";
import { KEY, boxFor, splitAddress, type Box } from "./discovery";
import { HttpError } from "./errors";
import { addressOf } from "./vfs";

const WINDOW = 5 * 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;

async function signedBytes(box: string, method: string, target: string, as: string, ts: string, nonce: string, body: Bytes) {
  return utf8(["simplebox/1", box, method, target, as, ts, nonce, b64(await sha256(body))].join("\n"));
}

/** Call another box's API as one of our users. `target` is relative to its API, e.g. `/fs/read?path=…`. */
export async function boxFetch(user: string, box: Box, method: string, target: string, body?: Bytes): Promise<Response> {
  const as = addressOf(user);
  const ts = String(Date.now());
  const nonce = b64(crypto.getRandomValues(new Uint8Array(18)));
  const sig = await sign(KEY.priv, await signedBytes(box.domain, method, target, as, ts, nonce, body ?? new Uint8Array()));
  return fetch(box.api + target, {
    method,
    body,
    headers: { "box-as": as, "box-signature": `${ts}.${nonce}.${sig}` },
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
}

/**
 * Who a signed request from another box is for, or null if it isn't one.
 * Throws if it claims to be signed but doesn't check out.
 */
export async function signedBy(req: Request, url: URL, body: Bytes): Promise<string | null> {
  const as = req.headers.get("box-as");
  const header = req.headers.get("box-signature");
  if (!as && !header) return null;
  const [ts, nonce, sig] = (header ?? "").split(".");
  if (!as || !ts || !nonce || !sig) throw new HttpError(401, "bad Box-Signature");
  const [, domain] = splitAddress(as);
  if (domain === DOMAIN) throw new HttpError(401, "our own users log in");
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts)) > WINDOW) throw new HttpError(401, "request is too old (or clocks disagree)");
  if (!NONCE_RE.test(nonce)) throw new HttpError(401, "bad nonce");

  const target = url.pathname.replace(/^\/api/, "") + url.search;
  const bytes = await signedBytes(DOMAIN, req.method, target, as, ts, nonce, body);
  let box = await boxFor(domain);
  // If it doesn't check out, the box may have a new key: look once more.
  if (box && !(await verify(box.key, bytes, sig))) box = await boxFor(domain, true);
  if (!box || !(await verify(box.key, bytes, sig))) throw new HttpError(401, `not signed by ${domain}`);

  const now = Date.now();
  db.run("DELETE FROM nonces WHERE until < ?", [now]);
  const fresh = db.run("INSERT OR IGNORE INTO nonces (nonce, until) VALUES (?, ?)", [nonce, now + 2 * WINDOW]);
  if (!fresh.changes) throw new HttpError(401, "request was replayed");
  return as;
}
