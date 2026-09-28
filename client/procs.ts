/**
 * Running programs. Each one is a worker; everything it does goes through
 * `call()` here, which is where permissions are checked and asked for.
 *
 * A few system programs are part of the OS itself (the desktop, the file browser
 * and the terminal) and may use all your files without asking: see TRUSTED.
 */
import type { Api, Grant } from "./api";
import { basename, dirname, normalize, pretty, within } from "./paths";
import { icons } from "./icons";
import { CHROME_H, CHROME_W, DOCK_H, MENU_H, newWinId, type Screen, type Win } from "./screen";
import type { El, KeyEvent, MenuItem } from "./ui";

/** System programs that are part of the OS, and so may use all of your files. */
const TRUSTED = ["Desktop.ts", "Files.ts", "Terminal.ts"];

export type DialogOpts = {
  title: string; text?: string; fields?: { label: string; value?: string; password?: boolean }[];
  ok?: string; cancel?: string | null;
};

export interface Os {
  api: Api;
  screen: Screen;
  me: string;
  home: string;
  /** The system programs folder of this box. */
  systemDir(): string;
  dialog(opts: DialogOpts): Promise<string[] | null>;
  ask(title: string, text: string, ok: string, cancel: string): Promise<boolean>;
  alert(text: string): Promise<void>;
  open(path: string, opts?: { edit?: boolean }): Promise<void>;
  /** The permissions window for one program. */
  permissionsOf(proc: Proc): void;
  /** The current theme's colors by name. */
  colors(): Record<string, string>;
  /** Origins that belong to the OS itself; programs may never call them. */
  osOrigins(): string[];
}

export class Proc {
  id = newWinId();
  win: Win | null = null;
  els: El[] = [];
  /** The menus it asked for, shown in the menu bar while its window is in front. */
  menus: { label: string; items: MenuItem[] }[] = [];
  denied = new Set<string>();
  worker: Worker;
  title: string;
  /** Set on the desktop program, which draws the desktop instead of a window. */
  desk = false;
  /** Set on a file picker: how to answer the program that asked. */
  answer: ((path: string | null) => void) | null = null;
  constructor(public path: string, public asked: string, public sessionFiles: Set<string>, public args: Args) {
    this.worker = new Worker("/worker.js", { type: "module" });
    this.title = basename(path).replace(/\.(ts|js)$/, "");
  }
  post(m: unknown) {
    this.worker.postMessage(m);
  }
}

type Perm = { kind: "folder"; target: string; access: "read" | "write" } | { kind: "net" | "app"; target: string };
/** How a program was opened: with a file or folder, and for Files, to pick something. */
export type Args = { file?: string; pick?: { mode: "open" | "save" | "folder"; name?: string; write?: boolean } };
type LaunchOpts = { desk?: boolean; modal?: boolean };

export class Procs {
  list: Proc[] = [];
  grants: Grant[] = [];

  constructor(private os: Os) {}

  async loadGrants() {
    this.grants = await this.os.api.grants();
  }

  async launch(path: string, args: Args = {}, opts: LaunchOpts = {}): Promise<Proc> {
    const { path: real, code } = await this.os.api.program(path);
    const files = new Set<string>(args.file ? [args.file] : []);
    const proc = new Proc(real, path, files, args);
    proc.desk = !!opts.desk;
    this.modal.set(proc, !!opts.modal);
    this.list.push(proc);
    proc.worker.onmessage = (e) => this.handle(proc, e.data);
    proc.worker.onerror = (e) => {
      e.preventDefault();
      this.crash(proc, e.message || "failed to start");
    };
    proc.post({ type: "init", code, path: real, args, me: this.os.me, home: this.os.home, colors: this.os.colors() });
    return proc;
  }

  private modal = new WeakMap<Proc, boolean>();

  /** Programs that are part of the OS (see TRUSTED). */
  trusted(proc: Proc) {
    return TRUSTED.some((name) => proc.path === `${this.os.systemDir()}/${name}`);
  }

  get desk() {
    return this.list.find((p) => p.desk) ?? null;
  }

  kill(proc: Proc) {
    proc.worker.terminate();
    this.list = this.list.filter((p) => p !== proc);
    proc.answer?.(null);
    const screen = this.os.screen;
    if (proc.win === screen.desk) {
      screen.desk = null;
      screen.invalidate();
    } else if (proc.win) screen.close(proc.win);
  }

  /** The screen changed size: the desktop follows it. */
  resized() {
    const d = this.desk;
    if (!d?.win) return;
    this.os.screen.fitDesk(d.win);
    d.post({ type: "resize", size: [d.win.w, d.win.h] });
  }

