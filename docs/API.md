# API reference

There are three APIs:

1. **The program API (`sys`)**: what a program running on the computer can do.
2. **The box HTTP API**: what the computer (the web page) uses to talk to a box.
3. **The federation API**: what boxes use to talk to each other. It is part of the
   HTTP API, but it has its own message formats and crypto.
4. **The directory API**: a small separate server that lists boxes, so `/` and
   `/com` can be listed.

[DESIGN-OVERVIEW.md](DESIGN-OVERVIEW.md) explains why things are the way they are.

---

## 1. Program API

A program is a `.js` or `.ts` file (which may import others, see 1.9):

```ts
export const title = "Clock";                 // optional; defaults to the file name
export const sizes = [[240, 80], [160, 120]]; // optional; defaults to [[320, 200]]
export const icon = "picture";                // optional; for the dock: program, file, folder, picture or terminal
export default function main(sys) {           // required; called once, may be async
  sys.ui.render([sys.ui.text(8, 8, new Date().toTimeString())]);
}
```

The OS picks one size from `sizes`. Among the sizes that fit the screen (720x480
on desktops, 270x480 on phones, minus window chrome), it prefers sizes shaped like
the screen (landscape or portrait), then the largest. If none fit, it takes the
smallest, cut down to the screen. The window never changes size afterwards.

Programs run in a sandboxed worker. `fetch`, XHR, WebSockets, storage and dynamic
imports are unavailable; `sys` is the whole interface. Every `sys` call that talks to the
OS returns a promise. A call that isn't allowed rejects with `Error("permission denied")`.

### 1.1 Context

| Name | Type | |
| --- | --- | --- |
| `sys.size` | `{ w, h }` | The window's content size in pixels |
| `sys.args` | `{ file?: string }` | Set when the program was opened with a file (or, for Files, a folder) |
| `sys.me` | `string` | The user's address, e.g. `andrew@simplebox.com` |
| `sys.home` | `string` | The user's home path, e.g. `/com/simplebox/andrew` |
| `sys.self` | `string` | This program's path, with symlinks resolved |
| `sys.colors` | `Record<string, string>` | The current theme's colors as CSS; kept up to date |

### 1.2 Drawing

`sys.ui.render(elements)` replaces everything in the window. `elements` is an
array; nested arrays are flattened, and `false`, `null` and `undefined` are
skipped, so `cond && el` works. Coordinates are in window pixels from the top
left. Later elements draw on top of earlier ones.

| Constructor | Notes |
| --- | --- |
| `ui.text(x, y, text, { color?, w?, bg?, align?, font?, key? })` | `w` wraps at that width. `align` is `left`, `center` or `right` (needs `w`). `\n` breaks lines. |
| `ui.rect(x, y, w, h, fill?, stroke?)` | Either can be omitted. The stroke is 1px inside the rect. |
| `ui.line(x1, y1, x2, y2, color?)` | 1px wide, pixel-exact. |
| `ui.button(x, y, w, h, label, onClick?, { disabled?, primary?, key? })` | Clicks when released inside. 18 to 20px tall looks right. `primary` draws it in the accent color, for the button Enter would press. Buttons highlight under the mouse. |
| `ui.input(x, y, w, h, value, onChange?, { multiline?, password?, readonly?, placeholder?, onSubmit?, font?, key? })` | The OS does the editing, including selection (drag, shift+click, double-click for a word and drag to extend by words, triple-click for a line, shift+arrows, Ctrl+A), copy, cut and paste (password fields too), and a right-click menu. `onChange(value)` fires on each edit, `onSubmit(value)` on Enter (single-line only). Read-only inputs can still be selected and copied. |
| `ui.bitmap(x, y, w, h, pw, ph, rgba)` | `rgba` is a `Uint8ClampedArray` of `pw*ph*4` bytes, stretched to `w x h` without smoothing. |
| `ui.area(x, y, w, h, onPointer, { key?, hover?, menu?, onMenu? })` | Invisible; receives `{ type: "down" \| "move" \| "up" \| "wheel" \| "menu" \| "drop", x, y, dy?, files? }` in local coordinates. After `down`, the area keeps getting `move` and `up` until release, even outside its bounds. `hover` is a color the area is filled with while the mouse is over it (put the area before what should draw on top). `menu` is a list of labels (or `{ label, disabled, hint }`, or `null` for a separator; `onClick` handlers in it are ignored) shown on right-click or long press; the area first gets a `menu` pointer event, then `onMenu(index)` if something is picked. `drop` is files dragged in from the user's computer: `files` is `[{ name, data: Uint8Array }]`, and nothing is saved unless you write it. |

