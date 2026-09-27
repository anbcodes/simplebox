// The text editor. Opens whatever file the desktop hands it.
export const title = "Editor";
export const sizes = [[560, 380], [266, 430]];
export const icon = "file";

export default async function main(sys) {
  const { w, h } = sys.size;
  const { ui } = sys;
  let path: string | null = sys.args.file ?? null;
  let text = "";
  let saved = "";
  let status = "";

  if (path) {
    try {
      text = saved = await sys.fs.read(path);
    } catch (e) {
      status = e.message;
    }
  }

  const name = () => (path ? path.split("/").pop() : "Untitled");
  const isProgram = () => /\.(js|ts)$/.test(path ?? "");
  // Code gets the monospaced font; everything else the regular one.
  const font = () => (isProgram() || /\.(json|txt|md)$/.test(path ?? "") ? "mono" : "ui");

  // Other files: the user picks them, and that's what lets the Editor use them.
  async function open() {
    if (text !== saved && !(await sys.ui.confirm("Open", `Forget your changes to ${name()}?`, "Forget them"))) return;
    const picked = await sys.fs.pick({ mode: "open", write: true });
    if (!picked) return;
    try {
      text = saved = await sys.fs.read(picked);
      path = picked;
      status = "";
    } catch (e) {
      status = e.message;
    }
    draw();
  }

  async function saveAs() {
    const picked = await sys.fs.pick({ mode: "save", name: name() });
    if (!picked) return;
    path = picked;
    await save();
  }

  async function save() {
    if (!path) return saveAs();
    try {
      await sys.fs.write(path, text);
      saved = text;
      status = "Saved.";
    } catch (e) {
      status = e.message;
    }
    draw();
  }

  async function run() {
    await save();
    if (saved === text) sys.apps.open(path);
  }

  function draw() {
    const dirty = text !== saved;
    sys.setTitle(name() + (dirty ? " *" : ""));
    sys.ui.setMenus([
      {
        label: "File",
        items: [
          { label: "Open...", onClick: open, hint: "Ctrl+O" },
          { label: "Save", onClick: save, disabled: !dirty && !!path, hint: "Ctrl+S" },
          { label: "Save as...", onClick: saveAs },
          ...(isProgram() ? [{ label: "Save and run", onClick: run, hint: "Ctrl+R" }] : []),
          null,
          { label: "Revert to saved", onClick: () => { text = saved; draw(); }, disabled: !dirty },
        ],
      },
    ]);
    ui.render([
      ui.rect(0, 0, w, 23, "panel"),
      ui.button(3, 3, 48, 17, "Save", save, { disabled: !dirty }),
      isProgram() && ui.button(55, 3, 44, 17, "Run", run),
      ui.text(isProgram() ? 106 : 58, 7, status, { color: "dim" }),
      ui.line(0, 23, w, 23, "line"),
      ui.input(-1, 23, w + 2, h - 22, text, (v) => {
        text = v;
        status = "";
        draw();
      }, { multiline: true, font: font(), key: "text" }),
    ]);
  }

  sys.ui.onKey((k) => {
    if ((k.ctrl || k.meta) && k.key === "s") save();
    if ((k.ctrl || k.meta) && k.key === "o") open();
    if ((k.ctrl || k.meta) && k.key === "r" && isProgram()) run();
  });
  draw();
}
