// A folder shown as a grid of icons: what the desktop and Files are made of.
// Double-click opens things, right-click has menus, and files dropped on it
// from your computer are copied in.
//
// Programs can import this too: import { Folder } from "/<your box>/system/lib/folder.ts";

export const TEMPLATE = `// A program is just a file. Double-click it to run it.
export const title = "My Program";
// The sizes your window can be. The OS picks the biggest one that fits the screen.
export const sizes = [[240, 100]];

export default function main(sys) {
  let clicks = 0;
  function draw() {
    sys.ui.render([
      sys.ui.text(8, 8, "Hello, " + sys.me),
      sys.ui.button(8, 28, 64, 18, "Click", () => { clicks++; draw(); }),
      sys.ui.text(80, 32, clicks + " clicks", { color: "dim" }),
    ]);
  }
  draw();
}
`;

export const CELL_W = 72;
export const CELL_H = 44;

export type Item = { name: string; path: string; type: "file" | "dir" | "link"; size: number; mtime: number; target?: string };
/** A menu entry for sys.ui.setMenus, or null for a separator. */
export type Action = { label: string; onClick?: () => void; disabled?: boolean; hint?: string } | null;

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
export const join = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;
const ext = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i).toLowerCase() : "";
};
export const isProgram = (p: string) => /\.(js|ts)$/i.test(p);