**Inputs are semi-controlled.** The OS keeps the text being edited. If you
render an input with a `value` different from the last one you rendered, the OS
takes yours. Rendering your stale value again does nothing. Inputs, buttons and
areas are identified by `key` if given, otherwise by their order among elements of
the same type. Give inputs a `key` if the list changes shape, so they keep their
cursor and scroll position.

| Function | |
| --- | --- |
| `sys.ui.onKey(fn)` | `fn({ key, ctrl, shift, alt, meta })` for keys pressed while no input has focus, for keys the focused input doesn't use (Up and Down in a one-line input, Tab when there's no other input to go to, typing in a read-only input), and for Ctrl/Cmd shortcuts (except C, V, X, A and Z). `key` is a DOM key name (`"a"`, `"Enter"`, `"ArrowLeft"`). |
| `sys.ui.focus(key)` | Put the cursor at the end of your input with that `key` (if your window is in front). |
| `sys.ui.setMenus(menus)` | The menus shown in the menu bar, after your program's name, while your window is in front: `[{ label: "File", items: [{ label: "Save", onClick, disabled?, hint?: "Ctrl+S" }, null, ...] }]`. `null` is a separator; `hint` is shown on the right (it doesn't bind the key; handle that in `onKey`). Call it again whenever the menus should change. |
| `sys.ui.onTheme(fn)` | Called after the user switches themes. Only needed if you computed something from `sys.colors`. |
| `sys.ui.onResize(fn)` | Called after `sys.size` changes. Only the desktop's does (when the screen turns between landscape and portrait); windows keep their size. |
| `sys.ui.prompt({ title, text?, fields?: [{ label, value?, password? }], ok?, cancel? })` | A dialog over everything; resolves to the fields' values, or `null` if cancelled. The title always starts with your program's name. |
| `sys.ui.confirm(title, text, ok?)`, `sys.ui.alert(text)` | Resolve to `true`/`false`, and when dismissed. |
| `sys.ui.icons` | The system's 16x16 RGBA icons (`folder`, `file`, `program`, `picture`, `terminal`, `link`), for `ui.bitmap`. |
| `sys.setTitle(text)` | Sets the window title. |
| `sys.quit()` | Closes the window and ends the program. |

### 1.3 Text

Three fonts: `"ui"`, proportional and the default, `"bold"`, the same 1px wider
per stroke, and `"mono"`, 6px per character. All have 8px capitals, a 6px x-height, 2px descenders and 12px line spacing.
Printable ASCII only; anything else draws as a box.

| | |
| --- | --- |
| `sys.ui.lineHeight` | `12` |
| `sys.ui.measure(text, font?)` | Width in pixels of one line |
| `sys.ui.wrap(text, width, font?)` | Lines wrapped at word boundaries (long words are broken) |
| `sys.ui.fit(text, width, font?)` | Cut down with a trailing `..` to fit |

### 1.4 Colors

Any color argument takes a name (recommended) or any CSS color.

| Role names (change with the theme) | |
| --- | --- |
| `panel` | Window background (also what windows are cleared to) |
| `field` | Inputs and buttons |
| `hover` | What the mouse is over |
| `text`, `dim` | Main and secondary text |
| `line` | Borders |
| `accent`, `accentText` | Highlights, and text drawn on them |
| `desk`, `dots`, `shadow` | Desktop, its dot grid, drop shadows |

Hue names are the same in every theme: `red orange yellow green teal blue purple pink brown black gray white`.

### 1.5 Files

Paths are global (`/com/simplebox/andrew/notes.txt`). They may start with `~`
(your home), and relative paths are relative to your home. Files on other boxes
work the same way.

