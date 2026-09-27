/**
 * The screen: one low-resolution canvas, scaled up with big square pixels.
 * The desktop, menus, dialogs and every program's window are all drawn from
 * the same element lists (see ui.ts), and all input is routed back through them.
 */
import { Gfx } from "./gfx";
import { MONO_W, charAt, indexAt } from "./font";
import { LINE_H, fit, flatten, measure, wrap, type El, type Els, type Font, type KeyEvent, type MenuItem, type Theme } from "./ui";

export const MENU_H = 16;
/** Window chrome: 1px border + 15px title bar + 1px separator above the content; 1px border below. */
export const CHROME_TOP = 17;
export const CHROME_W = 2;
export const CHROME_H = 18;
/** The dock of open windows along the bottom. */
export const DOCK_H = 24;

const ITEM_H = 16;
const SEP_H = 7;
const LONG_PRESS = 500;

/** Where the pen ends up after drawing `s` (the gap after the last character). */
const pen = (s: string, font: Font) => (font === "mono" ? s.length * MONO_W : s ? measure(s, font) + 1 : 0);

const labelOf = (it: MenuItem) => (it === null ? "" : typeof it === "string" ? it : it.label);
const hintOf = (it: MenuItem) => (it && typeof it !== "string" ? (it.hint ?? "") : "");
const enabled = (it: MenuItem) => it !== null && (typeof it === "string" || !it.disabled);
const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
/** Characters of the same kind make up a "word" for double-clicking: letters and digits, spaces, or one symbol. */
const kindOf = (c: string) => (isWord(c) ? 0 : c === " " || c === "\t" ? 1 : 2);

/** The word around the character at `i`, as [start, end). */
function wordAt(v: string, i: number): [number, number] {
  if (i >= v.length || v[i] === "\n") i--; // past the end of a line: the last word on it
  if (i < 0 || v[i] === "\n") return [i + 1, i + 1];
  const k = kindOf(v[i]!);
  if (k === 2) return [i, i + 1];
  let s = i, e = i + 1;
  while (s > 0 && v[s - 1] !== "\n" && kindOf(v[s - 1]!) === k) s--;
  while (e < v.length && v[e] !== "\n" && kindOf(v[e]!) === k) e++;
  return [s, e];
}

export interface Win {
  id: number;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  render(): Els;
  onKey?(e: KeyEvent): void;
  onClose?(): void;
  modal?: boolean;
  minimized?: boolean;
  /** No title bar or border: the desktop. */
  frameless?: boolean;
  /** 16x16 RGBA, shown in the dock. */
  icon?: Uint8ClampedArray;
  /** More items for the window's right-click menu (title bar, border and dock). */
  menu?(): { items: MenuItem[]; pick: (i: number) => void };
}

/** A file dropped onto the screen, handed to the area under it. */
export type Dropped = { name: string; data: Uint8Array };

/** A menu in the bar at the top of the screen. `pick` gets the index of the chosen item. */
export type BarMenu = { label: string; bold?: boolean; items: MenuItem[]; pick: (i: number) => void };
export type MenuBar = { menus: BarMenu[]; right?: string };

type Hit = {
  x: number; y: number; w: number; h: number;
  win: Win | null;
  kind: "frame" | "title" | "close" | "min" | "el";
  el?: Hot;
  key?: string;
};

/** `anc` is where the selection started; the selection is anc..cur (either way round). */
type InputState = { value: string; app: string; cur: number; anc: number; sx: number; sy: number; follow: boolean };
type InputEl = Extract<El, { t: "input" }>;
type Hot = Extract<El, { t: "button" | "input" | "area" }>;

/** An open menu. `armed` once the pointer has been over it, so the release that opened it doesn't pick. */
type Popup = {
  x: number; y: number; w: number; h: number;
  items: MenuItem[]; pick: (i: number) => void;
  hover: number; armed: boolean; bar?: number;
};

let nextWinId = 1;
export const newWinId = () => nextWinId++;

export class Screen {
  W = 720;
  H = 480;
  /** The real screen, WxH, drawn off-page. */
  canvas = document.createElement("canvas");
  g = new Gfx(this.canvas);
  /** What's on the page: the screen scaled to fill the window (see present). */
  view = document.createElement("canvas");
  private big = document.createElement("canvas");
  private k = 1;
  wins: Win[] = [];
  background: () => Els = () => [];
  /** The desktop: a frameless window behind all the others, between the menu bar and the dock. */
  desk: Win | null = null;
  /** The desktop is in front (it was clicked), so it gets the keys and the menu bar. */
  private deskFocused = false;
  menuBar: (() => MenuBar) | null = null;
  onResize?: () => void;

  private hits: Hit[] = [];
  private inputs = new Map<string, InputState>();
  private active: { key: string; el: InputEl; win: Win | null } | null = null;
  private pressed: Hit | null = null;
  private pressedInside = false;
  private captured: Hit | null = null;
  /** Dragging out a selection; `word` is set after a double-click, to extend by whole words. */
  private selecting: { hit: Hit; word: [number, number] | null } | null = null;
  private drag: { win: Win; dx: number; dy: number } | null = null;
  private popup: Popup | null = null;
  private barSpots: { x: number; w: number }[] = [];
  private dockSpots: { x: number; w: number; win: Win }[] = [];
  private hover: string | null = null;
  private clicks = { key: "", t: 0, i: -1, n: 0 };
  private longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  private ta = document.createElement("textarea");
  private blink = true;
  private queued = false;
  private mirrored = "";

