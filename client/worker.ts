/**
 * Every program runs in its own worker built from this file. The worker is
 * served with a CSP that blocks all network access and outside code, and the
 * usual web APIs are removed besides: a program gets `sys` and nothing else.
 */
import { icons } from "./icons";
import { LINE_H, SCROLL_W, fit, flatten, measure, ui, wrap, type El, type Els, type Font, type KeyEvent, type MenuItem, type On } from "./ui";

const post = self.postMessage.bind(self);
const makeURL = URL.createObjectURL;
const revokeURL = URL.revokeObjectURL;
const BlobCtor = Blob;

for (const name of [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches",
  "Worker", "SharedWorker", "BroadcastChannel", "WebTransport", "RTCPeerConnection",
]) {
  try {
    Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
  } catch {}
}

// ---- Calls into the OS ---------------------------------------------------------

const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let seq = 0;
function call<T = any>(method: string, ...args: unknown[]): Promise<T> {
  const id = ++seq;
  post({ type: "call", id, method, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

let handlers = new Map<string, On>();
let keyHandler: ((e: KeyEvent) => void) | null = null;
let messageHandler: ((from: string, data: unknown) => void) | null = null;
let themeHandler: (() => void) | null = null;
let resizeHandler: (() => void) | null = null;
let changeHandler: ((dir: string) => void) | null = null;
let menuHandlers: ((() => void) | undefined)[][] = [];

/** A program's menu: its items run `onClick` when picked. `hint` is shown on the right, e.g. "Ctrl+S". */
type ProgramMenu = { label: string; items: ({ label: string; onClick?: () => void; disabled?: boolean; hint?: string } | null)[] };
/** The current theme's colors, by name. Updated in place when the user switches themes. */
const colors: Record<string, string> = {};
const inbox: [string, unknown][] = [];

const menuItem = (it: MenuItem | { label: string; disabled?: boolean; hint?: string; onClick?: unknown }): MenuItem =>
  it && typeof it === "object" ? { label: String(it.label), disabled: !!it.disabled, hint: it.hint === undefined ? undefined : String(it.hint) } : it;

function render(els: Els) {
  const count: Record<string, number> = {};
  const next = new Map<string, On>();
  // Ids are unique across the whole window, children of scroll groups included.
  const strip = (list: El[]): El[] =>
    list.map((el) => {
      const id = el.key ?? `${el.t}${(count[el.t] = (count[el.t] ?? 0) + 1)}`;
      if (el.on) next.set(id, el.on);
      const { on, ...rest } = el;
      // Menus may be written with their onClick handlers; only the labels go to the screen.
      if (rest.t === "area" && Array.isArray(rest.menu)) rest.menu = rest.menu.map(menuItem);
      if (rest.t === "scroll") rest.children = strip(flatten(rest.children ?? []));
      return { ...rest, id } as El;
    });
  const out = strip(flatten(els));
  handlers = next;
  post({ type: "render", els: out });
}

type FileInfo = { name: string; path: string; type: "file" | "dir" | "link"; size: number; mtime: number; target?: string };
/** A dialog: `fields` are text boxes; the answer is their values, or null if cancelled. */
type Prompt = { title: string; text?: string; fields?: { label: string; value?: string; password?: boolean }[]; ok?: string; cancel?: string };
/**
 * What to ask the user for. "open": an existing file. "save": a file to write,
 * new or not (`name` is the suggestion). "folder": a folder, new or not.
 * `write` asks to change what's picked too ("save" always does).
 */
type Pick = { mode?: "open" | "save" | "folder"; name?: string; write?: boolean; start?: string };

/** The whole API a program sees. */
type Init = { args: Record<string, unknown>; me: string; home: string; path: string; colors: Record<string, string> };

const size = { w: 0, h: 0 };

function makeSys(init: Init, start: [number, number]) {
  Object.assign(colors, init.colors);
  [size.w, size.h] = start;
  return {
    /** Your window's size, picked from the `sizes` you exported. (The desktop's changes: see onResize.) */
    size,
    /** How you were opened, e.g. `{ file: "/com/box/you/notes.txt" }`. */
    args: init.args,
    /** Who is using the computer, e.g. `andrew@simplebox.com`. */
    me: init.me,
    home: init.home,
    /** Where this program lives. */
    self: init.path,
    colors,

    ui: {
      ...ui,
      /** Line height of text, in pixels. */
      lineHeight: LINE_H,
      /** Width of a scroll group's scroll bar, in pixels. */
      scrollBarWidth: SCROLL_W,
      /** Width of one line of text in pixels. */
      measure: (text: string, font: Font = "ui") => measure(text, font),
      /** Word-wrap text to a width. */
      wrap: (text: string, width: number, font: Font = "ui") => wrap(text, width, font),
      /** Shorten text with ".." to fit a width. */
      fit: (text: string, width: number, font: Font = "ui") => fit(text, width, font),
      /** Replace everything in your window with these elements. */
      render,
      onKey(fn: (e: KeyEvent) => void) {
        keyHandler = fn;
      },
      /**
       * The menus shown in the menu bar while your window is in front, after your
       * program's name. Call it again whenever they should change.
       */
      setMenus(menus: ProgramMenu[]) {
        menuHandlers = menus.map((m) => m.items.map((it) => it?.onClick));
        post({
          type: "menus",
          menus: menus.map((m) => ({
            label: String(m.label),
            items: m.items.map(menuItem),
          })),
        });
      },
      /** Called after the user switches themes (colors are already updated). */
      onTheme(fn: () => void) {
        themeHandler = fn;
      },
      /** Called when your window changes size (sys.size is already updated). */
      onResize(fn: () => void) {
        resizeHandler = fn;
      },
      /** Put the text cursor in your input with this `key`. */
      focus: (key: string) => post({ type: "focus", key: String(key) }),
      /** Scroll your scroll group with this `key` so `y` is at the top of its view. */
      scrollTo: (key: string, y: number) => post({ type: "scrollTo", key: String(key), y: Number(y) || 0 }),
      /** The system's 16x16 icons (RGBA), for sys.ui.bitmap. */
      icons,
      /** Ask the user something in a dialog. Resolves to the fields' values, or null if cancelled. */
      prompt: (p: Prompt) => call<string[] | null>("ui.prompt", p),
      confirm: (title: string, text: string, ok = "OK") => call<boolean>("ui.confirm", title, text, ok),
      alert: (text: string) => call<void>("ui.alert", text),
    },

    /** Files. Paths may start with `~`. You'll be asked for access the first time. */
    fs: {
      read: (path: string) => call<string>("fs.read", path),
      readBytes: (path: string) => call<Uint8Array>("fs.readBytes", path),
      write: (path: string, data: string | Uint8Array) => call<void>("fs.write", path, data),
      list: (path: string) => call<FileInfo[]>("fs.list", path),
      exists: (path: string) => call<boolean>("fs.exists", path),
      stat: (path: string) => call<{ path: string; type: "file" | "dir"; size: number; mtime: number }>("fs.stat", path),
      mkdir: (path: string) => call<void>("fs.mkdir", path),
      remove: (path: string) => call<void>("fs.remove", path),
      rename: (from: string, to: string) => call<void>("fs.rename", from, to),
      /** Make a link at `path` pointing at `target` (any full path, even on another box). */
      link: (path: string, target: string) => call<void>("fs.link", path, target),
      /** Who else may read and change something you own: addresses, or "*" for everyone. */
      sharing: (path: string) => call<{ path: string; read: string[]; write: string[] }>("fs.sharing", path),
      share: (path: string, who: { read: string[]; write: string[] }) => call<void>("fs.share", path, who),
      /** Let the user choose files from their device and copy them into `dir`. Resolves to their names. */
      upload: (dir: string) => call<string[]>("fs.upload", dir),
      /**
       * Ask the user to pick (or create) a file or folder. Resolves to its path, or
       * null if they cancel. Your program may then use that file or folder, without asking again.
       */
      pick: (opts: Pick = {}) => call<string | null>("fs.pick", opts),
      /** How the system's file picker (Files, started with sys.args.pick) answers. Other programs can't. */
      picked: (path: string | null) => call<void>("fs.picked", path),
      /** Called with a folder when something in it changed (from any program). */
      onChange(fn: (dir: string) => void) {
        changeHandler = fn;
      },
    },

    /**
     * Call web APIs (asks for permission per origin). Requests come straight from
     * the user's browser with no cookies, so only APIs that allow cross-origin
     * requests (CORS) will answer.
     */
    net: {
      fetch: (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
        call<{ status: number; headers: Record<string, string>; body: string }>("net.fetch", url, opts),
    },

    /** Talk to other programs (asks for permission per program). */
    apps: {
      send: (program: string, data: unknown) => call<void>("apps.send", program, data),
      onMessage(fn: (from: string, data: unknown) => void) {
        messageHandler = fn;
        for (const [from, data] of inbox.splice(0)) fn(from, data);
      },
      /** Open a file or folder the way the desktop would. `edit` opens a program's source instead of running it. */
      open: (path: string, opts: { edit?: boolean } = {}) => call<void>("apps.open", path, opts),
    },

    /** Ask up front: `{ folder: "~/Notes", write: true }`, `{ app: path }` or `{ net: "https://..." }`. */
    request: (perm: { folder?: string; write?: boolean; app?: string; net?: string }) => call<boolean>("request", perm),

    setTitle: (title: string) => post({ type: "title", title: String(title) }),
    quit: () => post({ type: "quit" }),
  };
}

export type Sys = ReturnType<typeof makeSys>;

// ---- Lifecycle -------------------------------------------------------------------

let mod: any;
let init: Init;

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  switch (m.type) {
    case "init": {
      init = m;
      const url = makeURL(new BlobCtor([m.code], { type: "text/javascript" }));
      try {
        mod = await import(/* @vite-ignore */ url);
      } catch (err) {
        post({ type: "crash", error: String((err as Error)?.stack ?? err) });
        return;
      } finally {
        revokeURL(url);
      }
      post({ type: "meta", sizes: mod.sizes ?? [[320, 200]], title: mod.title, icon: typeof mod.icon === "string" ? mod.icon : undefined });
      break;
    }
    case "start":
      try {
        if (typeof mod.default !== "function") throw new Error("a program must `export default function main(sys) {...}`");
        await mod.default(makeSys(init, m.size));
      } catch (err) {
        post({ type: "crash", error: String((err as Error)?.stack ?? err) });
      }
      break;
    case "event":
      handlers.get(m.id)?.(m.kind, m.data);
      break;
    case "menu":
      menuHandlers[m.menu]?.[m.item]?.();
      break;
    case "theme":
      Object.assign(colors, m.colors);
      themeHandler?.();
      break;
    case "resize":
      [size.w, size.h] = m.size;
      resizeHandler?.();
      break;
    case "changed":
      changeHandler?.(m.dir);
      break;
    case "key":
      keyHandler?.(m.key);
      break;
    case "message":
      if (messageHandler) messageHandler(m.from, m.data);
      else inbox.push([m.from, m.data]);
      break;
    case "result": {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) p?.resolve(m.value);
      else p?.reject(new Error(m.error));
      break;
    }
  }
};

self.addEventListener("unhandledrejection", (e) => post({ type: "error", error: String(e.reason?.message ?? e.reason) }));
self.addEventListener("error", (e) => post({ type: "error", error: String(e.message) }));
