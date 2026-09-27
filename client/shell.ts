/**
 * The OS shell: login, the menu bar, dialogs, themes and permissions. The
 * desktop and folder windows are programs (system/Desktop.ts and Files.ts).
 * It draws with exactly the same elements programs use.
 */
import { Api, discover, type Session } from "./api";
import { dirname, ext, isProgram, normalize, pretty } from "./paths";
import { Procs, type DialogOpts, type Os, type Proc } from "./procs";
import { MENU_H, newWinId, type BarMenu, type MenuBar, type Screen, type Win } from "./screen";
import { LINE_H, THEMES, fit, measure, palette, ui, wrap, type El, type Els, type MenuItem, type PointerEvent, type Theme } from "./ui";

const STORE = "box.session";
const THEME_STORE = "box.theme";
const SETTINGS = "~/.box/settings.json";

/** Which system program opens which kind of file. Everything else opens in the Editor. */
const OPENERS: Record<string, string> = { ".paint": "Paint.ts" };

/** A menu entry: label, what it does, and whether it's greyed out. */
type Action = [string, () => void, boolean?] | null;

/** Turn actions into menu items plus the function that runs the picked one. */
function actions(list: Action[]): { items: MenuItem[]; pick: (i: number) => void } {
  return {
    items: list.map((a) => (a ? { label: a[0], disabled: !!a[2] } : null)),
    pick: (i) => list[i]?.[1](),
  };
}

export class Shell implements Os {
  api!: Api;
  session: Session | null = null;
  procs = new Procs(this);
  me = "";
  home = "";
  theme: Theme = THEMES[0]!;

  private login = { address: "", password: "", error: "", busy: false };

  constructor(public screen: Screen) {
    screen.onResize = () => {
      this.procs.resized();
      this.screen.invalidate();
    };
    try {
      this.applyTheme(localStorage.getItem(THEME_STORE) ?? "", false);
    } catch {
      this.applyTheme("", false);
    }
    setInterval(() => this.session && this.screen.invalidate(), 15_000); // the clock
  }

  colors() {
    return palette(this.theme);
  }

  osOrigins() {
    return [location.origin, ...(this.session ? [new URL(this.session.api).origin] : [])];
  }