  constructor(root: HTMLElement) {
    root.append(this.view, this.ta);
    this.ta.className = "keys";
    this.ta.autocapitalize = "off";
    this.ta.spellcheck = false;
    this.ta.setAttribute("autocomplete", "off");
    this.fit();
    addEventListener("resize", () => this.fit());

    const c = this.view;
    c.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.down(...this.pos(e), e.pointerType, e.button, e.shiftKey);
    });
    c.addEventListener("pointermove", (e) => this.move(...this.pos(e), e.pointerType));
    c.addEventListener("pointerup", (e) => this.up(...this.pos(e), e.pointerType));
    c.addEventListener("pointercancel", (e) => this.up(...this.pos(e), e.pointerType));
    c.addEventListener("pointerleave", () => this.setHover(null));
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.wheel(...this.pos(e), Math.sign(e.deltaY));
    }, { passive: false });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("dragover", (e) => e.preventDefault());
    c.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length) this.drop(...this.pos(e), e.dataTransfer.files);
    });
    this.ta.addEventListener("keydown", (e) => this.key(e));
    // The key catcher holds the selected text, selected (see mirror), so the
    // browser's own copy, cut and paste work. Whatever it holds after an edit
    // replaces the selection: typed or pasted text, or nothing after a cut.
    this.ta.addEventListener("input", () => {
      const text = this.ta.value.replace(/\r/g, "");
      this.ta.value = this.mirrored = "";
      if (text || this.selectedText() !== null) this.insert(text);
    });
    this.ta.addEventListener("copy", (e) => this.clipboard(e, false));
    this.ta.addEventListener("cut", (e) => this.clipboard(e, true));
    setInterval(() => {
      if (this.active) {
        this.blink = !this.blink;
        this.invalidate();
      }
    }, 530);
  }

  /** Landscape screens are 720x480; portrait (phones) get a narrow 270x480 screen. */
  private fit() {
    const portrait = innerWidth < innerHeight;
    const [W, H] = portrait ? [270, 480] : [720, 480];
    if (W !== this.W || H !== this.H || this.canvas.width !== W) {
      this.W = this.canvas.width = W;
      this.H = this.canvas.height = H;
      this.g.ctx.imageSmoothingEnabled = false;
      for (const w of this.wins) this.clampWin(w);
      if (this.desk) this.fitDesk(this.desk);
      this.popup = null;
      this.onResize?.();
    }
    // Fill the window. Upscale by a whole number first (k, big square pixels), then
    // smoothly scale that down to the exact size ("sharp bilinear"): pixels stay the
    // same size and only their edges blend by at most one device pixel. When the fit
    // happens to be a whole number this is exact.
    const dpr = devicePixelRatio || 1;
    const s = Math.min(innerWidth / W, innerHeight / H);
    const vw = Math.round(W * s * dpr);
    const vh = Math.round(H * s * dpr);
    this.k = Math.max(1, Math.ceil(vw / W - 0.01));
    this.big.width = W * this.k;
    this.big.height = H * this.k;
    this.view.width = vw;
    this.view.height = vh;
    this.view.style.width = `${vw / dpr}px`;
    this.view.style.height = `${vh / dpr}px`;
    this.invalidate();
  }

  setTheme(theme: Theme) {
    this.g.setTheme(theme);
    document.body.style.background = theme.shadow;
    this.invalidate();
  }

  get portrait() {
    return this.W < this.H;
  }

  private pos(e: MouseEvent): [number, number] {
    const r = this.view.getBoundingClientRect();
    return [
      Math.floor(((e.clientX - r.left) / r.width) * this.W),
      Math.floor(((e.clientY - r.top) / r.height) * this.H),
    ];
  }

  // ---- Windows -----------------------------------------------------------------

  /** Where a window's content starts on the screen. */
  origin(win: Win): [number, number] {
    return win.frameless ? [win.x, win.y] : [win.x + 1, win.y + CHROME_TOP];
  }

  fitDesk(win: Win) {
    Object.assign(win, { x: 0, y: MENU_H, w: this.W, h: this.H - MENU_H - DOCK_H, frameless: true });
  }

  /** Put the desktop in front of the menu bar and keys (windows stay where they are). */
  focusDesk() {
    this.deskFocused = true;
    if (this.active?.win) this.active = null;
    this.invalidate();
  }

  add(win: Win) {
    this.deskFocused = false;
    this.clampWin(win);
    this.wins.push(win);
    this.invalidate();
    return win;
  }

  close(win: Win) {
    const i = this.wins.indexOf(win);
    if (i < 0) return;
    this.wins.splice(i, 1);
    for (const k of [...this.inputs.keys()]) if (k.startsWith(`${win.id}:`)) this.inputs.delete(k);
    if (this.active?.win === win) this.active = null;
    win.onClose?.();
    this.invalidate();
  }

  /** Bring a window to the front (restoring it if it was minimized). */
  raise(win: Win) {
    if (win === this.desk) return this.focusDesk();
    this.deskFocused = false;
    win.minimized = false;
    const i = this.wins.indexOf(win);
    if (i >= 0 && i !== this.wins.length - 1) {
      this.wins.splice(i, 1);
      this.wins.push(win);
    }
  }

  minimize(win: Win) {
    if (win.modal) return;
    win.minimized = true;
    if (this.active?.win === win) this.active = null;
    this.invalidate();
  }

  /** The front window that isn't minimized (null when the desktop is in front). */
  get focused(): Win | null {
    if (this.deskFocused) return null;
    for (let i = this.wins.length - 1; i >= 0; i--) if (!this.wins[i]!.minimized) return this.wins[i]!;
    return null;
  }

  /** Where the next window should go, cascading from the top-left. */
  place(w: number, h: number): [number, number] {
    if (this.portrait) return [Math.max(0, Math.floor((this.W - w - CHROME_W) / 2)), MENU_H + 2];
    const n = this.wins.length % 8;
    const x = Math.min(24 + n * 16, this.W - w - CHROME_W - 2);
    const y = Math.min(MENU_H + 12 + n * 16, this.H - DOCK_H - h - CHROME_H - 2);
    return [Math.max(0, x), Math.max(MENU_H, y)];
  }

  center(w: number, h: number): [number, number] {
    return [
      Math.max(0, Math.floor((this.W - w - CHROME_W) / 2)),
      Math.max(MENU_H, Math.floor((this.H - DOCK_H - h - CHROME_H) / 2)),
    ];
  }

  private clampWin(w: Win) {
    w.x = Math.max(-(w.w - 40), Math.min(w.x, this.W - 40));
    w.y = Math.max(MENU_H, Math.min(w.y, this.H - DOCK_H - 16));
  }

  // ---- Menus ---------------------------------------------------------------------

  /** Show a menu at x,y (e.g. where the user right-clicked). */
  openMenu(x: number, y: number, items: MenuItem[], pick: (i: number) => void, bar?: number) {
    const w = Math.max(96, ...items.map((it) => measure(labelOf(it)) + (hintOf(it) ? measure(hintOf(it)) + 20 : 0) + 30));
    const h = items.reduce((n, it) => n + (it ? ITEM_H : SEP_H), 6);
    const px = Math.max(0, Math.min(x + 1, this.W - w - 3));
    const py = y + 1 + h > this.H - 3 && y - h > MENU_H ? y - h : Math.max(MENU_H, Math.min(y + 1, this.H - h - 3));
    this.popup = { x: px, y: bar === undefined ? py : y, w, h, items, pick, hover: -1, armed: false, bar };
    this.setHover(null);
    this.invalidate();
  }

  closeMenu() {
    if (!this.popup) return;
    this.popup = null;
    this.invalidate();
  }

  private openBar(i: number) {
    const m = this.menuBar?.().menus[i];
    const spot = this.barSpots[i];
    if (m && spot) this.openMenu(spot.x, MENU_H - 1, m.items, m.pick, i);
  }

  private barAt(x: number, y: number): number | null {
    if (!this.menuBar || y < 0 || y >= MENU_H) return null;
    if (this.queued) this.paint();
    const i = this.barSpots.findIndex((s) => x >= s.x && x < s.x + s.w);
    return i < 0 ? null : i;
  }

  /** The enabled item under x,y in the open menu, or -1. */
  private itemAt(x: number, y: number): number {
    const p = this.popup;
    if (!p || x < p.x + 1 || x >= p.x + p.w - 1) return -1;
    let iy = p.y + 3;
    for (let i = 0; i < p.items.length; i++) {
      const it = p.items[i]!;
      const ih = it ? ITEM_H : SEP_H;
      if (y >= iy && y < iy + ih) return enabled(it) ? i : -1;
      iy += ih;
    }
    return -1;
  }

  private insideMenu(x: number, y: number) {
    const p = this.popup;
    return !!p && x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h;
  }

  private stepMenu(dir: number) {
    const p = this.popup!;
    const n = p.items.length;
    let i = p.hover;
    for (let tries = 0; tries < n; tries++) {
      i = (i + dir + n) % n;
      if (enabled(p.items[i]!)) break;
    }
    p.hover = i;
    this.invalidate();
  }

  private menuKey(e: KeyboardEvent) {
    const p = this.popup!;
    const bars = this.menuBar?.().menus.length ?? 0;
    if (e.key === "Escape") this.closeMenu();
    else if (e.key === "ArrowDown") this.stepMenu(1);
    else if (e.key === "ArrowUp") this.stepMenu(-1);
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && p.bar !== undefined && bars) {
      this.openBar((p.bar + (e.key === "ArrowLeft" ? bars - 1 : 1)) % bars);
    } else if (e.key === "Enter" && p.hover >= 0) {
      this.closeMenu();
      p.pick(p.hover);
    }
  }

  // ---- Painting ----------------------------------------------------------------

  invalidate() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.paint();
    });
  }

  private seenActive = false;

  paint() {
    const g = this.g;
    this.queued = false;
    g.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.hits = [];
    this.seenActive = false;
    const full = { x: 0, y: 0, w: this.W, h: this.H };
    this.paintEls(flatten(this.background()), null, 0, 0, full);
    if (this.desk) this.paintContent(this.desk);
    const focused = this.focused;
    for (const win of this.wins) if (!win.minimized) this.paintWin(win, win === focused);
    this.paintDock();
    this.paintBar();
    this.paintMenu();
    if (this.active && !this.seenActive) this.active = null;
    this.mirror();
    this.present();
  }

  private mirror() {
    const text = this.selectedText() ?? "";
    if (text === this.mirrored && this.ta.value === text) return;
    this.mirrored = this.ta.value = text;
    if (text) this.ta.select();
  }

  private present() {
    const b = this.big.getContext("2d")!;
    b.imageSmoothingEnabled = false;
    b.drawImage(this.canvas, 0, 0, this.big.width, this.big.height);
    const v = this.view.getContext("2d")!;
    v.imageSmoothingEnabled = true;
    v.imageSmoothingQuality = "high";
    v.drawImage(this.big, 0, 0, this.view.width, this.view.height);
  }

  private shadow(x: number, y: number, w: number, h: number) {
    this.g.dither(x + 2, y + h, w, 2, "shadow");
    this.g.dither(x + w, y + 2, 2, h - 2, "shadow");
  }

  private paintWin(win: Win, focused: boolean) {
    const g = this.g;
    const { x, y } = win;
    const W = win.w + CHROME_W;
    const H = win.h + CHROME_H;
    this.shadow(x, y, W, H);
    g.round(x, y, W, H, "panel", "line");
    g.fill(x + 1, y + 16, W - 2, 1, focused ? "accent" : "line");
    const title = fit(win.title, W - 44);
    g.text(x + Math.floor((W - measure(title)) / 2), y + 4, title, focused ? "text" : "dim");

    // Minimize and close, top right.
    const bx = x + W - 17, mx = bx - 15, by = y + 1;
    const box = (kind: "close" | "min", bx: number, draw: (c: string) => void) => {
      const hot = this.hover === `${kind}:${win.id}`;
      const down = this.pressed?.kind === kind && this.pressed.win === win && this.pressedInside;
      if (hot || down) g.round(bx + 2, by + 1, 13, 13, down ? "accent" : "hover");
      draw(down ? "accentText" : hot ? "accent" : "dim");
    };
    if (!win.modal) box("min", mx, (c) => g.fill(mx + 6, by + 7, 5, 1, c));
    box("close", bx, (c) => {
      g.line(bx + 6, by + 5, bx + 10, by + 9, c);
      g.line(bx + 10, by + 5, bx + 6, by + 9, c);
    });

    this.hits.push({ x, y, w: W, h: H, win, kind: "frame" });
    this.hits.push({ x, y, w: W, h: 16, win, kind: "title" });
    if (!win.modal) this.hits.push({ x: mx + 1, y: by, w: 15, h: 15, win, kind: "min" });
    this.hits.push({ x: bx + 1, y: by, w: 16, h: 15, win, kind: "close" });

    this.paintContent(win);
  }

  private paintContent(win: Win) {
    const [cx, cy] = this.origin(win);
    const clip = { x: cx, y: cy, w: win.w, h: win.h };
    this.g.within(cx, cy, win.w, win.h, () => this.paintEls(flatten(win.render()), win, cx, cy, clip));
  }

  private paintBar() {
    this.barSpots = [];
    if (!this.menuBar) return;
    const g = this.g;
    const bar = this.menuBar();
    g.fill(0, 0, this.W, MENU_H - 1, "panel");
    g.fill(0, MENU_H - 1, this.W, 1, "line");
    let x = 4;
    bar.menus.forEach((m, i) => {
      const font: Font = m.bold ? "bold" : "ui";
      const w = measure(m.label, font) + 14;
      const open = this.popup?.bar === i;
      if (open) g.fill(x, 0, w, MENU_H - 1, "accent");
      else if (this.hover === `bar:${i}`) g.fill(x, 0, w, MENU_H - 1, "hover");
      g.text(x + 7, 3, m.label, open ? "accentText" : "text", font);
      this.barSpots.push({ x, w });
      x += w;
    });
    if (bar.right) g.text(this.W - measure(bar.right) - 8, 3, bar.right, "text");
  }

  /** The windows in the dock, in the order they were opened. Dialogs don't get one. */
  private docked() {
    return this.wins.filter((w) => !w.modal).sort((a, b) => a.id - b.id);
  }

  private paintDock() {
    this.dockSpots = [];
    const wins = this.docked();
    if (!wins.length) return;
    const g = this.g;
    // Shrink labels until everything fits.
    let max = 90;
    const widths = () => wins.map((w) => 30 + (max > 0 ? measure(fit(w.title, max)) : -6));
    let ws = widths();
    while (ws.reduce((a, b) => a + b + 2, 6) > this.W - 8 && max > 0) {
      max -= 10;
      ws = widths();
    }
    const total = ws.reduce((a, b) => a + b + 2, 6);
    const x0 = Math.floor((this.W - total) / 2), y0 = this.H - DOCK_H;
    g.dither(x0 + total, y0 + 2, 2, DOCK_H, "shadow");
    g.round(x0, y0, total, DOCK_H + 2, "panel", "line");
    const focused = this.focused;
    let x = x0 + 4;
    wins.forEach((win, i) => {
      const w = ws[i]!;
      const on = win === focused;
      const hot = this.hover === `dock:${win.id}`;
      if (on || hot) g.round(x, y0 + 3, w, DOCK_H - 5, on ? "field" : "hover", on ? "line" : undefined);
      if (on) g.fill(x + 3, y0 + DOCK_H - 4, w - 6, 1, "accent");
      if (win.icon) g.bitmap(x + 5, y0 + 4, 16, 16, 16, 16, win.icon);
      else g.round(x + 7, y0 + 6, 12, 11, "field", "line");
      if (max > 0) g.text(x + 25, y0 + 8, fit(win.title, max), win.minimized ? "dim" : "text");
      this.dockSpots.push({ x, w, win });
      x += w + 2;
    });
  }

  private dockAt(x: number, y: number): Win | null {
    if (y < this.H - DOCK_H + 2) return null;
    if (this.queued) this.paint();
    return this.dockSpots.find((s) => x >= s.x && x < s.x + s.w)?.win ?? null;
  }

  /** Click in the dock: bring a window forward, or minimize it if it's already in front. */
  private dockClick(win: Win) {
    if (win === this.focused) this.minimize(win);
    else this.raise(win);
    this.invalidate();
  }

  private paintMenu() {
    const p = this.popup;
    if (!p) return;
    const g = this.g;
    this.shadow(p.x, p.y, p.w, p.h);
    g.round(p.x, p.y, p.w, p.h, "panel", "line");
    let iy = p.y + 3;
    p.items.forEach((it, i) => {
      if (!it) {
        g.dots(p.x + 5, iy + 3, p.w - 10, "dim");
        iy += SEP_H;
        return;
      }
      const on = i === p.hover;
      if (on) g.round(p.x + 2, iy, p.w - 4, ITEM_H, "accent");
      g.text(p.x + 10, iy + 4, labelOf(it), !enabled(it) ? "dim" : on ? "accentText" : "text");
      const hint = hintOf(it);
      if (hint) g.text(p.x + p.w - 10 - measure(hint), iy + 4, hint, on ? "accentText" : "dim");
      iy += ITEM_H;
    });
  }

  private paintEls(els: El[], win: Win | null, ox: number, oy: number, clip: { x: number; y: number; w: number; h: number }) {
    const count: Record<string, number> = {};
    for (const el of els) {
      if (el.id === undefined) el.id = el.key ?? `${el.t}${(count[el.t] = (count[el.t] ?? 0) + 1)}`;
      const key = `${win?.id ?? 0}:${el.id}`;
      this.drawEl(el, win, key);
      if (el.t === "button" || el.t === "input" || el.t === "area") {
        const x0 = Math.max(ox + el.x, clip.x), y0 = Math.max(oy + el.y, clip.y);
        const x1 = Math.min(ox + el.x + el.w, clip.x + clip.w), y1 = Math.min(oy + el.y + el.h, clip.y + clip.h);
        if (x1 > x0 && y1 > y0) {
          this.hits.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, win, kind: "el", el, key });
        }
      }
    }
  }

  private drawEl(el: El, win: Win | null, key: string) {
    const g = this.g;
    switch (el.t) {
      case "rect":
        if (el.fill) g.fill(el.x, el.y, el.w, el.h, el.fill);
        if (el.stroke) g.stroke(el.x, el.y, el.w, el.h, el.stroke);
        break;
      case "line":
        g.line(el.x1, el.y1, el.x2, el.y2, el.color);
        break;
      case "text": {
        const font = el.font ?? "ui";
        const lines = el.w ? wrap(el.text, el.w, font) : el.text.split("\n");
        lines.forEach((line, i) => {
          const lw = pen(line, font) - 1;
          const x = !el.w || !el.align || el.align === "left" ? el.x
            : el.align === "center" ? el.x + Math.floor((el.w - lw) / 2) : el.x + el.w - lw;
          if (el.bg) g.fill(x - 2, el.y + i * LINE_H - 1, lw + 4, LINE_H, el.bg);
          g.text(x, el.y + i * LINE_H, line, el.color, font);
        });
        break;
      }
      case "button": {
        const down = this.pressed?.el === el && this.pressedInside;
        const hot = !el.disabled && this.hover === key;
        const edge = el.disabled ? "dim" : "line";
        const primary = el.primary && !el.disabled;
        g.round(el.x, el.y, el.w, el.h, down || primary ? "accent" : hot ? "hover" : "field", edge);
        // A thicker bottom edge makes it look raised, until it's pressed.
        if (!down) g.fill(el.x + 1, el.y + el.h - 2, el.w - 2, 1, edge);
        if (primary && hot && !down) g.stroke(el.x + 1, el.y + 1, el.w - 2, el.h - 3, "accentText");
        const label = fit(el.text, el.w - 8);
        g.text(el.x + Math.floor((el.w - measure(label)) / 2), el.y + Math.floor((el.h - 9) / 2) + (down ? 1 : 0), label,
          el.disabled ? "dim" : down || primary ? "accentText" : "text");
        break;
      }
      case "input":
        this.drawInput(el, key);
        break;
      case "bitmap":
        g.bitmap(el.x, el.y, el.w, el.h, el.pw, el.ph, el.pixels);
        break;
      case "area":
        if (el.hover && this.hover === key) g.round(el.x, el.y, el.w, el.h, el.hover);
        break;
    }
  }

  // ---- Text inputs -------------------------------------------------------------

  private state(key: string, el: InputEl): InputState {
    let st = this.inputs.get(key);
    const value = el.value ?? "";
    if (!st) {
      st = { value, app: value, cur: value.length, anc: value.length, sx: 0, sy: 0, follow: true };
      this.inputs.set(key, st);
    } else if (value !== st.app) {
      // The program changed the value itself. A cursor at the end stays at the end
      // (so a log scrolls along as it grows).
      const atEnd = st.cur === st.value.length && st.anc === st.cur;
      st.app = st.value = value;
      st.cur = st.anc = atEnd ? value.length : Math.min(st.cur, value.length);
      st.follow = true;
    }
    return st;
  }

  private metrics(el: InputEl) {
    const rows = el.multiline ? Math.max(1, Math.floor((el.h - 4) / LINE_H)) : 1;
    const top = el.multiline ? el.y + 3 : el.y + Math.floor((el.h - 8) / 2);
    return { rows, top, font: el.font ?? "ui", inner: el.w - 6 };
  }

  private shown(el: InputEl, st: InputState) {
    return el.password ? "*".repeat(st.value.length) : st.value;
  }

  private drawInput(el: InputEl, key: string) {
    const g = this.g;
    const st = this.state(key, el);
    const focused = this.active?.key === key;
    if (focused) {
      this.active!.el = el;
      this.seenActive = true;
    }
    g.round(el.x, el.y, el.w, el.h, "field", focused && !el.readonly ? "accent" : "line");
    const { rows, top, font, inner } = this.metrics(el);
    const lines = this.shown(el, st).split("\n");
    const { line, col } = lineCol(st.value, st.cur);
    if (st.follow) {
      st.follow = false;
      if (line < st.sy) st.sy = line;
      if (line >= st.sy + rows) st.sy = line - rows + 1;
      const text = lines[line] ?? "";
      if (col < st.sx) st.sx = Math.max(0, col - 4);
      if (pen(text.slice(0, col), font) <= inner - 2) st.sx = 0; // it fits: show the line from the start
      while (st.sx < col && pen(text.slice(st.sx, col), font) > inner - 2) st.sx++;
    }
    const [a, b] = [Math.min(st.anc, st.cur), Math.max(st.anc, st.cur)];
    const x0 = el.x + 3;
    g.clip(el.x + 1, el.y + 1, el.w - 2, el.h - 2, () => {
      if (!st.value && el.placeholder && !focused) g.text(x0, top, el.placeholder, "dim", font);
      let start = lines.slice(0, st.sy).reduce((n, l) => n + l.length + 1, 0);
      for (let r = 0; r < rows && st.sy + r < lines.length; r++) {
        const text = lines[st.sy + r]!;
        const y = top + r * LINE_H;
        const visible = text.slice(st.sx);
        g.text(x0, y, visible, "text", font);
        const end = start + text.length;
        if (focused && a !== b && a <= end && b > start) {
          // Highlight the selected part of this line (and a little more if the line break is selected too).
          const c0 = Math.max(a - start, st.sx), c1 = Math.max(Math.min(b, end) - start, st.sx);
          const sx0 = x0 - 1 + pen(text.slice(st.sx, c0), font);
          const sx1 = x0 - 1 + pen(text.slice(st.sx, c1), font) + (b > end ? 4 : 0);
          if (sx1 > sx0) {
            g.fill(sx0, y - 1, sx1 - sx0, 11, "accent");
            g.clip(sx0, y - 1, sx1 - sx0, 11, () => g.text(x0, y, visible, "accentText", font));
          }
        }
        start = end + 1;
      }
      if (focused && this.blink && !el.readonly && a === b) {
        const cx = el.x + 2 + pen((lines[line] ?? "").slice(st.sx, col), font);
        g.fill(cx, top - 1 + (line - st.sy) * LINE_H, 1, 11, "text");
      }
    });
  }

  /**
   * The text position under a point in an input: the gap between characters
   * nearest to it, or with `char`, the character it's on.
   */
  private indexAt(hit: Hit, px: number, py: number, char = false): number {
    const el = hit.el as InputEl;
    const st = this.state(hit.key!, el);
    const { top, font } = this.metrics(el);
    const [ox, oy] = hit.win ? this.origin(hit.win) : [0, 0];
    const lx = px - ox - el.x - 3;
    const ly = py - oy - top;
    const lines = this.shown(el, st).split("\n");
    const line = Math.min(lines.length - 1, Math.max(0, st.sy + (el.multiline ? Math.floor(ly / LINE_H) : 0)));
    const col = st.sx + (char ? charAt : indexAt)(lines[line]!.slice(st.sx), lx, font);
    return lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + Math.min(col, lines[line]!.length);
  }

  /** Click: put the cursor there. Shift-click extends; double-click selects a word, triple-click a line. */
  private focusInput(hit: Hit, px: number, py: number, shift: boolean) {
    const el = hit.el as InputEl;
    const st = this.state(hit.key!, el);
    const wasActive = this.active?.key === hit.key;
    this.active = { key: hit.key!, el, win: hit.win };
    const i = this.indexAt(hit, px, py);
    const now = Date.now();
    const c = this.clicks;
    c.n = c.key === hit.key && now - c.t < 400 && Math.abs(i - c.i) <= 1 ? c.n + 1 : 1;
    Object.assign(c, { key: hit.key, t: now, i });
    const v = st.value;
    if (c.n >= 2 && el.password) {
      st.anc = 0;
      st.cur = v.length;
    } else if (c.n === 2) {
      const word = wordAt(v, this.indexAt(hit, px, py, true));
      [st.anc, st.cur] = word;
      this.selecting = { hit, word };
    } else if (c.n >= 3) {
      st.anc = el.multiline ? v.lastIndexOf("\n", i - 1) + 1 : 0;
      const nl = v.indexOf("\n", i);
      st.cur = el.multiline && nl >= 0 ? nl : v.length;
    } else {
      st.cur = i;
      if (!shift || !wasActive) st.anc = i;
      this.selecting = { hit, word: null };
    }
    this.blink = true;
    this.ta.focus({ preventScroll: true });
  }

  private edit(st: InputState, value: string, cur: number) {
    const el = this.active!.el;
    if (el.readonly) return;
    st.value = value;
    st.cur = st.anc = cur;
    st.follow = true;
    el.on?.("change", value);
  }

  private selection(): { st: InputState; a: number; b: number } | null {
    if (!this.active) return null;
    const st = this.inputs.get(this.active.key);
    if (!st) return null;
    return { st, a: Math.min(st.anc, st.cur), b: Math.max(st.anc, st.cur) };
  }

  /** Replace the selection (or insert at the cursor) with `text`. */
  private insert(text: string) {
    const s = this.selection();
    if (!s) return;
    if (!this.active!.el.multiline) text = text.replace(/\n/g, " ");
    this.edit(s.st, s.st.value.slice(0, s.a) + text + s.st.value.slice(s.b), s.a + text.length);
    this.blink = true;
    this.invalidate();
  }

  /** The selected text, if there is any and it may be copied. */
  private selectedText(): string | null {
    const s = this.selection();
    if (!s || s.a === s.b) return null;
    return s.st.value.slice(s.a, s.b);
  }

  private clipboard(e: ClipboardEvent, cut: boolean) {
    const text = this.selectedText();
    if (text === null) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", text);
    if (cut) this.insert("");
  }

  private selectAll() {
    const s = this.selection();
    if (!s) return;
    s.st.anc = 0;
    s.st.cur = s.st.value.length;
    this.invalidate();
  }

  /** Right-click in a text input. */
  private inputMenu(hit: Hit, x: number, y: number) {
    const el = hit.el as InputEl;
    const st = this.state(hit.key!, el);
    const i = this.indexAt(hit, x, y);
    const [a, b] = [Math.min(st.anc, st.cur), Math.max(st.anc, st.cur)];
    this.active = { key: hit.key!, el, win: hit.win };
    if (i < a || i > b || a === b) st.cur = st.anc = i; // keep the selection if clicking inside it
    this.ta.focus({ preventScroll: true });
    const has = a !== b && i >= a && i <= b;
    const copy = () => {
      const t = this.selectedText();
      if (t !== null) navigator.clipboard?.writeText(t).catch(() => {});
    };
    this.openMenu(x, y, [
      { label: "Cut", disabled: !has || !!el.readonly }, { label: "Copy", disabled: !has },
      { label: "Paste", disabled: !!el.readonly }, null, "Select all",
    ], (pick) => {
      if (pick === 0) { copy(); this.insert(""); }
      if (pick === 1) copy();
      if (pick === 2) navigator.clipboard?.readText().then((t) => this.insert(t.replace(/\r/g, ""))).catch(() => {});
      if (pick === 4) this.selectAll();
      this.ta.focus({ preventScroll: true });
    });
  }

  /** Put the cursor in a window's first text input, with its text selected. */
  focusFirst(win: Win) {
    this.paint();
    const h = this.hits.find((h) => h.win === win && h.el?.t === "input");
    if (!h) return;
    const el = h.el as InputEl;
    const st = this.state(h.key!, el);
    this.active = { key: h.key!, el, win };
    st.anc = 0;
    st.cur = st.value.length;
    this.ta.focus({ preventScroll: true });
    this.invalidate();
  }

  /** Put the cursor at the end of a window's input with this `key` (for programs). */
  focusKey(win: Win, key: string) {
    if (this.queued) this.paint();
    const h = this.hits.find((h) => h.win === win && h.key === `${win.id}:${key}` && h.el?.t === "input");
    if (!h || (this.focused !== win && this.desk !== win)) return;
    const st = this.state(h.key!, h.el as InputEl);
    this.active = { key: h.key!, el: h.el as InputEl, win };
    st.cur = st.anc = st.value.length;
    st.follow = true;
    this.ta.focus({ preventScroll: true });
    this.invalidate();
  }

  /**
   * Move focus to the next text input in the same window (Tab in forms), selecting
   * its text. False if there isn't another one you can type in.
   */
  private nextInput(): boolean {
    const a = this.active!;
    const inputs = this.hits.filter((h) => h.win === a.win && h.el?.t === "input" && (h.key === a.key || !(h.el as InputEl).readonly));
    if (inputs.length < 2) return false;
    const i = inputs.findIndex((h) => h.key === a.key);
    const next = inputs[(i + 1) % inputs.length];
    if (next) {
      const st = this.state(next.key!, next.el as InputEl);
      this.active = { key: next.key!, el: next.el as InputEl, win: next.win };
      st.anc = 0;
      st.cur = st.value.length;
    }
    return true;
  }

  private editKey(e: KeyboardEvent): boolean {
    const a = this.active!;
    const st = this.inputs.get(a.key)!;
    const v = st.value;
    const { line, col } = lineCol(v, st.cur);
    const lines = v.split("\n");
    const lineStart = st.cur - col;
    const [s0, s1] = [Math.min(st.anc, st.cur), Math.max(st.anc, st.cur)];
    const hasSel = s0 !== s1;
    const ctrl = e.ctrlKey || e.metaKey;
    const move = (cur: number) => {
      st.cur = Math.max(0, Math.min(v.length, cur));
      if (!e.shiftKey) st.anc = st.cur;
      st.follow = true;
    };
    const toLine = (l: number) => {
      l = Math.max(0, Math.min(lines.length - 1, l));
      move(lines.slice(0, l).reduce((n, s) => n + s.length + 1, 0) + Math.min(col, lines[l]!.length));
    };
    const wordLeft = () => {
      let i = st.cur;
      while (i > 0 && !isWord(v[i - 1])) i--;
      while (i > 0 && isWord(v[i - 1])) i--;
      return i;
    };
    const wordRight = () => {
      let i = st.cur;
      while (i < v.length && !isWord(v[i])) i++;
      while (i < v.length && isWord(v[i])) i++;
      return i;
    };
    const cut = (from: number, to: number) => this.edit(st, v.slice(0, from) + v.slice(to), from);
    const rows = this.metrics(a.el).rows;
    switch (e.key) {
      case "ArrowLeft": move(hasSel && !e.shiftKey ? s0 : ctrl ? wordLeft() : st.cur - 1); break;
      case "ArrowRight": move(hasSel && !e.shiftKey ? s1 : ctrl ? wordRight() : st.cur + 1); break;
      case "ArrowUp": if (!a.el.multiline) return false; toLine(line - 1); break;
      case "ArrowDown": if (!a.el.multiline) return false; toLine(line + 1); break;
      case "PageUp": toLine(line - rows); break;
      case "PageDown": toLine(line + rows); break;
      case "Home": move(ctrl ? 0 : lineStart); break;
      case "End": move(ctrl ? v.length : lineStart + lines[line]!.length); break;
      case "Backspace":
        if (hasSel) cut(s0, s1);
        else if (st.cur > 0) cut(ctrl ? wordLeft() : st.cur - 1, st.cur);
        break;
      case "Delete":
        if (hasSel) cut(s0, s1);
        else if (st.cur < v.length) cut(st.cur, ctrl ? wordRight() : st.cur + 1);
        break;
      case "Enter":
        if (a.el.multiline) this.insert("\n" + /^\s*/.exec(lines[line]!)![0]);
        else a.el.on?.("submit", st.value);
        break;
      case "Tab":
        if (a.el.multiline && !a.el.readonly) this.insert("  ");
        else if (!this.nextInput()) return false;
        break;
      default:
        if (ctrl && e.key.toLowerCase() === "a") {
          this.selectAll();
          break;
        }
        return false;
    }
    this.blink = true;
    this.invalidate();
    return true;
  }

  // ---- Input routing -------------------------------------------------------------

  private hitAt(x: number, y: number): Hit | null {
    if (this.queued) this.paint(); // hits must match what's on screen now
    const modal = [...this.wins].reverse().find((w) => w.modal);
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i]!;
      if (x >= h.x && y >= h.y && x < h.x + h.w && y < h.y + h.h) {
        if (modal && h.win !== modal) return null;
        return h;
      }
    }
    return null;
  }

  private local(h: Hit, x: number, y: number) {
    const [ox, oy] = h.win ? this.origin(h.win) : [0, 0];
    return { x: x - ox - h.el!.x, y: y - oy - h.el!.y };
  }

  private setHover(key: string | null) {
    if (key === this.hover) return;
    this.hover = key;
    this.invalidate();
  }

  /** What the mouse is over, for highlighting it. */
  private hoverAt(x: number, y: number) {
    if (this.popup || this.drag || this.captured || this.selecting || this.pressed) return;
    const bar = this.barAt(x, y);
    const docked = bar === null ? this.dockAt(x, y) : null;
    const h = bar === null && !docked ? this.hitAt(x, y) : null;
    this.setHover(
      bar !== null ? `bar:${bar}` : docked ? `dock:${docked.id}`
        : h?.kind === "close" || h?.kind === "min" ? `${h.kind}:${h.win!.id}` : h?.kind === "el" ? h.key! : null,
    );
    const cursor = h?.el?.t === "input" ? "text" : "default";
    if (this.view.style.cursor !== cursor) this.view.style.cursor = cursor;
  }

  /** Right-click (or long press): the menu for whatever is there. */
  private context(x: number, y: number) {
    this.closeMenu();
    const docked = this.dockAt(x, y);
    if (docked) {
      const shown = !docked.minimized;
      return this.winMenu(x, y, docked, shown ? "Minimize" : "Show", () => (shown ? this.minimize(docked) : this.raise(docked)));
    }
    const h = this.hitAt(x, y);
    if (h?.el?.t !== "input") this.active = null;
    if (!h) return this.invalidate();
    if (h.win) this.raise(h.win);
    if (h.kind !== "el") {
      const win = h.win!;
      return this.winMenu(x, y, win, { label: "Minimize", disabled: win.modal }, () => this.minimize(win));
    }
    if (h.el?.t === "input") return this.inputMenu(h, x, y);
    if (h.el?.t === "area") {
      const el = h.el;
      el.on?.("pointer", { type: "menu", ...this.local(h, x, y) });
      if (el.menu?.length) this.openMenu(x, y, el.menu, (i) => el.on?.("menu", i));
    }
    this.invalidate();
  }

  /** A window's own menu: minimize or show, whatever its owner adds, and close. */
  private winMenu(x: number, y: number, win: Win, first: MenuItem, onFirst: () => void) {
    const extra = win.menu?.();
    const items: MenuItem[] = [first, ...(extra?.items.length ? [null, ...extra.items] : []), null, "Close window"];
    this.openMenu(x, y, items, (i) => {
      if (i === 0) onFirst();
      else if (i === items.length - 1) this.close(win);
      else extra?.pick(i - 2);
      this.invalidate();
    });
  }

  /** Files dropped from outside go to the area under them, if it takes them. */
  private async drop(x: number, y: number, list: FileList) {
    const h = this.hitAt(x, y);
    if (h?.el?.t !== "area") return;
    const at = this.local(h, x, y);
    const files: Dropped[] = await Promise.all(
      [...list].map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })),
    );
    h.el.on?.("pointer", { type: "drop", ...at, files });
  }

  /** Stop whatever a press started, e.g. because a long press became a right-click. */
  private cancelPress(x: number, y: number) {
    if (this.captured) this.captured.el!.on?.("pointer", { type: "up", ...this.local(this.captured, x, y) });
    this.captured = this.pressed = this.selecting = this.drag = null;
  }

  private down(x: number, y: number, pointerType: string, button: number, shift: boolean) {
    if (button === 2) return this.context(x, y);
    if (button !== 0) return;
    if (this.popup) {
      const bar = this.barAt(x, y);
      if (this.insideMenu(x, y)) this.popup.armed = true;
      else if (bar !== null && this.popup.bar !== undefined && bar !== this.popup.bar) this.openBar(bar);
      else this.closeMenu();
      return;
    }
    const bar = this.barAt(x, y);
    if (bar !== null) return this.openBar(bar);
    const docked = this.dockAt(x, y);
    if (docked) {
      const modal = this.wins.some((w) => w.modal);
      if (!modal) this.dockClick(docked);
      return;
    }

    const h = this.hitAt(x, y);
    const keepKeys = h?.el?.t === "input";
    if (!keepKeys) {
      this.active = null;
      // On touch screens only focus the key catcher for text inputs, so the
      // on-screen keyboard doesn't pop up for every tap.
      if (pointerType === "touch") this.ta.blur();
      else this.ta.focus({ preventScroll: true });
    }
    if (!h || h.win === this.desk) this.focusDesk();
    if (!h) return this.invalidate();
    if (pointerType !== "mouse" && (h.kind === "title" || h.el?.t === "input" || (h.el?.t === "area" && h.el.menu?.length))) {
      const timer = setTimeout(() => {
        this.longPress = null;
        this.cancelPress(x, y);
        this.context(x, y);
      }, LONG_PRESS);
      this.longPress = { timer, x, y };
    }
    if (h.win) this.raise(h.win);
    if (h.kind === "title") this.drag = { win: h.win!, dx: x - h.win!.x, dy: y - h.win!.y };
    else if (h.kind === "close" || h.kind === "min") { this.pressed = h; this.pressedInside = true; }
    else if (h.el?.t === "button") {
      if (!h.el.disabled) { this.pressed = h; this.pressedInside = true; }
    } else if (h.el?.t === "area") {
      this.captured = h;
      h.el.on?.("pointer", { type: "down", ...this.local(h, x, y) });
    } else if (h.el?.t === "input") this.focusInput(h, x, y, shift);
    this.invalidate();
  }

  private move(x: number, y: number, pointerType: string) {
    if (this.longPress && Math.abs(x - this.longPress.x) + Math.abs(y - this.longPress.y) > 4) {
      clearTimeout(this.longPress.timer);
      this.longPress = null;
    }
    if (this.popup) {
      const p = this.popup;
      const i = this.itemAt(x, y);
      if (i !== p.hover) {
        p.hover = i;
        if (i >= 0) p.armed = true;
        this.invalidate();
      }
      const bar = this.barAt(x, y);
      if (p.bar !== undefined && bar !== null && bar !== p.bar) this.openBar(bar);
      return;
    }
    if (this.drag) {
      const w = this.drag.win;
      w.x = x - this.drag.dx;
      w.y = y - this.drag.dy;
      this.clampWin(w);
      this.invalidate();
    } else if (this.captured) {
      this.captured.el!.on?.("pointer", { type: "move", ...this.local(this.captured, x, y) });
    } else if (this.selecting) {
      const { hit, word } = this.selecting;
      const st = this.inputs.get(hit.key!);
      if (st) {
        const i = this.indexAt(hit, x, y);
        if (!word) st.cur = i;
        else if (i < word[0]) [st.anc, st.cur] = [word[1], wordAt(st.value, i)[0]];
        else if (i > word[1]) [st.anc, st.cur] = [word[0], wordAt(st.value, i - 1)[1]];
        else [st.anc, st.cur] = word;
        st.follow = true;
        this.invalidate();
      }
    } else if (this.pressed) {
      const p = this.pressed;
      const inside = x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h;
      if (inside !== this.pressedInside) {
        this.pressedInside = inside;
        this.invalidate();
      }
    } else if (pointerType === "mouse") this.hoverAt(x, y);
  }

  private up(x: number, y: number, pointerType: string) {
    if (this.longPress) {
      clearTimeout(this.longPress.timer);
      this.longPress = null;
    }
    if (this.popup) {
      const p = this.popup;
      const i = this.itemAt(x, y);
      if (i >= 0 && p.armed) {
        this.closeMenu();
        p.pick(i);
      }
      return;
    }
    this.drag = null;
    this.selecting = null;
    if (this.captured) {
      const c = this.captured;
      this.captured = null;
      c.el!.on?.("pointer", { type: "up", ...this.local(c, x, y) });
    }
    if (this.pressed) {
      const p = this.pressed;
      this.pressed = null;
      if (this.pressedInside) {
        if (p.kind === "close") this.close(p.win!);
        else if (p.kind === "min") this.minimize(p.win!);
        else p.el!.on?.("click");
      }
    }
    if (pointerType === "mouse") this.hoverAt(x, y);
    this.invalidate();
  }

  private wheel(x: number, y: number, dy: number) {
    if (this.popup) return;
    const h = this.hitAt(x, y);
    if (h?.el?.t === "input" && h.el.multiline) {
      const st = this.state(h.key!, h.el as InputEl);
      const lines = st.value.split("\n").length;
      st.sy = Math.max(0, Math.min(lines - 1, st.sy + dy * 3));
      this.invalidate();
    } else if (h?.el?.t === "area") {
      h.el.on?.("pointer", { type: "wheel", dy, ...this.local(h, x, y) });
    }
  }

  private key(e: KeyboardEvent) {
    if (this.popup) {
      e.preventDefault();
      return this.menuKey(e);
    }
    const k: KeyEvent = { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
    const win = this.active ? this.active.win : (this.focused ?? this.desk);
    if (this.active) {
      const shortcut = (e.ctrlKey || e.metaKey) && !"vcxaz".includes(e.key.toLowerCase()) && !e.key.startsWith("Arrow")
        && !["Home", "End", "Backspace", "Delete"].includes(e.key);
      if (!shortcut && e.key !== "Escape") {
        if (this.editKey(e)) return e.preventDefault();
        // Typed text arrives through the input event. Other keys the input
        // doesn't use (like Up in a one-line input, or typing in a read-only
        // one) go on to the program.
        const typing = e.key.length === 1 && !(e.ctrlKey || e.metaKey);
        if (e.isComposing || (typing && !this.active.el.readonly) || (!typing && (e.ctrlKey || e.metaKey))) return;
      }
    }
    if (e.isComposing || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v")) return;
    e.preventDefault();
    win?.onKey?.(k);
  }
}

function lineCol(s: string, cur: number) {
  const before = s.slice(0, cur);
  const line = before.split("\n").length - 1;
  return { line, col: cur - (before.lastIndexOf("\n") + 1) };
}
