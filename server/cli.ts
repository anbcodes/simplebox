/**
 * Admin commands, run on the box itself:
 *
 *   bun server/cli.ts moved <user> <new-home>
 *     The user moved to another box. Their old home is archived and replaced by
 *     a symlink, so every old path (and every link anyone made to it) keeps working:
 *       bun server/cli.ts moved andrew /com/newbox/andrew
 *
 *   bun server/cli.ts adduser <user> [password]
 *     Create an account (for boxes with signups off). Asks for the password if
 *     it isn't given, so it stays out of your shell history.
 *
 *   bun server/cli.ts passwd <user> [password]
 *
 * Run them with the same environment as the box, e.g.
 *   bun --env-file=deploy/anb.codes.env server/cli.ts adduser andrew
 *
 */
import { existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join, posix } from "node:path";
import { DATA } from "./config";
import { createUser } from "./accounts";
import { db } from "./db";

const [cmd, user, arg] = process.argv.slice(2);

if (cmd === "moved" && user && arg?.startsWith("/")) {
  const home = join(DATA, user);
  if (existsSync(home)) {
    mkdirSync(join(DATA, ".archive"), { recursive: true });
    const archived = join(DATA, ".archive", `${user}-${Date.now()}`);
    renameSync(home, archived);
    console.log(`archived old home to ${archived}`);
  }
  symlinkSync(posix.normalize(arg), home);
  db.run("DELETE FROM sessions WHERE user = ?", [user]);
  console.log(`${user} now points at ${arg}`);
} else if (cmd === "adduser" && user) {
  await createUser(user, arg ?? prompt("Password:") ?? "");
  console.log(`created ${user}`);
} else if (cmd === "passwd" && user) {
  const password = arg ?? prompt("New password:") ?? "";
  if (password.length < 4) throw new Error("password is too short");
  db.run("UPDATE users SET hash = ? WHERE name = ?", [await Bun.password.hash(password), user]);
  console.log("ok");
} else {
  console.log("usage:\n  bun server/cli.ts moved <user> <new-home-path>\n  bun server/cli.ts adduser <user> [password]\n  bun server/cli.ts passwd <user> [password]");
  process.exit(1);
}
