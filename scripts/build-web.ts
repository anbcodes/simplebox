/**
 * Build the computer as a static site (for Cloudflare Pages or any static host):
 *
 *   bun run build:web [default-domain]
 *
 * Writes dist/web/. `default-domain` pre-fills the login box, e.g. `anb.codes`.
 * `_headers` gives the program sandbox its CSP (Cloudflare Pages and Netlify read it).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist/web");
const domain = process.argv[2] ?? "";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const out = await Bun.build({
  entrypoints: [join(ROOT, "client/main.ts"), join(ROOT, "client/worker.ts")],
  outdir: OUT,
  target: "browser",
  minify: true,
});
if (!out.success) {
  console.error(out.logs);
  process.exit(1);
}

let html = await Bun.file(join(ROOT, "client/index.html")).text();
if (domain) {
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error(`not a domain: ${domain}`);
  html = html.replace("<title>", `<meta name="box-domain" content="${domain}">\n  <title>`);
}
writeFileSync(join(OUT, "index.html"), html);

// Must match WORKER_CSP in server/index.ts: this is what keeps programs off the network.
writeFileSync(join(OUT, "_headers"), `/worker.js
  Content-Security-Policy: default-src 'none'; script-src blob:
  X-Content-Type-Options: nosniff

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`);

console.log(`built ${OUT}${domain ? ` (default domain ${domain})` : ""}`);
