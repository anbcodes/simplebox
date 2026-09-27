import { resolve } from "node:path";

/** The domain this box answers for. Users are `name@DOMAIN`. */
export const DOMAIN = process.env.BOX_DOMAIN ?? "localhost";
export const PORT = Number(process.env.PORT ?? 3000);
/** What to listen on. Behind a tunnel or proxy, set BOX_HOST=127.0.0.1. */
export const HOST = process.env.BOX_HOST ?? "0.0.0.0";
export const DATA = resolve(process.env.BOX_DATA ?? "./data");
export const DEV = process.env.NODE_ENV !== "production";
export const ALLOW_SIGNUP = process.env.BOX_SIGNUP !== "off";

/** Where this box's API is reachable from the outside (advertised in /.well-known/simplebox). */
export const PUBLIC_URL = (process.env.BOX_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");

/**
 * Where to find other boxes' `/.well-known/simplebox`. By default that's
 * `https://<domain>`, but for local testing you can say e.g.
 * `BOX_PEERS=b.test=http://localhost:3001`.
 */
export const PEERS: Record<string, string> = Object.fromEntries(
  (process.env.BOX_PEERS ?? "")
    .split(",")
    .filter(Boolean)
    .map((s) => s.split("=", 2) as [string, string]),
);

/** `simplebox.com` -> `/com/simplebox` */
export function domainPrefix(domain: string) {
  return "/" + domain.split(".").reverse().join("/");
}

export const PREFIX = domainPrefix(DOMAIN);

/**
 * A directory server (see directory/index.ts) that lists the folders above boxes,
 * like `/` and `/com`. Optional: without one, those folders only show this box.
 */
export const DIRECTORY = (process.env.BOX_DIRECTORY ?? "").replace(/\/$/, "");
export const SYSTEM_USER = "system";

/** The origin that serves a domain's `/.well-known/simplebox`. */
export function wellKnownOrigin(domain: string) {
  return PEERS[domain] ?? `https://${domain}`;
}
