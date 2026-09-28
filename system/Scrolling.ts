// Scroll groups: a list that snaps to lines, and a page of anything at all.
export const title = "Scrolling";
export const icon = "program";
export const sizes = [[480, 320], [270, 440]];

const WORDS = "apple river stone cloud maple ember quartz willow harbor lantern meadow orbit".split(" ");

export default function main(sys) {
  const { ui } = sys;
  const L = ui.lineHeight;
  const lines = Array.from({ length: 200 }, (_, i) =>
    `${String(i + 1).padStart(3)}  ${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]}`);
  let selected = -1;
  let listTop = 0;
  let pageTop = 0;
  let name = "";
  let clicks = 0;

  function draw() {
    const { w, h } = sys.size;
    const narrow = w < 400;
    // Side by side on a wide window, one above the other on a narrow one.
    // lw is the list's whole width, scroll bar included; rows get lw minus the bar.
    const lw = narrow ? w - 16 : 180;
    const rw = lw - ui.scrollBarWidth;
    const lh = narrow ? 150 : h - 70;
    const px = narrow ? 8 : 8 + lw + 8;
    const py = narrow ? 40 + lh + 28 : 40;
    const pw = w - px - 8;
    const ph = h - py - 28;
    const inner = pw - ui.scrollBarWidth - 16;

    const list = lines.map((line, i) => [
      i === selected && ui.rect(0, i * L, rw, L, "accent"),
      ui.area(0, i * L, rw, L, (e) => {
        if (e.type === "down") { selected = i; draw(); }
      }, { hover: i === selected ? undefined : "hover" }),
      ui.text(4, i * L + 2, line, { font: "mono", color: i === selected ? "accentText" : "text" }),
    ]);

    const para = "This side isn't snapped, and holds anything: wrapped text, buttons, an input, " +
      "bitmaps, and another scroll group inside it. Scroll with the wheel, drag the thumb, " +
      "or click above or below the thumb to go a page at a time.";
    const paraH = ui.wrap(para, inner).length * L;
    let y = 8;
    const page = [];
    page.push(ui.text(8, y, para, { w: inner }));
    y += paraH + 8;
    page.push(
      ui.button(8, y, 90, 18, "Click me", () => { clicks++; draw(); }),
      ui.text(106, y + 4, `${clicks} clicks`, { color: "dim" }),
    );
    y += 28;
    page.push(
      ui.text(8, y + 4, "Name"),
      ui.input(44, y, Math.min(140, inner - 36), 18, name, (v) => { name = v; draw(); }, { key: "name", placeholder: "Type here" }),
    );
    y += 28;
    const icons = Object.keys(ui.icons);
    icons.forEach((k, i) => page.push(ui.bitmap(8 + i * 22, y, 16, 16, 16, 16, ui.icons[k])));
    y += 26;
    page.push(ui.text(8, y, "A nested group, snapped to lines:", { color: "dim" }));
    y += 14;
    const nested = Array.from({ length: 30 }, (_, i) => ui.text(4, i * L + 2, `Nested line ${i + 1}`));
    page.push(
      ui.rect(7, y - 1, inner + 2, 5 * L + 2, null, "line"),
      ui.scroll(8, y, inner, 5 * L, nested, { key: "nested", snap: L }),
    );
    y += 5 * L + 10;
    // A strip of every hue, drawn with rects.
    const hues = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "gray"];
    for (let i = 0; i < 40; i++) page.push(ui.rect(8 + (i % 10) * 16, y + Math.floor(i / 10) * 16, 14, 14, hues[(i + Math.floor(i / 10)) % 10]));
    y += 4 * 16 + 8;
    page.push(ui.text(8, y, "The end.", { color: "dim" }));

    const sel = selected >= 0 ? `line ${selected + 1}` : "nothing";
    ui.render([
      ui.text(8, 8, "Scroll groups", { font: "bold" }),
      ui.text(8, 22, `list at ${listTop}px, page at ${pageTop}px, selected ${sel}`, { color: "dim", w: w - 16 }),
      ui.rect(7, 39, lw + 2, lh + 2, null, "line"),
      ui.scroll(8, 40, lw, lh, list, {
        key: "list", snap: L, onScroll: (v) => { listTop = v; draw(); },
      }),
      ui.button(8, 40 + lh + 6, 50, 18, "Top", () => ui.scrollTo("list", 0)),
      ui.button(62, 40 + lh + 6, 50, 18, "End", () => ui.scrollTo("list", lines.length * L)),
      ui.button(116, 40 + lh + 6, 60, 18, "Selected", () => ui.scrollTo("list", selected * L - Math.floor(lh / L / 2) * L), {
        disabled: selected < 0,
      }),
      ui.rect(px - 1, py - 1, pw + 2, ph + 2, null, "line"),
      ui.scroll(px, py, pw, ph, page, { key: "page", onScroll: (v) => { pageTop = v; draw(); } }),
      ui.text(px, py + ph + 8, "Anything under the group stays put.", { color: "dim" }),
    ]);
  }

  sys.ui.onTheme(draw);
  sys.ui.onResize(draw);
  draw();
}
