// The smallest useful program. File > New program starts you with something like this.
export const title = "Hello";
export const sizes = [[260, 110]];

export default function main(sys) {
  const { ui } = sys;
  let clicks = 0;
  function draw() {
    // Menus appear in the menu bar while this window is in front.
    sys.ui.setMenus([
      { label: "Clicks", items: [{ label: "Reset", onClick: () => { clicks = 0; draw(); }, disabled: !clicks }] },
    ]);
    ui.render([
      ui.text(10, 10, `Hello, ${sys.me}!`, { w: 240 }),
      ui.button(10, 32, 76, 18, "Click me", () => {
        clicks++;
        draw();
      }),
      ui.text(94, 36, `${clicks} clicks`, { color: "dim" }),
      ui.rect(10, 60, 240, 40, "accent"),
      ui.text(16, 66, "Colors follow your theme. Try Box > Theme...", { w: 228, color: "accentText" }),
    ]);
  }
  sys.ui.onTheme(draw);
  draw();
}
