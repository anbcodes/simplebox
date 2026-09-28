# The Shared Computer

An implementation of [DESIGN.md](DESIGN.md): a shared, old-Unix-style computer in the browser,
with home folders on federated "boxes" and sharing between them.

```bash
bun install
bun run dev        # http://localhost:3000, sign up as you@localhost
```

- [docs/DESIGN-OVERVIEW.md](docs/DESIGN-OVERVIEW.md): how it works, the security model, and decisions to review
- [docs/API.md](docs/API.md): the program API, the box HTTP API, and the box-to-box protocol
- [system/API.txt](system/API.txt): the cheat sheet for writing programs, also visible in the OS under Apps

## Layout

| Path | What |
| --- | --- |
| `server/index.ts` | Bun server: routes, the bundled client, CORS |
| `server/vfs.ts` | Global paths, symlink resolution, sharing lists |
| `server/discovery.ts` | Finding boxes through `/.well-known/simplebox`, the box's own key |
| `server/fed.ts` | Box-to-box requests: signing them, and checking signed ones |
| `server/programs.ts` | Bundling a program with its imports |
| `server/tree.ts` | The folders outside homes: the box's root, and `/`, `/com` from the directory |
| `server/crypto.ts` | Ed25519 helpers (WebCrypto) |
| `server/db.ts` | The one metadata db, `DATA/.box.sqlite` |
| `server/cli.ts` | Admin: `moved`, `passwd` |
| `client/screen.ts` | The 720x480 canvas, window manager and input |
| `client/ui.ts`, `client/font.ts` | UI elements, themes and the pixel font, shared with programs |
| `client/shell.ts` | Login, the menu bar, dialogs, themes, permissions |
| `client/procs.ts` | Running programs and checking their permissions |
| `client/worker.ts` | The sandbox each program runs in, and `sys` |
| `system/` | Built-in programs: Desktop and Files (the desktop and file browser), Terminal, Editor, Paint, Weather, Hello, Scrolling (a demo of scroll groups) |
| `directory/index.ts` | The directory: a separate server that lists boxes, for `/` and `/com` |

## Configuration

| Env | Default | |
| --- | --- | --- |
| `BOX_DOMAIN` | `localhost` | e.g. `simplebox.anb.codes`; homes are then `/codes/anb/simplebox/<user>` |
| `BOX_PUBLIC_URL` | `http://localhost:$PORT` | Where this box is reachable; its API is advertised as `$BOX_PUBLIC_URL/api` |
| `PORT` | `3000` | |
| `BOX_DATA` | `./data` | |
| `BOX_PEERS` | | `domain=origin,...` for finding other boxes' well-known files during local testing |
| `BOX_SIGNUP` | on | `off` to close signups |
| `BOX_DIRECTORY` | | A directory server (e.g. `https://dir.anb.codes`) to register with and to list `/` and `/com` from |
| `BOX_HOST` | `0.0.0.0` | What to listen on |

In production the domain must serve `/.well-known/simplebox` over HTTPS. That's
automatic if the box itself is reachable at `https://$BOX_DOMAIN`.

## Trying two boxes locally

```bash
BOX_DOMAIN=a.test PORT=3101 BOX_PUBLIC_URL=http://localhost:3101 BOX_DATA=./data-a BOX_PEERS=b.test=http://localhost:3102 BOX_DIRECTORY=http://localhost:3500 bun server/index.ts
```

```bash
BOX_DOMAIN=b.test PORT=3102 BOX_PUBLIC_URL=http://localhost:3102 BOX_DATA=./data-b BOX_PEERS=a.test=http://localhost:3101 BOX_DIRECTORY=http://localhost:3500 bun server/index.ts
```

And a directory, so `ls /` in the Terminal shows both (optional):

```bash
DIR_PORT=3500 DIR_PEERS=a.test=http://localhost:3101,b.test=http://localhost:3102 bun directory/index.ts
```

(`.claude/launch.json` has all three.)

Sign up as `andrew@a.test` at http://localhost:3101 and as `carol@b.test` at
http://localhost:3102. Share a file with the other person (File > Share...),
and have them make a link to it (File > New link..., e.g. `/test/a/andrew/notes.txt`).

## The anb.codes deployment

| Piece | Where | How |
| --- | --- | --- |
| The box | this computer, `127.0.0.1:7430`, data in `~/storage/simplebox-data` | systemd `simplebox.service` ([deploy/simplebox.service](deploy/simplebox.service), settings in [deploy/anb.codes.env](deploy/anb.codes.env)) |
| `https://box.anb.codes` | Cloudflare Tunnel `simplebox` to the box | systemd `simplebox-tunnel.service`, config [deploy/cloudflared.yml](deploy/cloudflared.yml) |
| `https://anb.codes/.well-known/simplebox` | the anb.codes site on Vercel (`public/.well-known/simplebox` + `vercel.json`) | contains the box's public key: update it if the box's key ever changes |
| `https://simplebox.anb.codes` | Cloudflare Worker `simplebox` serving static files | [wrangler.jsonc](wrangler.jsonc) |
| `https://dir.anb.codes` | the directory of boxes, `127.0.0.1:7431`, data in `~/storage/simplebox-directory`, through the same tunnel | systemd `simplebox-directory.service` ([deploy/simplebox-directory.service](deploy/simplebox-directory.service)) |

Signups are off. Accounts are made on this computer:

```bash
bun --env-file=deploy/anb.codes.env server/cli.ts adduser andrew
```

After changing the code, restart the box (it runs straight from this folder):

```bash
sudo systemctl restart simplebox simplebox-directory
```

After changing the client, redeploy the web app:

```bash
bun run build:web anb.codes && npx wrangler deploy
```
