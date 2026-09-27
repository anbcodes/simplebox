// The desktop: your home folder, drawn behind every window. The OS starts it
// when you log in (Box > Restart desktop starts it again).
import { Folder, dirname, type Action } from "./lib/folder.ts";

export const title = "Desktop";

export default function main(sys) {
  const { ui } = sys;
  const system = dirname(sys.self);
  const folder = new Folder(sys, sys.args.file ?? sys.home, { redraw: draw, labelBg: "panel" });
  let menus = "";

  function setMenus() {
    const go: Action[] = [
      { label: "Home", onClick: () => sys.apps.open(sys.home) },
      { label: "Apps", onClick: () => sys.apps.open(system) },
      { label: "Everything", onClick: () => sys.apps.open("/") },
      null,
      { label: "Terminal", onClick: () => sys.apps.open(`${system}/Terminal.ts`) },
    ];
    const list = [
      { label: "File", items: [...folder.folderActions(), null, ...folder.itemActions(folder.item)] },
      { label: "Go", items: go },
    ];
    // Only when something changed, so the menu bar doesn't redraw for nothing.
    const key = JSON.stringify(list.map((m) => m.items.map((i) => i && [i.label, i.disabled])));
    if (key === menus) return;
    menus = key;
    sys.ui.setMenus(list);
  }

  function draw() {
    const { w, h } = sys.size;
    const dots: unknown[] = [];
    for (let y = 11; y < h; y += 24) for (let x = 12; x < w; x += 24) dots.push(ui.rect(x, y, 1, 1, "dots"));
    setMenus();
    ui.render([ui.rect(0, 0, w, h, "desk"), dots, folder.render(0, 0, w, h)]);
  }

  ui.onKey((k) => folder.key(k));
  ui.onResize(draw);
  ui.onTheme(draw);
  sys.fs.onChange((dir) => dir === folder.dir && folder.load());
  setInterval(() => folder.load(), 15_000);
  draw();
  folder.load();
}