  async boot() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Session | null;
      if (saved?.api) return await this.start(saved);
    } catch {}
    this.showLogin();
  }

  // ---- Themes -------------------------------------------------------------------

  private applyTheme(name: string, save = true) {
    this.theme = THEMES.find((t) => t.name === name) ?? THEMES[0]!;
    this.screen.setTheme(this.theme);
    this.procs.themeChanged();
    try {
      localStorage.setItem(THEME_STORE, this.theme.name);
    } catch {}
    if (save && this.session) this.saveSettings({ theme: this.theme.name });
  }

  /** Settings live in a file in your home, so they follow you to every computer. */
  private async loadSettings() {
    try {
      const s = JSON.parse(await this.api.readText(normalize(SETTINGS, this.home)));
      if (s.theme && s.theme !== this.theme.name) this.applyTheme(s.theme, false);
    } catch {}
  }

  private async saveSettings(settings: Record<string, unknown>) {
    const path = normalize(SETTINGS, this.home);
    const body = JSON.stringify(settings, null, 2);
    try {
      await this.api.write(path, body);
    } catch {
      await this.api.mkdir(dirname(path)).catch(() => {});
      await this.api.write(path, body).catch(() => {});
    }
  }

  private themes() {
    const w = 200, h = THEMES.length * 22 + 12;
    const [x, y] = this.screen.center(w, h);
    this.screen.add({
      id: newWinId(), title: "Theme", x, y, w, h,
      render: () => THEMES.map((t, i) => {
        const ty = 8 + i * 22;
        const on = t.name === this.theme.name;
        return [
          ui.area(4, ty - 3, w - 8, 22, (e) => e.type === "down" && this.applyTheme(t.name), { hover: "hover" }),
          on && ui.rect(4, ty - 3, w - 8, 22, "accent"),
          ui.rect(10, ty, 36, 16, t.desk, t.line),
          ui.rect(18, ty + 3, 20, 10, t.panel, t.line),
          ui.rect(22, ty + 7, 8, 3, t.accent),
          ui.text(56, ty + 4, t.name, { color: on ? "accentText" : "text" }),
        ];
      }),
    });
  }

  // ---- Login -------------------------------------------------------------------

  private showLogin() {
    this.session = null;
    this.screen.background = () => this.loginEls();
    this.screen.menuBar = null;
    this.screen.invalidate();
    // A static build names its default box; otherwise ask the server this page came from.
    const preset = document.querySelector<HTMLMetaElement>('meta[name="box-domain"]')?.content;
    if (!this.login.address && preset) this.login.address = `@${preset}`;
    if (!this.login.address) {
      fetch("/.well-known/simplebox").then((r) => r.json()).then((info) => {
        if (!this.login.address) this.login.address = `@${info.domain}`;
        this.screen.invalidate();
      }).catch(() => {});
    }
  }

  /** Behind everything (and under the dock), whatever the desktop program draws. */
  private deskEls(): Els {
    const { W, H } = this.screen;
    const els: El[] = [ui.rect(0, 0, W, H, "desk")];
    for (let y = MENU_H + 11; y < H; y += 24) for (let x = 12; x < W; x += 24) els.push(ui.rect(x, y, 1, 1, "dots"));
    return els;
  }

  private loginEls(): Els {
    const { W, H } = this.screen;
    const w = Math.min(300, W - 20), h = 172;
    const x = Math.floor((W - w) / 2), y = Math.floor((H - h) / 2);
    const l = this.login;
    const go = (signup: boolean) => this.doLogin(signup);
    return [
      this.deskEls(),
      ui.rect(x + 2, y + h, w, 2, "shadow"),
      ui.rect(x + w, y + 2, 2, h, "shadow"),
      ui.rect(x, y, w, h, "panel", "line"),
      ui.text(x + 12, y + 11, "The Shared Computer", { font: "bold" }),
      ui.line(x + 1, y + 26, x + w - 2, y + 26, "accent"),
      ui.text(x + 12, y + 34, "Address", { color: "dim" }),
      ui.input(x + 12, y + 46, w - 24, 18, l.address, (v) => (l.address = v), {
        placeholder: "you@box.domain", onSubmit: () => go(false), key: "address",
      }),
      ui.text(x + 12, y + 70, "Password", { color: "dim" }),
      ui.input(x + 12, y + 82, w - 24, 18, l.password, (v) => (l.password = v), {
        password: true, onSubmit: () => go(false), key: "password",
      }),
      ui.text(x + 12, y + 106, l.busy ? "..." : l.error, { color: "red", w: w - 24 }),
      ui.button(x + w - 12 - 68, y + h - 32, 68, 20, "Log in", () => go(false), { primary: true }),
      ui.button(x + w - 12 - 68 - 76, y + h - 32, 68, 20, "Sign up", () => go(true)),
    ];
  }

  private async doLogin(signup: boolean) {
    const l = this.login;
    const [user, domain] = l.address.trim().toLowerCase().split("@");
    if (!user || !domain) {
      l.error = "Your address looks like name@box.domain";
      return this.screen.invalidate();
    }
    l.busy = true;
    this.screen.invalidate();
    try {
      const box = await discover(domain);
      const res = await fetch(`${box.api}/${signup ? "signup" : "login"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, password: l.password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      l.password = l.error = "";
      await this.start({ api: box.api, prefix: box.prefix, token: data.token, address: data.address, home: data.home });
    } catch (e) {
      l.error = (e as Error).message;
    } finally {
      l.busy = false;
      this.screen.invalidate();
    }
  }

  private async start(s: Session) {
    this.api = new Api(s);
    const me = await this.api.get("me"); // throws if the session is stale
    this.session = s;
    this.me = me.address;
    this.home = me.home;
    localStorage.setItem(STORE, JSON.stringify(s));
    await this.procs.loadGrants();
    this.screen.background = () => this.deskEls();
    this.screen.menuBar = () => this.bar();
    this.loadSettings();
    await this.startDesktop();
  }

  private async logout() {
    this.procs.killAll();
    for (const w of [...this.screen.wins]) this.screen.close(w);
    this.api.post("logout", {}).catch(() => {});
    localStorage.removeItem(STORE);
    this.showLogin();
  }

  // ---- Opening things ------------------------------------------------------------

  systemDir() {
    return `${this.session!.prefix}/system`;
  }

  /** The desktop is a program too (system/Desktop.ts), drawn behind the windows. */
  private async startDesktop() {
    const old = this.procs.desk;
    if (old) this.procs.kill(old);
    try {
      await this.procs.launch(`${this.systemDir()}/Desktop.ts`, { file: this.home }, { desk: true });
    } catch (e) {
      this.alert(`The desktop didn't start:\n\n${(e as Error).message}`);
    }
  }

  /**
   * Open a file the obvious way: folders in Files, programs run, everything else
   * in its editor. `edit` opens a program's source instead.
   */
  async open(path: string, opts: { edit?: boolean } = {}) {
    try {
      if (opts.edit) {
        await this.procs.launch(`${this.systemDir()}/Editor.ts`, { file: path });
        return;
      }
      const st = await this.api.stat(path);
      if (st.type === "dir") {
        const open = this.procs.list.find((p) => p.win && !p.answer && p.path === `${this.systemDir()}/Files.ts` && p.args.file === path);
        if (open) {
          this.screen.raise(open.win!);
          return this.screen.invalidate();
        }
        await this.procs.launch(`${this.systemDir()}/Files.ts`, { file: path });
        return;
      }
      if (isProgram(st.path)) {
        await this.procs.launch(path);
        return;
      }
      const opener = OPENERS[ext(st.path)] ?? "Editor.ts";
      await this.procs.launch(`${this.systemDir()}/${opener}`, { file: path });
    } catch (e) {
      this.alert((e as Error).message);
    }
  }

  // ---- Menus -------------------------------------------------------------------

  /**
   * The menu bar: the Box menu, then the menus of whatever is in front: a
   * program's own menus, or the desktop's when nothing is.
   */
  private bar(): MenuBar {
    const menu = (label: string, list: Action[], bold = false): BarMenu => ({ label, bold, ...actions(list) });
    const top = this.screen.focused;
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const menus: BarMenu[] = [
      menu("Box", [
        ["About this computer", () => this.about()],
        ["Theme...", () => this.themes()],
        ["Permissions...", () => this.permissions()],
        ["Restart desktop", () => this.startDesktop()],
        null,
        ["Log out", () => this.logout()],
      ]),
    ];
    const programMenus = (proc: Proc) => proc.menus.map((m, mi) => ({
      label: m.label,
      items: m.items,
      pick: (item: number) => proc.post({ type: "menu", menu: mi, item }),
    }));
    const proc = top ? this.procs.list.find((p) => p.win === top) : this.procs.desk;
    if (top?.modal) {
      // A dialog is up: nothing else until it's answered.
    } else if (proc && top) {
      menus.push(
        menu(proc.title, [
          ["Minimize", () => this.screen.minimize(top)],
          [`Permissions for ${proc.title}...`, () => this.permissionsOf(proc)],
          null,
          [`Quit ${proc.title}`, () => this.procs.kill(proc)],
        ], true),
        ...programMenus(proc),
      );
    } else if (proc) {
      menus.push(...programMenus(proc));
    } else if (top) {
      menus.push(menu(top.title || "Window", [["Minimize", () => this.screen.minimize(top)], ["Close window", () => this.screen.close(top)]], true));
    }
    return { menus, right: this.screen.portrait ? time : `${this.me}    ${time}` };
  }

  // ---- Windows of the OS itself ---------------------------------------------------

  private about() {
    this.alert(
      `The Shared Computer\n\nYou are ${this.me}.\nYour home is ${this.home}.\n` +
        `\nEvery program is a file, runs in its own sandbox, and has to ask before touching your files, other programs or web APIs.`,
    );
  }

  /** What programs may do: every program's permissions, or one program's. */
  private permissions(only?: Proc) {
    const { W, H } = this.screen;
    const [w, h] = this.screen.portrait ? [W - 4, H - MENU_H - 40] : [460, only ? 220 : 300];
    let scroll = 0;
    this.procs.loadGrants().then(() => this.screen.invalidate());
    const describe = (g: { kind: string; target: string; access: string }) =>
      g.kind === "folder" ? `${g.access === "write" ? "read+change" : "read"} ${pretty(g.target, this.home)}`
        : g.kind === "net" ? `API ${g.target}` : `message ${pretty(g.target, this.home)}`;
    const revoke = async (ids: number[]) => {
      for (const id of ids) await this.api.revoke(id);
      await this.procs.loadGrants();
      this.screen.invalidate();
    };
    const [x, y] = this.screen.center(w, h);
    this.screen.add({
      id: newWinId(), title: only ? `Permissions: ${only.title}` : "Permissions", x, y, w, h,
      render: () => {
        const els: El[] = [];
        let row = 8 - scroll;
        const grants = this.procs.grants.filter((g) => !only || g.app === only.path);
        if (only) {
          els.push(ui.text(8, row, fit(pretty(only.path, this.home), w - 16), { font: "bold" }));
          row += 16;
          const note = this.procs.trusted(only)
            ? "Part of the OS: it can use all your files without asking."
            : only.sessionFiles.size ? `It can use ${[...only.sessionFiles].map((f) => pretty(f, this.home)).join(", ")}, which it was opened with.` : "";
          if (note) {
            const lines = wrap(note, w - 16);
            els.push(ui.text(8, row, lines.join("\n"), { color: "dim" }));
            row += lines.length * LINE_H + 6;
          }
          if (!grants.length) els.push(ui.text(8, row, "It hasn't been given any other permissions.", { color: "dim", w: w - 16 }));
        } else if (!grants.length) els.push(ui.text(8, row, "No program has been given any permissions yet.", { color: "dim", w: w - 16 }));
        let app = "";
        for (const g of grants) {
          if (!only && g.app !== app) {
            app = g.app;
            if (row > 8 - scroll) row += 4;
            els.push(ui.text(8, row, fit(pretty(app, this.home), w - 16), { font: "bold" }));
            row += 16;
          }
          els.push(
            ui.text(18, row + 4, fit(describe(g), w - 90)),
            ui.button(w - 66, row, 58, 17, "Revoke", () => revoke([g.id]), { key: `revoke${g.id}` }),
          );
          row += 20;
        }
        if (only && grants.length > 1) {
          row += 4;
          els.push(ui.button(w - 96, row, 88, 18, "Revoke all", () => revoke(grants.map((g) => g.id)), { key: "all" }));
          row += 22;
        }
        const total = row + scroll;
        return [
          ui.area(0, 0, w, h, (e: PointerEvent) => {
            if (e.type !== "wheel") return;
            scroll = Math.max(0, Math.min(Math.max(0, total - h + 8), scroll + (e.dy ?? 0) * 20));
            this.screen.invalidate();
          }),
          ...els,
        ];
      },
    });
  }

  permissionsOf(proc: Proc) {
    this.permissions(proc);
  }

  /** A modal dialog. Resolves with the field values, or null if cancelled. */
  dialog(opts: DialogOpts): Promise<string[] | null> {
    return new Promise((resolve) => {
      const w = Math.min(320, this.screen.W - 10);
      const values = (opts.fields ?? []).map((f) => f.value ?? "");
      const lines = opts.text ? wrap(opts.text, w - 24) : [];
      let y = 12;
      const els: El[] = [];
      if (lines.length) {
        els.push(ui.text(12, y, lines.join("\n")));
        y += lines.length * LINE_H + 8;
      }
      const done = (v: string[] | null) => {
        resolve(v);
        this.screen.close(win);
      };
      (opts.fields ?? []).forEach((f, i) => {
        els.push(ui.text(12, y, f.label, { color: "dim" }));
        els.push(ui.input(12, y + 13, w - 24, 18, values[i]!, (v) => (values[i] = v), {
          password: f.password, onSubmit: () => done(values), key: `field${i}`,
        }));
        y += 38;
      });
      y += 4;
      const okW = Math.max(60, measure(opts.ok ?? "OK") + 20);
      els.push(ui.button(w - 12 - okW, y, okW, 20, opts.ok ?? "OK", () => done(values), { primary: true }));
      if (opts.cancel !== null) {
        const c = opts.cancel ?? "Cancel";
        const cw = Math.max(60, measure(c) + 20);
        els.push(ui.button(w - 12 - okW - 8 - cw, y, cw, 20, c, () => done(null)));
      }
      const h = Math.min(y + 32, this.screen.H - MENU_H - 24);
      const [x, wy] = this.screen.center(w, h);
      const win: Win = {
        id: newWinId(), title: opts.title, x, y: wy, w, h, modal: true,
        render: () => els,
        onKey: (k) => {
          if (k.key === "Escape") done(null);
          if (k.key === "Enter") done(values);
        },
        onClose: () => resolve(null),
      };
      this.screen.add(win);
      if (opts.fields?.length) this.screen.focusFirst(win);
    });
  }

  async ask(title: string, text: string, ok: string, cancel: string) {
    return (await this.dialog({ title, text, ok, cancel })) !== null;
  }

  async alert(text: string) {
    await this.dialog({ title: "", text, cancel: null });
  }
}
