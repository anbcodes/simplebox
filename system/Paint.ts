// A tiny paint program. Pictures are text files: a header line, then one hex digit per pixel.
export const title = "Paint";
export const sizes = [[420, 310], [266, 340]];
export const icon = "picture";

// Pictures shouldn't change when the theme does, so Paint has its own fixed colors.
const PALETTE = ["#1e1c24", "#5a5566", "#8e8a99", "#c9c5d1", "#fbfaf7", "#9c6b4e", "#e5534b", "#f0883e",
  "#f2c14e", "#b5d86b", "#57ab5a", "#2fb5a8", "#4a86e8", "#2e3f8f", "#9168d8", "#e27aa9"];
const WHITE = 4;

export default async function main(sys) {
  const { w, h } = sys.size;
  const { ui } = sys;
  const PW = 64, PH = 48;
  const scale = Math.floor(Math.min((w - 8) / PW, (h - 50) / PH));
  const ox = Math.floor((w - PW * scale) / 2), oy = 30;
  const rgb = PALETTE.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));

  let path = sys.args.file ?? "~/Drawing.paint";
  let pixels = new Uint8Array(PW * PH).fill(WHITE);
  let color = 0;
  let status = "";
  let last = null;

  if (sys.args.file) try {
    const [head, ...rows] = (await sys.fs.read(path)).split("\n");
    if (head.startsWith("PAINT")) {
      rows.slice(0, PH).forEach((row, y) => {
        for (let x = 0; x < PW; x++) pixels[y * PW + x] = parseInt(row[x] ?? "4", 16) || 0;
      });
    }
  } catch {}

  async function save() {
    const rows = [];
    for (let y = 0; y < PH; y++) {
      rows.push(Array.from(pixels.slice(y * PW, (y + 1) * PW), (v) => v.toString(16)).join(""));
    }
    try {
      await sys.fs.write(path, `PAINT ${PW} ${PH}\n` + rows.join("\n") + "\n");
      status = "Saved " + path.split("/").pop();
    } catch (e) {
      status = e.message;
    }
    draw();
  }

  function plot(x, y) {
    const px = Math.floor(x / scale), py = Math.floor(y / scale);
    const pts = [[px, py]];
    if (last) {
      const n = Math.max(Math.abs(px - last[0]), Math.abs(py - last[1]));
      for (let i = 1; i < n; i++) {
        pts.push([Math.round(last[0] + ((px - last[0]) * i) / n), Math.round(last[1] + ((py - last[1]) * i) / n)]);
      }
    }
    for (const [x, y] of pts) if (x >= 0 && y >= 0 && x < PW && y < PH) pixels[y * PW + x] = color;
    last = [px, py];
    draw();
  }

  // Only send the menus when they change (draw runs on every brush stroke).
  let menuColor = -1;
  function menus() {
    if (menuColor === color) return;
    menuColor = color;
    sys.ui.setMenus([
      {
        label: "File",
        items: [
          { label: "Save", onClick: save, hint: "Ctrl+S" },
          null,
          { label: "Clear", onClick: () => { pixels.fill(WHITE); draw(); } },
        ],
      },
      {
        label: "Color",
        items: ["Black", "Dark gray", "Gray", "Light gray", "White", "Brown", "Red", "Orange", "Yellow", "Lime",
          "Green", "Teal", "Blue", "Navy", "Purple", "Pink"].map((label, i) => ({
          label: (i === color ? "> " : "   ") + label,
          onClick: () => { color = i; draw(); },
        })),
      },
    ]);
  }

  function draw() {
    menus();
    const rgba = new Uint8ClampedArray(PW * PH * 4);
    pixels.forEach((v, i) => {
      rgba.set(rgb[v], i * 4);
      rgba[i * 4 + 3] = 255;
    });
    const sw = Math.min(14, Math.floor((w - 60) / 16));
    ui.render([
      ui.rect(0, 0, w, h, "panel"),
      PALETTE.map((c, i) => [
        ui.rect(4 + i * sw, 4, sw - 2, 18, c, "line"),
        i === color && ui.rect(5 + i * sw, 5, sw - 4, 16, undefined, "accent"),
        ui.area(4 + i * sw, 4, sw - 2, 18, (e) => {
          if (e.type === "down") {
            color = i;
            draw();
          }
        }),
      ]),
      ui.button(w - 50, 4, 46, 18, "Save", save),
      ui.rect(ox - 1, oy - 1, PW * scale + 2, PH * scale + 2, undefined, "line"),
      ui.bitmap(ox, oy, PW * scale, PH * scale, PW, PH, rgba),
      ui.area(ox, oy, PW * scale, PH * scale, (e) => {
        if (e.type === "down") { last = null; plot(e.x, e.y); }
        else if (e.type === "move") plot(e.x, e.y);
        else if (e.type === "up") last = null;
      }),
      ui.text(4, h - 13, status || path, { color: "dim" }),
    ]);
  }
  sys.ui.onKey((k) => {
    if ((k.ctrl || k.meta) && k.key === "s") save();
  });
  draw();
}
