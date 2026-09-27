/** Creating accounts: used by signup and by `cli.ts adduser`. */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, SYSTEM_USER } from "./config";
import { db } from "./db";
import { HttpError } from "./errors";
import { USER_RE, homeOf, statEntry } from "./vfs";

const WELCOME = `Welcome to the Shared Computer!

This desktop is your home folder. Everything here is synced to your box.

- Double-click things to open them.
- "Apps" is a link to the system apps folder. Links can point anywhere,
  even at another person's files or at another box.
- Use File > New program to write your own. Programs are just files.
  Apps/API.txt says what programs can do.
- File > Share... makes something readable or writable by others,
  on this box or any other.
- Box > Theme... changes the colors.
- Box > Permissions... shows what each program is allowed to do. Right-click
  a window's title bar for just that program.
- Go > Terminal, if you'd rather type. Try: ls /
`;

export function createHome(user: string) {
  const home = join(DATA, user);
  mkdirSync(home);
  writeFileSync(join(home, "Welcome.txt"), WELCOME);
  symlinkSync(homeOf(SYSTEM_USER), join(home, "Apps"));
}

/** Make a new user and their home folder. */
export async function createUser(user: string, password: string) {
  if (!USER_RE.test(user ?? "") || user === SYSTEM_USER) {
    throw new HttpError(400, "user names are lowercase letters, digits, - and _");
  }
  if (!password || password.length < 4) throw new HttpError(400, "password is too short");
  if (db.query("SELECT 1 FROM users WHERE name = ?").get(user) || statEntry(join(DATA, user), user)) {
    throw new HttpError(409, "that name is taken");
  }
  db.run("INSERT INTO users (name, hash, created) VALUES (?, ?, ?)", [user, await Bun.password.hash(password), Date.now()]);
  createHome(user);
}
