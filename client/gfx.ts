/** Pixel drawing on the one screen canvas. Everything is integer pixels. */
import { GLYPH_H, MONO_W, advance, glyphs, glyph, type Font } from "./font";
import { THEMES, palette, type Color, type Theme } from "./ui";

export class Gfx {
  ctx: CanvasRenderingContext2D;
  theme: Theme = THEMES[0]!;
  private colors = palette(this.theme);
  private atlases = new Map<string, { canvas: HTMLCanvasElement; x: Map<string, number> }>();
  private bitmaps = new WeakMap<Uint8ClampedArray, HTMLCanvasElement>();
  private patterns = new Map<string, CanvasPattern>();

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.colors = palette(theme);
  }

  /** A color name (or CSS color) as CSS. */
  col(c: Color | undefined, fallback = "text"): string {
    const name = c ?? fallback;
    return this.colors[name] ?? name;
  }

  fill(x: number, y: number, w: number, h: number, c?: Color) {
    this.ctx.fillStyle = this.col(c);
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  stroke(x: number, y: number, w: number, h: number, c?: Color) {
    this.fill(x, y, w, 1, c);
    this.fill(x, y + h - 1, w, 1, c);
    this.fill(x, y, 1, h, c);
    this.fill(x + w - 1, y, 1, h, c);
  }

  /** A rectangle with its corner pixels cut off. */
  round(x: number, y: number, w: number, h: number, fill?: Color, stroke?: Color) {
    if (fill) {
      this.fill(x + 1, y, w - 2, h, fill);
      this.fill(x, y + 1, 1, h - 2, fill);
      this.fill(x + w - 1, y + 1, 1, h - 2, fill);
    }
    if (stroke) {
      this.fill(x + 1, y, w - 2, 1, stroke);
      this.fill(x + 1, y + h - 1, w - 2, 1, stroke);
      this.fill(x, y + 1, 1, h - 2, stroke);
      this.fill(x + w - 1, y + 1, 1, h - 2, stroke);
    }
  }

  /** Every other pixel, in a checkerboard: the classic 50% dither. */
  dither(x: number, y: number, w: number, h: number, c?: Color) {
    const css = this.col(c, "shadow");
    let p = this.patterns.get(css);
    if (!p) {
      const t = document.createElement("canvas");
      t.width = t.height = 2;
      const tc = t.getContext("2d")!;
      tc.fillStyle = css;
      tc.fillRect(0, 0, 1, 1);
      tc.fillRect(1, 1, 1, 1);
      p = this.ctx.createPattern(t, "repeat")!;
      this.patterns.set(css, p);
    }
    this.ctx.fillStyle = p;
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  /** A dotted horizontal line. */
  dots(x: number, y: number, w: number, c?: Color) {
    this.ctx.fillStyle = this.col(c, "line");
    for (let i = 0; i < w; i += 2) this.ctx.fillRect(Math.round(x) + i, Math.round(y), 1, 1);
  }

  line(x1: number, y1: number, x2: number, y2: number, c?: Color) {
    this.ctx.fillStyle = this.col(c, "line");
    [x1, y1, x2, y2] = [x1, y1, x2, y2].map(Math.round) as [number, number, number, number];
    if (x1 === x2 || y1 === y2) {
      this.ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1) + 1, Math.abs(y2 - y1) + 1);
      return;
    }
    const dx = Math.abs(x2 - x1), dy = -Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.ctx.fillRect(x1, y1, 1, 1);
      if (x1 === x2 && y1 === y2) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x1 += sx; }
      if (e2 <= dx) { err += dx; y1 += sy; }
    }
  }

  /** Every glyph of a font drawn once in one color, in a single row. */
  private atlas(font: Font, css: string) {
    const key = `${font} ${css}`;
    let a = this.atlases.get(key);
    if (!a) {
      const all = [...glyphs[font].entries()];
      const canvas = document.createElement("canvas");
      canvas.width = all.reduce((n, [, g]) => n + g.w + 1, 0);
      canvas.height = GLYPH_H;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = css;
      const x = new Map<string, number>();
      let pos = 0;
      for (const [ch, g] of all) {
        x.set(ch, pos);
        g.rows.forEach((row, ry) => {
          for (let rx = 0; rx < row.length; rx++) if (row[rx] === "#") ctx.fillRect(pos + rx, ry, 1, 1);
        });
        pos += g.w + 1;
      }
      a = { canvas, x };
      this.atlases.set(key, a);
    }
    return a;
  }

  text(x: number, y: number, s: string, c?: Color, font: Font = "ui") {
    const a = this.atlas(font, this.col(c));
    x = Math.round(x);
    y = Math.round(y);
    for (const ch of s) {
      const g = glyph(ch, font);
      const known = a.x.has(ch) ? ch : ch === "\t" ? " " : "\u0000";
      const gx = a.x.get(known)!;
      const off = font === "mono" ? Math.floor((MONO_W - g.w) / 2) : 0;
      if (g.w) this.ctx.drawImage(a.canvas, gx, 0, g.w, GLYPH_H, x + off, y, g.w, GLYPH_H);
      x += advance(ch, font);
    }
  }

  bitmap(x: number, y: number, w: number, h: number, pw: number, ph: number, pixels: Uint8ClampedArray) {
    let c = this.bitmaps.get(pixels);
    if (!c) {
      c = document.createElement("canvas");
      c.width = pw;
      c.height = ph;
      if (pixels.length === pw * ph * 4) {
        c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), pw, ph), 0, 0);
      }
      this.bitmaps.set(pixels, c);
    }
    this.ctx.drawImage(c, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  /** Run `fn` with the origin moved to (x, y) and drawing clipped to w x h. */
  within(x: number, y: number, w: number, h: number, fn: () => void) {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.ctx.clip();
    this.ctx.translate(x, y);
    fn();
    this.ctx.restore();
  }

  clip(x: number, y: number, w: number, h: number, fn: () => void) {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.ctx.clip();
    fn();
    this.ctx.restore();
  }
}
