import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./config";

mkdirSync(DATA, { recursive: true });

/** The one special metadata db, at the top of the data folder. Everything else is plain files. */
export const db = new Database(join(DATA, ".box.sqlite"), { create: true });

db.run(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  -- Sharing: who besides the owner may read/write a path (inherited by everything
  -- below it). read/write are JSON lists of addresses, or "*" for everyone.
  CREATE TABLE IF NOT EXISTS acl (
    path TEXT PRIMARY KEY,
    read TEXT NOT NULL DEFAULT '[]',
    write TEXT NOT NULL DEFAULT '[]'
  );
  -- Small settings of the box itself, like its signing key.
  CREATE TABLE IF NOT EXISTS meta (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Nonces of requests from other boxes we've accepted, so they can't be replayed.
  CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    until INTEGER NOT NULL
  );
  -- App permissions a user has granted: kind is 'folder' | 'app' | 'net'.
  CREATE TABLE IF NOT EXISTS grants (
    id INTEGER PRIMARY KEY,
    user TEXT NOT NULL,
    app TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    access TEXT NOT NULL DEFAULT '',
    UNIQUE (user, app, kind, target)
  );
`);

// Older boxes kept key pairs per user; boxes now have one key (see fed.ts).
const cols = db.query<{ name: string }, []>("PRAGMA table_info(users)").all().map((c) => c.name);
for (const c of ["enc_pub", "enc_priv", "sig_pub", "sig_priv"]) if (cols.includes(c)) db.run(`ALTER TABLE users DROP COLUMN ${c}`);
db.run("DROP TABLE IF EXISTS known_keys");
