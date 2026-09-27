# The Shared Computer: design overview

Status: implemented, for review. This describes how the system in this repo works
and the decisions that are worth a second look. The API details are in
[API.md](API.md); the original brief is [DESIGN.md](../DESIGN.md).

## 1. The idea in one paragraph

A "box" is a server that hosts people's home folders, like an old shared Unix
machine or an email provider. You log in as `andrew@simplebox.com` from a single
web page (the "computer"), which can be served from anywhere and talks to your
box. Your desktop is your home folder. Programs are just files in folders; they
run sandboxed in the page with a small UI library at a fixed 720x480 pixel
resolution. Anything can be shared with people on the same box or on other
boxes, and links (symlinks) can point anywhere, including at other boxes.

## 2. The pieces

```
 browser tab (the computer, a single page)                      box: simplebox.com
┌──────────────────────────────────────────────┐              ┌──────────────────────────┐
│  OS (main thread)                            │   HTTPS      │  Bun server              │
│   screen: one 720x480 canvas                 │   bearer     │   /api/...  (API.md)     │
│   shell: menu bar, dialogs, permissions      │──token──────▶│   /.well-known/simplebox │
│   process host: permission checks            │              │                          │
│        ▲ postMessage (sys calls, UI lists)   │              │  DATA/                   │
│  ┌─────┴─────┐ ┌───────────┐                 │              │   .box.sqlite  metadata  │
│  │ program   │ │ program   │  Web Workers,   │              │   andrew/      a home    │
│  │ (worker)  │ │ (worker)  │  CSP: no net    │              │   system/      apps      │
│  └───────────┘ └───────────┘                 │              └────────────┬─────────────┘
└──────────────────────────────────────────────┘                           │ signed +
          │ web APIs (CORS, per-origin permission, no cookies)             │ box-signed
          ▼                                                                ▼
     api.open-meteo.com etc.                                     other boxes
```

- **Server** (`server/`): one Bun process per box. Bun's built-ins cover HTTP,
  SQLite, password hashing, TypeScript transpiling, bundling and WebCrypto, so
  there are no runtime dependencies.
- **Client** (`client/`): plain TypeScript bundled by Bun, with no framework. The
  OS runs on the main thread; each program runs in its own Web Worker.
- **System programs** (`system/`): Desktop, Files, Terminal, Editor, Paint,
  Hello, Weather, a shared `lib/folder.ts` and `API.txt`, copied into a
  world-readable `system` home on every box. The desktop and the file browser
  are programs like any other; the shell only has the menu bar, dialogs,
  themes and the permissions windows.
- **Directory** (`directory/`, optional): a separate small server that lists
  boxes, so `/` and `/com` have something in them (section 3).

## 3. Names and discovery

- An address is `user@domain`. Their home is the domain reversed, then the user:
  `andrew@simplebox.com` lives at `/com/simplebox/andrew`. Every path is global.
- A box advertises itself at `https://<domain>/.well-known/simplebox`:
  `{ "simplebox": 1, "domain": "simplebox.com", "api": "https://simplebox.com/api", "prefix": "/com/simplebox", "key": "…" }`.
  The API may live on another host, but it must be `https` and on the domain or
  one of its subdomains. `key` is the box's public signing key (see sharing).
- **Finding the box for a path** is deterministic: for `/com/simplebox/andrew/x`,
  try `simplebox.com`, then `andrew.simplebox.com`, and so on. The first
  (shortest) domain that has a well-known file owns the path. Results are cached
  (1 hour when found, 10 minutes when not). A box's root (`/com/simplebox`) lists
  its users, like an old `/home`.
- **Above boxes** (`/`, `/com`) no box knows what's there, so a small separate
  **directory** server keeps a list of boxes. Boxes register with the directory
  in `BOX_DIRECTORY` when they start. The directory checks the domain's
  well-known file itself, so registering needs no proof, and it drops boxes that
  stop answering. Listing `/com` asks the directory (cached for a minute) and
  always includes the box itself. Nothing else depends on the directory: paths
  still find their box through well-known files, and anyone can run a directory.
- **Finding the box for an address** is exact, since the domain is given.
- The page (the computer) can be hosted anywhere, such as `simplebox.anb.codes`. At
  login it looks up the address's domain and then talks only to that box's API.

## 4. Storage on a box

- `DATA/<user>/` is that user's home: a plain folder of plain files, unencrypted
  at rest. Symlinks are real symlinks whose target is a global path, for example
  `Apps -> /com/simplebox/system`.
- `DATA/.box.sqlite` holds everything that isn't a file: users (password hashes),
  sessions, sharing lists, the box's signing key, recently seen request nonces,
  and the permissions users have granted to programs.
- Settings the user should keep across devices, such as the theme, are ordinary
  files in the home folder: `~/.box/settings.json`. Names starting with `.` are
  hidden from listings.