  /** Something in `dir` changed: tell the programs that may look at it. */
  changed(dir: string) {
    for (const p of this.list) {
      if (this.allowed(p, { kind: "folder", target: dir, access: "read" })) p.post({ type: "changed", dir });
    }
  }

  /** Tell every program the theme changed. */
  themeChanged() {
    const colors = this.os.colors();
    for (const p of this.list) p.post({ type: "theme", colors });
  }

  killAll() {
    for (const p of [...this.list]) this.kill(p);
  }

  private crash(proc: Proc, error: string) {
    this.kill(proc);
    this.os.alert(`${proc.title} crashed:\n\n${error}${proc.desk ? "\n\nBox > Restart desktop starts it again." : ""}`);
  }

  /**
   * The program's size that best fits the screen: among the sizes that fit,
   * prefer ones shaped like the screen (landscape/portrait), then the biggest.
   * If none fit, the smallest, cut down to the screen.
   */
  private pickSize(sizes: [number, number][]): [number, number] {
    const s = this.os.screen;
    const maxW = s.W - CHROME_W - 1, maxH = s.H - MENU_H - DOCK_H - CHROME_H - 3;
    const valid = (Array.isArray(sizes) ? sizes : []).filter((z) => Array.isArray(z) && z[0] > 0 && z[1] > 0);
    if (!valid.length) return [Math.min(320, maxW), Math.min(200, maxH)];
    const area = (z: [number, number]) => z[0] * z[1];
    const shaped = (z: [number, number]) => (z[0] >= z[1]) === !s.portrait ? 1 : 0;
    const fits = valid
      .filter(([w, h]) => w <= maxW && h <= maxH)
      .sort((a, b) => shaped(b) - shaped(a) || area(b) - area(a));
    const [w, h] = fits[0] ?? valid.sort((a, b) => area(a) - area(b))[0]!;
    return [Math.min(w, maxW), Math.min(h, maxH)];
  }

  private handle(proc: Proc, m: any) {
    const screen = this.os.screen;
    switch (m.type) {
      case "meta": {
        if (m.title) proc.title = String(m.title);
        const win: Win = {
          id: proc.id, title: proc.title, x: 0, y: 0, w: 0, h: 0, modal: this.modal.get(proc),
          icon: icons[m.icon as keyof typeof icons] ?? icons.program,
          render: () => proc.els,
          onKey: (key: KeyEvent) => proc.post({ type: "key", key }),
          onClose: () => {
            proc.win = null;
            this.kill(proc);
          },
          menu: () => ({
            items: [`Permissions for ${proc.title}...`, "Show source"],
            pick: (i) => (i === 0 ? this.os.permissionsOf(proc) : this.os.open(proc.path, { edit: true })),
          }),
        };
        if (proc.desk) {
          screen.fitDesk(win);
          screen.desk = proc.win = win;
          screen.invalidate();
        } else {
          [win.w, win.h] = this.pickSize(m.sizes);
          [win.x, win.y] = win.modal ? screen.center(win.w, win.h) : screen.place(win.w, win.h);
          proc.win = screen.add(win);
        }
        proc.post({ type: "start", size: [win.w, win.h] });
        break;
      }
      case "render": {
        const wire = (els: El[]): El[] =>
          els.map((el) => {
            if (el.t === "button" || el.t === "input" || el.t === "area" || el.t === "scroll") {
              el.on = (kind, data) => proc.post({ type: "event", id: el.id, kind, data });
            }
            if (el.t === "scroll") el.children = wire(el.children as El[]);
            return el;
          });
        proc.els = wire(m.els as El[]);
        screen.invalidate();
        break;
      }
      case "menus":
        proc.menus = Array.isArray(m.menus) ? m.menus : [];
        screen.invalidate();
        break;
      case "focus":
        // After this render has been drawn, so the input is there.
        if (proc.win) requestAnimationFrame(() => proc.win && screen.focusKey(proc.win, m.key));
        break;
      case "scrollTo":
        if (proc.win) requestAnimationFrame(() => proc.win && screen.scrollKey(proc.win, m.key, m.y));
        break;
      case "title":
        if (proc.win) proc.win.title = m.title;
        screen.invalidate();
        break;
      case "quit":
        this.kill(proc);
        break;
      case "crash":
        this.crash(proc, m.error);
        break;
      case "error":
        console.warn(`[${proc.title}]`, m.error);
        break;
      case "call":
        this.call(proc, m.method, m.args).then(
          (value) => proc.post({ type: "result", id: m.id, ok: true, value }),
          (err) => proc.post({ type: "result", id: m.id, ok: false, error: String(err?.message ?? err) }),
        );
        break;
    }
  }

