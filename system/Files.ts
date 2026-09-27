// Files: look through folders, yours or anyone's, on any box. "/" has every box
// the directory knows about.
//
// The OS also uses Files to ask you for a file when a program wants one
// (sys.fs.pick). Then sys.args.pick says what to ask for.
import { Folder, basename, dirname, join, pretty, type Item } from "./lib/folder.ts";

export const title = "Files";
export const sizes = [[432, 270], [266, 330]];
// The icon in the dock: folder, file, program or picture.
export const icon = "folder";

export default function main(sys) {
  const { ui } = sys;
  const { w, h } = sys.size;
  const pick = sys.args.pick; // { mode: "open" | "save" | "folder", name, write }
  const back: string[] = [];
  let typed: string | null = null; // the path box, while you're editing it
  let name = pick?.name ?? "";
  let menus = "";

  const folder = new Folder(sys, sys.args.file ?? sys.home, {
    redraw: draw,
    readonly: !!pick,
    open: (i: Item) => {
      if (folder.isFolder(i)) go(i.path);
      else if (pick?.mode === "open") done(i.path);
      else if (pick?.mode === "save") choose(i.name);
      else folder.attempt(() => sys.apps.open(i.path));
    },
  });

  function go(dir: string, remember = true) {
    if (remember && dir !== folder.dir) back.push(folder.dir);
    typed = null;
    folder.cd(dir);
  }

  const up = () => folder.dir !== "/" && go(dirname(folder.dir));
  const where = () => pretty(folder.dir, sys.home);

  // ---- Picking -------------------------------------------------------------------

  const done = (path: string | null) => sys.fs.picked(path);

  async function choose(file?: string) {
    if (!pick) return;
    if (pick.mode === "folder") return done(folder.item && folder.isFolder(folder.item) ? folder.item.path : folder.dir);
    if (pick.mode === "open") {
      const i = folder.item;
      if (i && !folder.isFolder(i)) done(i.path);
      return;
    }
    const n = (file ?? name).trim();
    if (!n) return;
    const exists = folder.items?.some((i) => i.name === n);
    if (exists && !(await ui.confirm("Replace", `${n} is already there. Replace it?`, "Replace"))) return;
    done(join(folder.dir, n));
  }

  const okLabel = () => (pick?.mode === "save" ? "Save" : pick?.mode === "folder" ? "Choose folder" : "Open");
  const canChoose = () =>
    pick?.mode === "folder" ? true : pick?.mode === "save" ? !!name.trim() : !!folder.item && !folder.isFolder(folder.item);

  // ---- Drawing ------------------------------------------------------------------

  function setMenus() {
    if (pick) return;
    const list = [
      { label: "File", items: [...folder.folderActions(), null, ...folder.itemActions(folder.item)] },
      {
        label: "Go",
        items: [
          { label: "Back", onClick: () => back.length && go(back.pop()!, false), disabled: !back.length },
          { label: "Up", onClick: up, disabled: folder.dir === "/" },
          null,
          { label: "Home", onClick: () => go(sys.home) },
          { label: "Apps", onClick: () => go(dirname(sys.self)) },
          { label: "Everything", onClick: () => go("/") },
          null,
          { label: "Terminal", onClick: () => sys.apps.open(`${dirname(sys.self)}/Terminal.ts`) },
        ],
      },
    ];
    const key = JSON.stringify(list.map((m) => m.items.map((i) => i && [i.label, i.disabled])));
    if (key === menus) return;
    menus = key;
    sys.ui.setMenus(list);
  }

  function draw() {
    sys.setTitle(pick ? (pick.mode === "save" ? "Save as" : pick.mode === "folder" ? "Choose a folder" : "Open") : basename(folder.dir) || "/");
    setMenus();
    const bottom = pick ? 30 : 16;
    const count = folder.items ? `${folder.items.length} items` : "";
    ui.render([
      // Toolbar: back, up, and the path, which you can type into.
      ui.rect(0, 0, w, 24, "panel"),
      ui.button(3, 3, 22, 18, "<", () => back.length && go(back.pop()!, false), { disabled: !back.length }),
      ui.button(27, 3, 22, 18, "^", up, { disabled: folder.dir === "/" }),
      ui.input(53, 3, w - 56, 18, typed ?? where(), (v) => (typed = v), {
        key: "path",
        onSubmit: (v) => {
          const p = v.trim();
          if (!p) return;
          go(p === "~" || p.startsWith("~/") ? sys.home + p.slice(1) : p.startsWith("/") ? p : join(folder.dir, p));
        },
      }),
      ui.line(0, 24, w, 24, "line"),
      folder.render(0, 25, w, h - 25 - bottom),
      ui.rect(0, h - bottom, w, bottom, "panel"),
      ui.line(0, h - bottom, w, h - bottom, "hover"),
      pick
        ? [
          pick.mode === "save" && ui.input(6, h - 25, w - 190, 20, name, (v) => { name = v; draw(); }, {
            key: "name", placeholder: "Name", onSubmit: () => choose(),
          }),
          pick.mode !== "save" && ui.text(6, h - 19, ui.fit(count, w - 196), { color: "dim" }),
          ui.button(w - 178, h - 25, 58, 20, "Cancel", () => done(null)),
          ui.button(w - 114, h - 25, 108, 20, okLabel(), () => choose(), { primary: true, disabled: !canChoose() }),
        ]
        : ui.text(6, h - 12, ui.fit(`${where()}  (${count})`, w - 12), { color: "dim" }),
    ]);
  }

  ui.onKey((k) => {
    if (k.key === "Escape" && pick) return done(null);
    if (k.key === "Backspace" && (k.alt || k.meta)) return up();
    if (k.key === "Enter" && pick && canChoose() && !(folder.item && folder.isFolder(folder.item))) return choose();
    folder.key(k);
  });
  sys.fs.onChange((dir) => dir === folder.dir && folder.load());
  setInterval(() => folder.load(), 15_000);
  draw();
  folder.load().then(() => pick?.mode === "save" && ui.focus("name"));
}