| Call | Result | Permission |
| --- | --- | --- |
| `sys.fs.read(path)` | `string` (UTF-8) | read on the parent folder |
| `sys.fs.readBytes(path)` | `Uint8Array` | read on the parent folder |
| `sys.fs.write(path, data)` | `void`; `data` is a string or `Uint8Array` | read+change on the parent folder |
| `sys.fs.list(path)` | `[{ name, path, type: "file" \| "dir" \| "link", size, mtime, target? }]` | read on `path` |
| `sys.fs.exists(path)` | `boolean` | read on the parent folder |
| `sys.fs.mkdir(path)` | `void` | read+change on the parent folder |
| `sys.fs.remove(path)` | `void`; removing a link leaves its target alone | read+change on the parent folder |
| `sys.fs.stat(path)` | `{ path, type: "file" \| "dir", size, mtime }`; `path` has links resolved | read on the parent folder |
| `sys.fs.rename(from, to)` | `void` | read+change on both parent folders |
| `sys.fs.link(path, target)` | `void`; `target` is any full path, even on another box | read+change on the parent folder |
| `sys.fs.sharing(path)` | `{ path, read, write }`: who else may use it (only for things you own) | read+change on the parent folder |
| `sys.fs.share(path, { read, write })` | `void`; lists of addresses (`bob`, `bob@other.box`) or `*` | read+change on the parent folder |
| `sys.fs.upload(dir)` | The names of the files the user chose from their device, now copied into `dir` | read+change on `dir` |
| `sys.fs.pick({ mode?, name?, write?, start? })` | The path the user picked, or `null` | none: see below |
| `sys.fs.onChange(fn)` | `fn(dir)` when something in a folder you may read changed through another program | |

**Picking.** `sys.fs.pick` shows the file picker over everything and lets the
user choose: `mode: "open"` (the default) an existing file, `"save"` a file to
write, new or not (`name` is the suggestion), `"folder"` a folder, new or not.
Whatever they pick, your program may use from then on without asking: to read
it, and to change it for `"save"` or with `write: true`. That's recorded like any
other permission, so the user can see and revoke it. `start` is where the
picker opens (only if your program may already read there; otherwise the home).

A folder permission covers everything below that folder. The file in
`sys.args.file` needs no permission. The first time a call needs a permission,
the user is asked; the answer is remembered on their box (Allow) or for this run
of the program (Deny). All of this is on top of the user's own access: a program
can never do more than the user can.

### 1.6 Web APIs

`sys.net.fetch(url, { method?, headers?, body? })` returns `{ status, headers, body }`, where `body` is a string.

- `https://` only (`http://localhost` too, for development).
- Asks the user once per origin (`https://api.example.com`).
- Sent from the user's browser with no cookies, no referrer, and without
  following redirects. Only servers that allow cross-origin requests (CORS) will
  answer, which in practice means APIs, not websites.
- The user's own box can't be called this way.

### 1.7 Other programs

| Call | |
| --- | --- |
| `sys.apps.send(path, data)` | Deliver `data` (anything structured-cloneable) to every running instance of that program, starting it if none is running. Asks the user once per target program. |
| `sys.apps.onMessage((from, data) => …)` | `from` is the sender's path. Messages that arrive before you register are queued. |
| `sys.apps.open(path, { edit? })` | Open a file or folder the way double-clicking would; `edit` opens a program's source in the Editor instead of running it. Needs read permission on it, since it hands the file to another program. |

### 1.8 Asking up front

`sys.request(perm)` resolves to `true` or `false` and never throws. `perm` is
one of `{ folder, write? }`, `{ net: url }` or `{ app: path }`.

### 1.9 Imports

Programs can import other `.ts` and `.js` files. They're bundled in when the
program starts.

```ts
import { Folder } from "./lib/folder.ts";             // relative to this file
import { chart } from "/com/bob/bob/Public/chart.ts"; // a full path, even on another box
```

- Specifiers are `./relative`, `../relative` or `/full/paths`. A missing
  extension means `.ts`. Packages (`import "left-pad"`) aren't supported.
- An import has to be in the program's own folder or below it, or readable by
  everyone (shared with `*`). This is checked where a link lands, too. Otherwise
  a program someone gives you could pull your private files into itself just by
  naming them.
- Importing doesn't need a permission, and imported code runs with the program's
  permissions, like the rest of the program.

### 1.10 System programs

The desktop (`Desktop.ts`), the file browser (`Files.ts`) and the terminal
(`Terminal.ts`) are ordinary programs in the box's `system` folder, but they're
part of the OS, so they may use all of the user's files without asking. That
only applies to those files in the user's own box's `system` folder, which only
the box's admin can change. Everything else they do (the web, other programs)
is asked for like any program. The desktop is started at login and drawn behind
every window (Box > Restart desktop starts it again). Files is also the file
picker: when started with `sys.args.pick`, it answers with `sys.fs.picked(path)`,
which no other program may call.

