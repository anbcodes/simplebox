// A terminal, for poking around the whole shared computer by typing.
// Type "help" to see what it can do.
export const title = "Terminal";
export const sizes = [[560, 340], [266, 430]];
export const icon = "terminal";

const HELP = `ls [-l] [path...]      what's in a folder (/ lists every box)
cd [path]              go somewhere (just cd: home)
pwd, whoami, date      where, who, when
cat file...            show files
echo text [> file]     print, or write to a file (>> adds to the end)
touch file             make an empty file
mkdir folder...        make folders
rm path...             delete (folders too, with everything in them)
mv from to             move or rename
cp from to             copy a file
ln target name         make a link (target can be anywhere, even another box)
share path [read=a,b] [write=c]   see or change who can use something
open path              open like a double-click (programs run)
edit path              open in the Editor
clear, history, exit
Paths can be full (/com/box/you/x), relative, or start with ~ (your home).
Up and Down go through what you typed before; Tab finishes names.`;

type Item = { name: string; path: string; type: "file" | "dir" | "link"; size: number; mtime: number; target?: string };

export default function main(sys) {
  const { ui } = sys;
  const user = sys.me.split("@")[0];
  let cwd: string = sys.args.file ?? sys.home;
  let out = `${sys.me} on the Shared Computer. Type help to see what you can do.\n`;
  let line = "";
  const history: string[] = [];
  let hi = 0;
  let busy = false;

  // ---- Paths ----------------------------------------------------------------------

  function abs(p: string): string {
    if (p === "~" || p.startsWith("~/")) p = sys.home + p.slice(1);
    else if (!p.startsWith("/")) p = cwd + "/" + p;
    const parts: string[] = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return "/" + parts.join("/");
  }
  const pretty = (p: string) => (p === sys.home || p.startsWith(sys.home + "/") ? "~" + p.slice(sys.home.length) : p);
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const prompt = () => `${user} ${pretty(cwd)} $ `;

  /** Split a command line into words, with "quotes" and 'quotes'. */
  function words(s: string): string[] {
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  }

  // ---- Commands ----------------------------------------------------------------------

  const cols = () => Math.max(20, Math.floor((sys.size.w - 10) / 6));

  function columns(names: string[]): string {
    if (!names.length) return "";
    const width = Math.max(...names.map((n) => n.length)) + 2;
    const per = Math.max(1, Math.floor(cols() / width));
    const rows: string[] = [];
    for (let i = 0; i < names.length; i += per) rows.push(names.slice(i, i + per).map((n) => n.padEnd(width)).join("").trimEnd());
    return rows.join("\n");
  }

  const size = (n: number) => (n < 1024 ? `${n}` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1024 / 1024).toFixed(1)}M`);
  const when = (t: number) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "".padEnd(16));

  async function ls(args: string[]) {
    const long = args.includes("-l");
    const paths = args.filter((a) => a !== "-l");
    const parts: string[] = [];
    for (const p of paths.length ? paths : ["."]) {
      const path = abs(p);
      const st = await sys.fs.stat(path).catch((e) => e);
      if (st instanceof Error) {
        if (paths.length < 2) throw st;
        parts.push(`${p}: ${st.message}`);
        continue;
      }
      const items: Item[] = st.type === "dir" ? await sys.fs.list(path) : [{ name: p, path, type: "file", size: st.size, mtime: st.mtime }];
      const label = (i: Item) => i.name + (i.type === "dir" ? "/" : "") + (i.type === "link" ? ` -> ${i.target}` : "");
      const body = long
        ? items.map((i) => `${i.type === "dir" ? "d" : i.type === "link" ? "l" : "-"} ${size(i.size).padStart(7)} ${when(i.mtime)} ${label(i)}`).join("\n")
        : columns(items.map(label));
      parts.push(paths.length > 1 ? `${p}:\n${body}` : body);
    }
    return parts.join("\n\n");
  }

  const need = (args: string[], n: number, usage: string) => {
    if (args.length < n) throw new Error(`usage: ${usage}`);
  };

  const commands: Record<string, (args: string[]) => Promise<string | void> | string | void> = {
    help: () => HELP,
    pwd: () => cwd,
    whoami: () => sys.me,
    date: () => new Date().toString(),
    clear: () => {
      out = "";
    },
    history: () => history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\n"),
    exit: () => sys.quit(),
    ls,
    async cd(args) {
      const path = abs(args[0] ?? "~");
      const st = await sys.fs.stat(path);
      if (st.type !== "dir") throw new Error(`not a folder: ${args[0]}`);
      cwd = path;
      sys.setTitle(`Terminal: ${pretty(cwd)}`);
    },
    async cat(args) {
      need(args, 1, "cat file...");
      const texts: string[] = [];
      for (const a of args) texts.push(await sys.fs.read(abs(a)));
      return texts.join("").replace(/\n$/, "");
    },
    echo: (args) => args.join(" "),
    async touch(args) {
      need(args, 1, "touch file...");
      for (const a of args) if (!(await sys.fs.exists(abs(a)))) await sys.fs.write(abs(a), "");
    },
    async mkdir(args) {
      need(args, 1, "mkdir folder...");
      for (const a of args) await sys.fs.mkdir(abs(a));
    },
    async rm(args) {
      const paths = args.filter((a) => !/^-[rf]+$/.test(a));
      need(paths, 1, "rm path...");
      for (const a of paths) await sys.fs.remove(abs(a));
    },
    async mv(args) {
      need(args, 2, "mv from to");
      let to = abs(args[1]);
      if ((await sys.fs.exists(to)) && (await sys.fs.stat(to)).type === "dir") to += "/" + base(abs(args[0]));
      await sys.fs.rename(abs(args[0]), to);
    },
    async cp(args) {
      need(args, 2, "cp from to");
      let to = abs(args[1]);
      if ((await sys.fs.exists(to)) && (await sys.fs.stat(to)).type === "dir") to += "/" + base(abs(args[0]));
      await sys.fs.write(to, await sys.fs.readBytes(abs(args[0])));
    },
    async ln(args) {
      const rest = args.filter((a) => a !== "-s");
      need(rest, 2, "ln target name");
      await sys.fs.link(abs(rest[1]), abs(rest[0]));
    },
    async share(args) {
      need(args, 1, "share path [read=a,b] [write=c]");
      const path = abs(args[0]);
      const acl = await sys.fs.sharing(path);
      const set = args.slice(1);
      if (set.length) {
        for (const s of set) {
          const [k, v = ""] = s.split("=");
          if (k !== "read" && k !== "write") throw new Error(`usage: share path [read=a,b] [write=c]`);
          acl[k] = v.split(",").filter(Boolean);
        }
        await sys.fs.share(acl.path, { read: acl.read, write: acl.write });
      }
      return `${pretty(acl.path)}\n  read:  ${acl.read.join(", ") || "(only you)"}\n  write: ${acl.write.join(", ") || "(only you)"}`;
    },
    async open(args) {
      need(args, 1, "open path");
      for (const a of args) await sys.apps.open(abs(a));
    },
    async edit(args) {
      need(args, 1, "edit path");
      for (const a of args) await sys.apps.open(abs(a), { edit: true });
    },
  };

  async function run(cmd: string) {
    let ws = words(cmd);
    // "> file" and ">> file" at the end send the output to a file.
    let into: { path: string; append: boolean } | null = null;
    const r = ws.findIndex((w) => w === ">" || w === ">>");
    if (r >= 0) {
      if (!ws[r + 1]) throw new Error("where to? (> file)");
      into = { path: abs(ws[r + 1]), append: ws[r] === ">>" };
      ws = ws.slice(0, r);
    }
    const [name, ...args] = ws;
    if (!name) return;
    const fn = commands[name];
    let result: string | void;
    if (fn) result = await fn(args);
    else if (/\.(ts|js)$/.test(name) || name.includes("/")) result = await sys.apps.open(abs(name)); // run a program
    else throw new Error(`${name}: no such command (try help)`);
    if (into) {
      const before = into.append && (await sys.fs.exists(into.path)) ? await sys.fs.read(into.path) : "";
      await sys.fs.write(into.path, before + (result ?? "") + "\n");
    } else if (result) print(result);
  }

  function print(text: string) {
    // Long lines wrap, like a real terminal.
    const n = cols();
    out += text.split("\n").map((l) => l.match(new RegExp(`.{1,${n}}`, "g"))?.join("\n") ?? "").join("\n") + "\n";
    const lines = out.split("\n");
    if (lines.length > 2000) out = lines.slice(-2000).join("\n");
  }

  async function submit() {
    const cmd = line;
    line = "";
    print(prompt() + cmd);
    if (cmd.trim()) {
      history.push(cmd);
      hi = history.length;
    }
    busy = true;
    draw();
    try {
      await run(cmd);
    } catch (e) {
      print((e as Error).message);
    }
    busy = false;
    draw();
    ui.focus("cmd");
  }

  // ---- Tab: finish the name being typed ------------------------------------------------

  async function complete() {
    const ws = line.split(/\s+/);
    const word = ws[ws.length - 1] ?? "";
    const slash = word.lastIndexOf("/");
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : "";
    const start = word.slice(slash + 1);
    let items: Item[];
    try {
      items = await sys.fs.list(abs(dirPart || "."));
    } catch {
      return;
    }
    const hits = items.filter((i) => i.name.startsWith(start));
    if (!hits.length) return;
    let common = hits[0].name;
    for (const i of hits) while (!i.name.startsWith(common)) common = common.slice(0, -1);
    const one = hits.length === 1 ? hits[0] : null;
    const tail = one ? (one.type === "file" ? " " : "/") : "";
    line = line.slice(0, line.length - start.length) + common + tail;
    if (!one && common === start) print(prompt() + line + "\n" + columns(hits.map((i) => i.name)));
    draw();
    ui.focus("cmd");
  }

  // ---- Drawing ------------------------------------------------------------------

  function draw() {
    const { w, h } = sys.size;
    const p = prompt();
    const pw = Math.min(p.length * 6 + 4, w / 2);
    ui.render([
      ui.input(-1, -1, w + 2, h - 18, out.replace(/\n$/, ""), null, { multiline: true, readonly: true, font: "mono", key: "out" }),
      ui.rect(0, h - 19, w, 19, "field"),
      ui.line(0, h - 19, w, h - 19, "line"),
      ui.text(4, h - 13, ui.fit(p, pw - 4, "mono"), { font: "mono", color: busy ? "dim" : "accent" }),
      ui.input(pw - 2, h - 18, w - pw + 3, 19, line, (v) => { line = v; draw(); }, { font: "mono", key: "cmd", onSubmit: submit }),
    ]);
  }

  ui.onKey((k) => {
    if (k.key === "ArrowUp" || k.key === "ArrowDown") {
      hi = Math.max(0, Math.min(history.length, hi + (k.key === "ArrowUp" ? -1 : 1)));
      line = history[hi] ?? "";
      draw();
      ui.focus("cmd");
    } else if (k.key === "Tab") complete();
    else if (k.key === "l" && k.ctrl) {
      out = "";
      draw();
    } else if (k.key.length === 1 && !k.ctrl && !k.meta) {
      // Typing while the output has the cursor: it goes on the command line.
      line += k.key;
      draw();
      ui.focus("cmd");
    }
  });
  ui.onTheme(draw);
  sys.setTitle(`Terminal: ${pretty(cwd)}`);
  draw();
  ui.focus("cmd");
}