  // ---- Permissions ---------------------------------------------------------------

  private allowed(proc: Proc, p: Perm, path?: string): boolean {
    if (p.kind === "folder" && this.trusted(proc)) return true;
    if (path && proc.sessionFiles.has(path)) return true;
    return this.grants.some((g) => {
      if (g.app !== proc.path || g.kind !== p.kind) return false;
      if (p.kind === "folder") {
        return within(path ?? p.target, g.target) && (p.access === "read" || g.access === "write");
      }
      return g.target === p.target;
    });
  }

  private describe(p: Perm) {
    const where = pretty(p.target, this.os.home);
    if (p.kind === "folder") return `${p.access === "write" ? "read and change" : "read"} files in ${where}`;
    if (p.kind === "net") return `use the web API at ${p.target}`;
    return `send messages to the program ${where}`;
  }

  /** Make sure `proc` may do `p` (for `path`), asking the user if needed. */
  private async need(proc: Proc, p: Perm, path?: string) {
    if (this.allowed(proc, p, path)) return;
    const key = JSON.stringify(p);
    if (proc.denied.has(key)) throw new Error("permission denied");
    const ok = await this.os.ask(
      "Permission",
      `${proc.title} (${pretty(proc.path, this.os.home)}) wants to ${this.describe(p)}.`,
      "Allow",
      "Deny",
    );
    if (!ok) {
      proc.denied.add(key);
      throw new Error("permission denied");
    }
    await this.os.api.grant({ app: proc.path, kind: p.kind, target: p.target, access: p.kind === "folder" ? p.access : "" });
    await this.loadGrants();
  }

  private file = (proc: Proc, path: string, access: "read" | "write", folder = dirname(path)) =>
    this.need(proc, { kind: "folder", target: folder, access }, path);

  // ---- The system calls ------------------------------------------------------------