/** Show paths in your home as ~/... */
export function pretty(p: string, home: string) {
  return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

type Options = {
  redraw(): void;
  /** Open something (default: the way the desktop would). */
  open?(item: Item): void;
  /** Behind the names, so they're readable on the desktop's dots. */
  labelBg?: string;
  /** Picking: no changing things, just choosing. */
  readonly?: boolean;
};

export class Folder {
  items: Item[] | null = null;
  error = "";
  scroll = 0;
  selected: string | null = null;
  private last = { name: "", t: 0 };
  private rows = 1;
  private h = 0;
  private cols = 1;

  constructor(private sys: any, public dir: string, private opts: Options) {}

  async load() {
    const dir = this.dir;
    try {
      const items: Item[] = await this.sys.fs.list(dir);
      if (dir !== this.dir) return;
      this.items = items;
      this.error = "";
      if (this.selected && !items.some((i) => i.name === this.selected)) this.selected = null;
    } catch (e) {
      if (dir !== this.dir) return;
      this.items = null;
      this.error = (e as Error).message;
    }
    this.opts.redraw();
  }

  cd(dir: string) {
    this.dir = dir;
    this.items = null;
    this.error = "";
    this.scroll = 0;
    this.selected = null;
    this.opts.redraw();
    return this.load();
  }

  get item(): Item | null {
    return this.items?.find((i) => i.name === this.selected) ?? null;
  }

  isFolder(i: Item) {
    return i.type === "dir" || (i.type === "link" && !ext(i.target ?? i.name));
  }

  icon(i: Item) {
    const { icons } = this.sys.ui;
    const name = i.type === "link" ? (i.target ?? i.name) : i.name;
    if (this.isFolder(i)) return icons.folder;
    if (isProgram(name)) return icons.program;
    if (ext(name) === ".paint") return icons.picture;
    return icons.file;
  }

  open(i: Item) {
    if (this.opts.open) this.opts.open(i);
    else this.attempt(() => this.sys.apps.open(i.path));
  }

  private select(name: string | null) {
    this.selected = name;
    this.opts.redraw();
  }

  /** Run something that might fail, telling the user if it does. */
  async attempt(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      await this.sys.ui.alert((e as Error).message);
    }
    await this.load();
  }

  // ---- What you can do -------------------------------------------------------------

  /** Things you can do to one item (its right-click menu). */
  itemActions(i: Item | null): Action[] {
    const off = !i;
    const ro = this.opts.readonly;
    return [
      { label: i && isProgram(i.name) ? "Run" : "Open", onClick: () => i && this.open(i), disabled: off, hint: "Enter" },
      { label: "Edit source", onClick: () => i && this.attempt(() => this.sys.apps.open(i.path, { edit: true })), disabled: off || this.isFolder(i!) || ro },
      null,
      { label: "Rename...", onClick: () => i && this.rename(i), disabled: off || ro, hint: "F2" },
      { label: "Share...", onClick: () => i && this.share(i.path), disabled: off || ro },
      null,
      { label: "Delete", onClick: () => i && this.remove(i), disabled: off || ro, hint: "Del" },
    ];
  }

  /** Things you can do in the folder itself. */
  folderActions(): Action[] {
    const ro = this.opts.readonly;
    return [
      { label: "New folder...", onClick: () => this.create("folder") },
      { label: "New text file...", onClick: () => this.create("text"), disabled: ro },
      { label: "New program...", onClick: () => this.create("program"), disabled: ro },
      { label: "New link...", onClick: () => this.create("link"), disabled: ro },
      null,
      { label: "Upload...", onClick: () => this.attempt(() => this.sys.fs.upload(this.dir)), disabled: ro },
      { label: "Share this folder...", onClick: () => this.share(this.dir), disabled: ro },
      { label: "Refresh", onClick: () => this.load() },
    ];
  }

  async create(kind: "folder" | "text" | "program" | "link") {
    const { sys } = this;
    if (kind === "link") {
      const v = await sys.ui.prompt({
        title: "New link",
        text: "A link points at another file or folder, even one that belongs to someone else or lives on another box.",
        fields: [{ label: "Name" }, { label: "Points to (a full path)", value: "/" }],
        ok: "Create",
      });
      if (!v?.[0] || !v[1]) return;
      return this.attempt(() => sys.fs.link(join(this.dir, v[0]), v[1]));
    }
    const names = { folder: "New Folder", text: "Untitled.txt", program: "Program.ts" };
    const v = await sys.ui.prompt({
      title: `New ${kind}`,
      fields: [{ label: `Name in ${pretty(this.dir, sys.home)}`, value: names[kind] }],
      ok: "Create",
    });
    const name = v?.[0]?.trim();
    if (!name) return;
    const path = join(this.dir, name);
    await this.attempt(async () => {
      if (kind === "folder") await sys.fs.mkdir(path);
      else {
        await sys.fs.write(path, kind === "program" ? TEMPLATE : "");
        await sys.apps.open(path, { edit: true });
      }
    });
    this.select(name);
  }

  async rename(i: Item) {
    const v = await this.sys.ui.prompt({ title: "Rename", fields: [{ label: "New name", value: i.name }], ok: "Rename" });
    const name = v?.[0]?.trim();
    if (!name || name === i.name) return;
    await this.attempt(() => this.sys.fs.rename(i.path, join(this.dir, name)));
    this.select(name);
  }

  async remove(i: Item) {
    const ok = await this.sys.ui.confirm("Delete", `Delete ${i.name}? This can't be undone. (Deleting a link leaves what it points to alone.)`, "Delete");
    if (ok) await this.attempt(() => this.sys.fs.remove(i.path));
  }

  async share(path: string) {
    const { sys } = this;
    try {
      const acl = await sys.fs.sharing(path);
      const v = await sys.ui.prompt({
        title: `Share ${basename(acl.path) || acl.path}`,
        text: "Names are like bob (on this box) or bob@other.box. Use * for everyone. You always have full access." +
          (acl.path !== path ? `\nThis is a link: sharing applies to ${pretty(acl.path, sys.home)}.` : ""),
        fields: [
          { label: "Who can read", value: acl.read.join(", ") },
          { label: "Who can read and change", value: acl.write.join(", ") },
        ],
        ok: "Save",
      });
      if (!v) return;
      const split = (s: string) => s.split(/[\s,]+/).filter(Boolean);
      await sys.fs.share(acl.path, { read: split(v[0]), write: split(v[1]) });
    } catch (e) {
      await sys.ui.alert((e as Error).message);
    }
  }

  private async dropped(files: { name: string; data: Uint8Array }[]) {
    if (this.opts.readonly) return;
    await this.attempt(async () => {
      for (const f of files) await this.sys.fs.write(join(this.dir, f.name), f.data);
    });
  }

  // ---- Keys ---------------------------------------------------------------------

  /** Arrows move the selection, Enter opens, Delete deletes, F2 renames. True if it was ours. */
  key(k: { key: string; ctrl: boolean; meta: boolean }): boolean {
    const items = this.items ?? [];
    if (!items.length) return false;
    const i = items.findIndex((it) => it.name === this.selected);
    const cur = items[i];
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -this.cols, ArrowDown: this.cols }[k.key];
    if (step) {
      const next = i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + step));
      this.select(items[next]!.name);
      this.reveal(next);
      return true;
    }
    if (!cur) return false;
    if (k.key === "Enter") this.open(cur);
    else if ((k.key === "Delete" || k.key === "Backspace") && !this.opts.readonly) this.remove(cur);
    else if (k.key === "F2" && !this.opts.readonly) this.rename(cur);
    else return false;
    return true;
  }

  private reveal(index: number) {
    const top = Math.floor(index / this.cols) * CELL_H;
    if (top < this.scroll) this.scroll = top;
    if (top + CELL_H > this.scroll + this.h - 6) this.scroll = top + CELL_H - this.h + 6;
    this.opts.redraw();
  }

  // ---- Drawing ------------------------------------------------------------------

  /** The grid, in the rectangle x,y,w,h of your window. */
  render(x: number, y: number, w: number, h: number) {
    const { ui } = this.sys;
    const cols = (this.cols = Math.max(1, Math.floor(w / CELL_W)));
    this.h = h;
    const pad = Math.floor((w - cols * CELL_W) / 2);
    const bg = this.folderActions();
    const els: unknown[] = [
      ui.area(x, y, w, h, (e: any) => {
        if (e.type === "down" || e.type === "menu") this.select(null);
        if (e.type === "wheel" && this.items) {
          this.rows = Math.ceil(this.items.length / cols);
          const max = Math.max(0, this.rows * CELL_H - h + 8);
          this.scroll = Math.max(0, Math.min(max, this.scroll + (e.dy ?? 0) * CELL_H));
          this.opts.redraw();
        }
        if (e.type === "drop") this.dropped(e.files);
      }, { key: `bg:${this.dir}`, menu: bg, onMenu: (n: number) => bg[n]?.onClick?.() }),
    ];
    if (!this.items) {
      els.push(ui.text(x + 8, y + 8, this.error || "Loading...", { color: this.error ? "red" : "dim", w: w - 16, bg: this.opts.labelBg }));
      return els;
    }
    if (!this.items.length) els.push(ui.text(x + 8, y + 8, "Nothing here yet.", { color: "dim", bg: this.opts.labelBg }));
    this.items.forEach((it, n) => {
      const cx = x + pad + (n % cols) * CELL_W;
      const cy = y + 6 + Math.floor(n / cols) * CELL_H - this.scroll;
      if (cy + CELL_H < y || cy > y + h) return;
      const selected = this.selected === it.name;
      const ix = cx + (CELL_W - 16) / 2;
      const menu = this.itemActions(it);
      els.push(
        ui.area(cx + 4, cy - 3, CELL_W - 8, CELL_H - 3, (e: any) => {
          if (e.type === "down") this.clicked(it);
          if (e.type === "menu") this.select(it.name);
          if (e.type === "drop") this.dropped(e.files);
        }, { key: `icon:${it.name}`, hover: "hover", menu, onMenu: (n: number) => menu[n]?.onClick?.() }),
        ui.bitmap(ix, cy, 16, 16, 16, 16, this.icon(it)),
        it.type === "link" && ui.bitmap(ix - 1, cy + 1, 16, 16, 16, 16, this.sys.ui.icons.link),
        ui.text(cx, cy + 21, ui.fit(it.name, CELL_W - 6), {
          w: CELL_W, align: "center",
          color: selected ? "accentText" : "text",
          bg: selected ? "accent" : this.opts.labelBg,
        }),
      );
    });
    return els;
  }

  private clicked(it: Item) {
    const now = Date.now();
    const double = this.last.name === it.name && now - this.last.t < 450;
    this.last = { name: it.name, t: double ? 0 : now };
    this.select(it.name);
    if (double) this.open(it);
  }
}