---

## 2. Box HTTP API

**Base URL.** Read it from the domain's well-known file (below), e.g.
`https://simplebox.com/api`. All endpoints allow any origin (CORS), since the
computer can be hosted anywhere.

**Auth.** `Authorization: Bearer <token>` from signup or login. There are no
cookies. Endpoints marked *public* work without a token, as the public: only
things shared with `*` are visible. Other boxes use the same endpoints, signed on
behalf of one of their users instead of with a token (section 3).

**Errors** are JSON: `{ "error": "message" }` with a meaningful status (400 bad
input, 401 not logged in or not public, 403 not allowed, 404 not found, 409
conflict, 410 account moved). **Redirects:** when an anonymous caller or another
box asks for a path that goes through a link to another box, the response is
`307 { "error": "...", "redirect": "/other/box/path" }` (no `Location` header).
The caller should ask the box that owns the new path. Logged-in users never see
this, because their box follows the link for them.

**Paths** are always absolute global paths.

### 2.1 Discovery

`GET /.well-known/simplebox` (at the root of the domain, not under `/api`), public:

```json
{ "simplebox": 1, "domain": "simplebox.com", "api": "https://simplebox.com/api", "prefix": "/com/simplebox",
  "key": "<the box's Ed25519 public key, 32 bytes base64url>" }
```

Rules for clients and boxes:

- For an **address** `user@d`: fetch `https://d/.well-known/simplebox`.
- For a **path**: try each domain from the shortest with a dot in it
  (`simplebox.com`) to the longest (`andrew.simplebox.com`), stopping at the first
  one that answers. The path may be the box's root (`/com/simplebox`), which
  lists its users.
- Accept the answer only if `domain` matches and `api` is `https`, on that domain
  or a subdomain of it, with no query string, and `key` is present. Don't follow
  redirects.