  private async call(proc: Proc, method: string, args: any[]): Promise<unknown> {
    const { api, home } = this.os;
    const norm = (p: unknown) => {
      if (typeof p !== "string" || !p) throw new Error("expected a path");
      return normalize(p, home);
    };
    switch (method) {
      case "fs.read": {
        const p = norm(args[0]);
        await this.file(proc, p, "read");
        return api.readText(p);
      }
      case "fs.readBytes": {
        const p = norm(args[0]);
        await this.file(proc, p, "read");
        return api.readBytes(p);
      }
      case "fs.exists": {
        const p = norm(args[0]);
        await this.file(proc, p, "read");
        return api.stat(p).then(() => true, () => false);
      }
      case "fs.stat": {
        const p = norm(args[0]);
        await this.file(proc, p, "read");
        return api.stat(p);
      }
      case "fs.list": {
        const p = norm(args[0]);
        await this.file(proc, p, "read", p);
        const { entries } = await api.list(p);
        return entries.map((e) => ({ ...e, path: `${p === "/" ? "" : p}/${e.name}` }));
      }
      case "fs.write": {
        const p = norm(args[0]);
        await this.file(proc, p, "write");
        await api.write(p, args[1]);
        this.changed(dirname(p));
        return;
      }
      case "fs.mkdir": {
        const p = norm(args[0]);
        await this.file(proc, p, "write");
        await api.mkdir(p);
        this.changed(dirname(p));
        return;
      }
      case "fs.remove": {
        const p = norm(args[0]);
        await this.file(proc, p, "write");
        await api.remove(p);
        this.changed(dirname(p));
        return;
      }
      case "fs.rename": {
        const [a, b] = [norm(args[0]), norm(args[1])];
        await this.file(proc, a, "write");
        await this.file(proc, b, "write");
        await api.rename(a, b);
        this.changed(dirname(a));
        if (dirname(b) !== dirname(a)) this.changed(dirname(b));
        return;
      }
      case "fs.link": {
        const p = norm(args[0]);
        await this.file(proc, p, "write");
        await api.link(p, norm(args[1]));
        this.changed(dirname(p));
        return;
      }
      case "fs.sharing": {
        const p = norm(args[0]);
        await this.file(proc, p, "write");
        return api.get("acl", { path: p });
      }
      case "fs.share": {
        const p = norm(args[0]);
        await this.file(proc, p, "write");
        const who = args[1] ?? {};
        const list = (l: unknown) => (Array.isArray(l) ? l.map(String) : []);
        await api.post("acl", { path: p, read: list(who.read), write: list(who.write) });
        return;
      }
      case "fs.upload": {
        const dir = norm(args[0]);
        await this.file(proc, dir, "write", dir);
        const files = await chooseFiles();
        for (const f of files) await api.write(`${dir}/${f.name}`, new Uint8Array(await f.arrayBuffer()));
        if (files.length) this.changed(dir);
        return files.map((f) => f.name);
      }
      case "fs.pick":
        return this.pick(proc, args[0] ?? {});
      case "fs.picked": {
        if (!proc.answer) throw new Error("only the file picker can answer");
        const answer = proc.answer;
        proc.answer = null;
        answer(args[0] === null ? null : norm(args[0]));
        this.kill(proc);
        return;
      }
      case "ui.prompt": {
        const o = args[0] ?? {};
        return this.os.dialog({
          title: this.titled(proc, o.title), text: o.text ? String(o.text) : undefined,
          fields: Array.isArray(o.fields) ? o.fields.map((f: any) => ({ label: String(f?.label ?? ""), value: String(f?.value ?? ""), password: !!f?.password })) : [],
          ok: o.ok ? String(o.ok) : undefined, cancel: o.cancel ? String(o.cancel) : undefined,
        });
      }
      case "ui.confirm":
        return this.os.ask(this.titled(proc, args[0]), String(args[1] ?? ""), String(args[2] ?? "OK"), "Cancel");
      case "ui.alert":
        await this.os.dialog({ title: proc.title, text: String(args[0] ?? ""), cancel: null });
        return;
      case "net.fetch": {
        // Straight from the browser, without cookies or a referrer, and no
        // redirects (which could lead to an origin the user didn't approve).
        // Only APIs that allow cross-origin calls will answer.
        const url = new URL(String(args[0]));
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("only https:// APIs");
        if (this.os.osOrigins().includes(url.origin)) throw new Error("programs can't call the box directly");
        await this.need(proc, { kind: "net", target: url.origin });
        const o = args[1] ?? {};
        const res = await fetch(url, {
          method: o.method ?? "GET", headers: o.headers, body: o.body,
          mode: "cors", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
        });
        return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
      }
      case "apps.send": {
        const target = norm(args[0]);
        await this.need(proc, { kind: "app", target });
        let targets = this.list.filter((p) => p.path === target || p.asked === target);
        if (!targets.length) targets = [await this.launch(target)];
        for (const t of targets) t.post({ type: "message", from: proc.path, data: args[1] });
        return;
      }
      case "apps.open": {
        // Opening hands the file to another program, so this program must be able to read it.
        const p = norm(args[0]);
        await this.file(proc, p, "read");
        await this.os.open(p, { edit: !!args[1]?.edit });
        return;
      }
      case "request": {
        const r = args[0] ?? {};
        try {
          if (r.folder) {
            const f = norm(r.folder);
            await this.file(proc, f, r.write ? "write" : "read", f);
          } else if (r.net) await this.need(proc, { kind: "net", target: new URL(r.net).origin });
          else if (r.app) await this.need(proc, { kind: "app", target: norm(r.app) });
          else return false;
          return true;
        } catch {
          return false;
        }
      }
    }
    throw new Error(`no such call: ${method}`);
  }

  /** A dialog a program asked for says which program it's from, so it can't pass for the OS. */
  private titled(proc: Proc, title: unknown) {
    return title ? `${proc.title}: ${String(title)}` : proc.title;
  }

  /**
   * Show the file picker (Files, started to pick) over everything. Whatever the
   * user picks, the program asking may use from then on.
   */
  private async pick(proc: Proc, o: { mode?: string; name?: string; write?: boolean; start?: string }): Promise<string | null> {
    const mode = o.mode === "save" || o.mode === "folder" ? o.mode : "open";
    const write = mode === "save" || !!o.write;
    let start = this.os.home;
    if (typeof o.start === "string" && o.start) {
      const s = normalize(o.start, this.os.home);
      // Only start somewhere the program may already look, so it can't learn what's elsewhere.
      if (this.allowed(proc, { kind: "folder", target: s, access: "read" })) start = s;
    }
    const picker = await this.launch(`${this.os.systemDir()}/Files.ts`, {
      file: start, pick: { mode, name: o.name ? String(o.name) : undefined, write },
    }, { modal: true });
    const path = await new Promise<string | null>((resolve) => (picker.answer = resolve));
    if (!path) return null;
    await this.os.api.grant({ app: proc.path, kind: "folder", target: path, access: write ? "write" : "read" });
    await this.loadGrants();
    return path;
  }
}

/** The browser's own file chooser. Resolves to nothing if the user cancels. */
function chooseFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}