- **Moving boxes:** copy the files to the new box, then run
  `bun server/cli.ts moved andrew /com/newbox/andrew` on the old one. The old home
  is archived and becomes a symlink, so old paths and other people's links keep
  working, and logging in on the old box says where the account went.

## 5. The screen

- One canvas at 720x480 (270x480 when the viewport is portrait), scaled to fill
  the window and letterboxed. To stay sharp at any size it is first scaled up by a
  whole number (every pixel becomes an exact square) and then smoothly scaled down
  to the final size, so only pixel edges blend, by at most one device pixel. When
  the fit is a whole number the result is exact. A Full HD window shows it at
  about 2x.
- The desktop, menus, windows, dialogs and every program are drawn from the same
  flat element lists: `text`, `rect`, `line`, `button`, `input`, `bitmap` and `area`,
  all at absolute positions. There is no layout beyond word wrapping, because
  windows have fixed sizes.
- **Fonts:** a hand-drawn proportional pixel font (8px capitals, 6px x-height,
  12px line height), a bold version of it, and a monospaced variant for code. The font data is plain
  data shared with programs, so they can measure text.
- **Look:** warm paper colors by default, a dotted desktop, windows with rounded
  corners, a centered title over an accent line, and dithered drop shadows.
- **Interaction:** the OS draws hover highlights, menus and the dock, and does
  all text editing, including selection and the clipboard. On touch screens a
  long press is a right-click.
- **Menu bar:** the Box menu, then the name of whatever is in front, in bold, and
  its menus. Programs set theirs with `sys.ui.setMenus`; folder windows and the
  desktop show the file manager's (Files, File, Go). Right-click menus are
  separate: programs can attach one to any area.
- **Dock and minimizing:** a dock along the bottom lists every open window in the
  order it was opened. Clicking one brings it to the front, or minimizes it if it's
  already there. Windows also have a minimize button next to close.
- **Themes:** colors are names. *Role* colors (`panel`, `field`, `hover`, `text`,
  `dim`, `line`, `accent`, `accentText`, `desk`, `dots`, `shadow`) change with the
  theme (Paper, Mint, Night, Lagoon, Plum, Classic). *Hues* (`red`, `blue`, …) are the
  same in every theme. Because names are resolved when drawing, switching themes
  recolors everything at once, including programs that were already running.
- Windows can be moved and minimized, but not resized. The OS picks each program's window size
  from the sizes it declares: sizes shaped like the screen first, then the largest.

## 6. Programs and permissions

- A program is a `.js` or `.ts` file exporting `default function main(sys)` and
  optionally `sizes`, `title` and `icon`. It can import other files by relative
  or full path. When the program starts, the box bundles it and its imports
  (`Bun.build` over the virtual filesystem, read as the user) into one module.
  An import has to be in the program's folder, or shared with everyone, checked
  after following links. A program from someone else can't pull in your private
  files just by naming them.
- **System programs that are part of the OS.** `Desktop.ts`, `Files.ts` and
  `Terminal.ts` in the user's own box's `system` folder may use all of the user's
  files without asking. The file manager and the terminal can't work otherwise,
  and the admin controls that folder. Their other permissions (web, messages)
  are asked for like any program's.
- **Isolation.** Each program is a Web Worker loaded from `/worker.js`, which is
  served with `Content-Security-Policy: default-src 'none'; script-src blob:`. The
  browser therefore blocks all network access and loading any other code. The
  worker also removes `fetch`, XHR, WebSockets, IndexedDB and similar APIs before
  the program runs. The login token lives only on the main thread.
- **The `sys` API** is the program's only interface (see API.md). It is small and
  made for this system: `sys.fs.read(path)`, `sys.ui.button(...)`, and so on. It
  does not expose web APIs.