### 2.2 Accounts

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /signup` | `{ user, password }` | `{ token, address, home }`. Names are `[a-z0-9][a-z0-9_-]{0,31}`, and `system` is reserved. Creates the home folder. Returns 403 when signups are closed. |
| `POST /login` | `{ user, password }` | `{ token, address, home }`, or 410 `this account moved to /new/path` |
| `POST /logout` | | Ends this token's session |
| `GET /me` | | `{ address, home }` |

### 2.3 Files

All of these follow symlinks, including links to other boxes, except where noted.

| Endpoint | | Response |
| --- | --- | --- |
| `GET /fs/stat?path=` *(public, boxes)* | | `{ path, type: "file" \| "dir", size, mtime }`. `path` has links resolved. |
| `GET /fs/list?path=` *(public, boxes)* | | `{ path, entries: [{ name, type: "file" \| "dir" \| "link", size, mtime, target? }] }`. Names starting with `.` are hidden. The box's root (`/com/simplebox`) lists everyone's home. Folders above boxes (`/`, `/com`) list the boxes below them, from the box's directory (section 4) plus the box itself. |
| `GET /fs/read?path=` *(public, boxes)* | | Raw bytes. `X-Box-Path` is the resolved path. |
| `PUT /fs/write?path=` *(boxes)* | raw bytes | `{ ok }`. Creates or replaces a file; the folder must exist. Works on other boxes if you were given write access there. |
| `POST /fs/mkdir` | `{ path }` | `{ ok }`. This box only. |
| `POST /fs/remove` | `{ path }` | `{ ok }`. Removes the link itself, not its target; folders are removed recursively. This box only. |
| `POST /fs/rename` | `{ from, to }` | `{ ok }`. Doesn't follow a final link. This box only. |
| `POST /fs/link` | `{ path, target }` | `{ ok }`. `target` is a global path (or relative to the link's folder) and doesn't have to exist. This box only. |

Access: the owner can do everything in their home. Others need to be on the
nearest sharing list at or above the path (read, or read and change). Following
a link needs read access to where the link *points*, plus read access to the link
itself if it points to another box.

### 2.4 Sharing (owner only)

| Endpoint | Body | Response |
| --- | --- | --- |
| `GET /acl?path=` | | `{ path, read: string[], write: string[] }` |
| `POST /acl` | `{ path, read: string[], write: string[] }` | The same shape, after saving |

Entries are `*`, `bob` (meaning `bob` on this box, stored as `bob@this.box`) or
`bob@other.box`. Saving fails with 404 if `other.box` has no box. `path` has links
resolved: sharing applies to the real place. Write access implies read access.

### 2.5 Programs

`GET /program?path=` returns `{ path, code }`. `path` has links resolved and is
what permissions are recorded against. `code` is one ES module of JavaScript: the
program with its imports bundled in (section 1.9), TypeScript compiled. Returns
422 if it doesn't compile or imports something it may not.

### 2.6 Program permissions

| Endpoint | Body | |
| --- | --- | --- |
| `GET /grants` | | `[{ id, app, kind: "folder" \| "app" \| "net", target, access }]`; `access` is `read` or `write` for folders, otherwise empty |
| `POST /grants` | `{ app, kind, target, access? }` | Adds or replaces a grant |
| `DELETE /grants?id=` | | Revokes a grant |

The computer enforces these; the box only stores them.

---

## 3. Federation

Boxes call each other's normal API (section 2) on behalf of their users. Instead
of a token, the request carries two headers:

```
Box-As: carol@b.test
Box-Signature: <ts>.<nonce>.<sig>
```

- `ts`: milliseconds since the epoch; must be within 5 minutes of the receiver's clock.
- `nonce`: 18 random bytes, base64url; each is accepted only once (kept in the db for 10 minutes).
- `sig`: Ed25519 by the box of `Box-As` (its key from its well-known file), base64url, over

```
simplebox/1\n<receiving domain>\n<METHOD>\n<target>\n<Box-As>\n<ts>\n<nonce>\n<base64url(SHA-256(body))>
```

  where `target` is the path after the API base plus the query string, e.g.
  `/fs/read?path=%2Ftest%2Fa%2Fandrew%2Fnotes.txt`, and an empty body hashes as
  zero bytes.

The receiving box:

1. rejects it if `Box-As` is on its own domain (its users log in), or `ts` or
   `nonce` are stale or reused;
2. looks up the well-known file for the domain of `Box-As` and verifies `sig` with
   its `key`. If that fails it fetches the well-known file again (at most once a
   minute per domain) in case the box changed its key;
3. treats the request as coming from `carol@b.test`, who is checked against
   sharing lists like anyone else.

Boxes accept signed requests on `fs/stat`, `fs/list`, `fs/read` and `fs/write`.
Everything else needs a logged-in user. A box never follows a link to a third box
for a signed request; it answers `307 { redirect }` (if the caller may read the
link) and the caller's box follows it itself.

---

## 4. Directory

A directory is a separate, optional server ([directory/index.ts](../directory/index.ts))
that keeps a list of boxes. It's only for listing the folders above boxes. Finding
a box never needs it. A box uses the directory in `BOX_DIRECTORY` and registers
itself there when it starts (and every 6 hours).

| Endpoint | | |
| --- | --- | --- |
| `POST /register` | `{ domain }` | The directory fetches `https://<domain>/.well-known/simplebox` itself and lists the box if it's valid, so there's nothing to prove. |
| `GET /list?path=` | | `{ path, entries: [{ name, box? }] }`: the folders under a path above boxes. `box` is set on a box's root. For a path inside a box: `{ path, box }`, meaning ask that box. |
| `GET /boxes` | | `[{ domain, api, prefix, checked }]` |

Boxes are checked every 6 hours and dropped after a day of not answering.

---

## 5. Internals: the program ↔ OS channel

This is for reference only: programs use `sys`, never these messages. It's a
`postMessage` protocol between the OS and each worker.

| OS → program | Program → OS |
| --- | --- |
| `init { code, path, args, me, home, colors }` | `meta { sizes, title, icon }` (after loading) |
| `start { size: [w, h] }` | `render { els }` (callbacks replaced by ids) |
| `event { id, kind, data }` (`click`, `change`, `submit`, `pointer`, `menu`) | `call { id, method, args }` (`fs.*`, `ui.prompt`, `ui.confirm`, `ui.alert`, `net.fetch`, `apps.*`, `request`) |
| `result { id, ok, value \| error }` | `title { title }`, `quit`, `crash { error }`, `error { error }` |
| `key { key }`, `theme { colors }`, `message { from, data }` | `menus { menus: [{ label, items: [{ label, disabled, hint } \| null] }] }` |
| `menu { menu, item }` (a menu bar item was picked) | `focus { key }` |
| `resize { size }`, `changed { dir }` | |