- **Permissions**, asked for the first time they're needed and remembered on the
  box per user and per program:
  - *Folder*, for read or read+change. A file the program was opened with needs no permission.
  - *Program*, to send another program messages.
  - *Web API origin.* Calls go straight from the browser: HTTPS only, no cookies,
    no referrer, and no redirects (a redirect could lead to an origin the user
    didn't approve). Only APIs that allow cross-origin calls (CORS) will answer,
    so programs can use APIs but can't scrape arbitrary websites. There is no
    server-side proxy. Programs can never call the user's own box directly.
- **Picking files.** `sys.fs.pick` shows the file picker (Files, run by the OS
  as a dialog). What the user picks, the program may use from then on. It's a
  normal grant for exactly that file or folder, so it shows up in the
  permissions window and can be revoked. That's the way for a program to get a
  file without asking for a whole folder. Only the picker the OS started can
  answer.
- **Dialogs** a program asks for (`sys.ui.prompt`) are titled with the program's
  name, so they can't pass for the OS asking.
- Box > Permissions… lists every grant for every program, each with a Revoke
  button. Right-clicking a program's title bar (or its dock button) shows the same
  for that one program.

## 7. Sharing

### 7.1 On one box

Each path can have a sharing list: who can read, and who can read and change. A
list applies to everything below that path. The nearest list up the tree decides,
and the owner always has full access. `*` means everyone, including anonymous
readers and other boxes.

### 7.2 Between boxes

**Trust model.** Like email: your home box is trusted with your data, and each
box is trusted to speak for its own users and no one else. Everything in between
is protected by HTTPS.

**How it works.** Each box has one Ed25519 key, made when it first starts, and
publishes the public half in its well-known file. When carol@b reads andrew's
file on box a, her box calls box a's ordinary file API with `Box-As: carol@b.test`
and a signature over the request (target box, method, path, query, time, a
single-use nonce and a hash of the body). Box a gets b.test's key from
`https://b.test/.well-known/simplebox`, checks the signature, and from then on
treats the request like one from a local user named `carol@b.test`. Sharing lists
are just addresses. Writing is the same request with a body.

**What this protects against**

| Threat | Result |
| --- | --- |
| Someone reading or changing traffic | HTTPS |
| Box b speaking for someone on another domain (andrew@a, x@c) | Refused: a box can only sign for its own domain, and a's own users must log in |
| Someone on box b other than carol (dave) | Can't read: sharing lists name carol, and box b only signs as whoever is logged in |
| Replaying a captured request | Refused: single-use nonce (stored in the db, so it survives restarts) plus a 5-minute window |
| Re-aiming a request (other path, other box, other body) | Refused: all of them are signed |
| A hostile `.well-known` pointing the box at an internal address (SSRF) | Refused: API must be https on the same domain; redirects aren't followed |

All of these were tested against two running boxes.

**What it doesn't protect against**

- Box b itself, for its users: it can act as any of them. That was already true
  with per-user keys, because the home box held their private keys.
- Whoever controls b.test's DNS and TLS certificate can pose as box b, the same
  way they could take over b.test's email or website.
- A TLS-terminating proxy or CDN in front of a box sees content in the clear. The
  previous design (content encrypted to each reader) protected against that;
  here you trust your CDN, as with any website.
- Revocation takes effect for future requests only.

**Why not per-user keys and encryption.** The earlier version had two key pairs
per user, key pinning, fingerprints, a separate federation API with its own
message format, and encryption code. It bought little: since the home box holds
its users' private keys, a hostile home box could impersonate them either way.
The one real gain was hiding content from a proxy or CDN between boxes, which
HTTPS already covers unless you put one there. It also made changing keys hard;
now a box changes its key by publishing a new one.

### 7.3 Links across boxes

When a path goes through a link to another box, the box only says where the link
points ("redirect") to someone allowed to read the link itself. The asking box
then follows the redirect itself, signing for its own user. Boxes never fetch for each
other, so no box ever acts with another box's user's identity. Chains are limited
to 8 hops.

## 8. Decisions to review

1. **No end-to-end encryption between boxes** (see 7.2): box-signed requests over
   HTTPS instead. Files are plain on disk, as before.
2. **Public (`*`) content can be read by anyone**, including other boxes, without signing.
3. **Write access means create or overwrite files.** Remote users can't delete,
   rename, make folders or links on another box. With the shared API this would
   now be easy to add: the same signed request to `fs/mkdir` and so on.
4. **Sharing with someone on another box checks only that their box exists**, not
   that the user does, like sending email.
5. **Shortest-domain-wins discovery** means a box at `simplebox.com` makes any
   box at `andrew.simplebox.com` unreachable by path. That's the rule you
   described; it's worth confirming that's intended.
6. **Programs keep the sizes they launched with.** Rotating a phone doesn't resize
   running programs; the OS only keeps windows on screen. (The desktop is the
   exception: it gets `onResize`.)
7. **Desktop, Files and Terminal are trusted with all your files** (6), by where
   they live. The alternative, an explicit "full access" grant, would ask a
   question nobody can meaningfully answer no to.
8. **Every box lists its users** at its root, to anyone, like `/home` on a shared
   Unix machine. Names only; what's inside still follows sharing.
9. **Imports are bundled at launch** rather than loaded at runtime. That keeps the
   worker's `script-src blob:` CSP and makes a program's code fixed once it runs.

## 9. Known gaps

- Text inputs have no undo yet.
- No quota, rate limiting, or maximum upload size beyond Bun's default.
- Nothing syncs live: folder windows re-list every 15 seconds, and right away for
  changes made through a program on the same computer.
- A program can call `import()` with a computed URL, but the worker's CSP blocks
  it; only static imports (bundled at launch) work.
- The terminal has no pipes, globs or scripts.
