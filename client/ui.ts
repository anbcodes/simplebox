/**
 * The UI library shared by the OS shell and every program. A UI is just a flat
 * list of elements with absolute (window-local) pixel positions. There is no
 * layout: windows have fixed sizes, so you place things where you want them.
 *
 * This file must not touch the DOM: it also runs inside program workers.
 */
import { LINE_H, measure, type Font } from "./font";

export { LINE_H, measure, type Font };

/**
 * Colors are names. Role colors follow the user's theme; the hues are the same
 * in every theme. Programs may use any CSS color, but please don't.
 */
export const HUES = {
  red: "#e5534b",
  orange: "#f0883e",
  yellow: "#f2c14e",
  green: "#57ab5a",
  teal: "#2fb5a8",
  blue: "#4a86e8",
  purple: "#9168d8",
  pink: "#e27aa9",
  brown: "#9c6b4e",
  black: "#1e1c24",
  gray: "#8e8a99",
  white: "#fbfaf7",
};

export type Roles = {
  /** Behind everything: the desktop. */
  desk: string;
  /** The dot grid on the desktop. */
  dots: string;
  /** Window backgrounds. */
  panel: string;
  /** Text fields and buttons. */
  field: string;
  /** What the pointer is over. */
  hover: string;
  text: string;
  /** Secondary text. */
  dim: string;
  /** Borders and outlines. */
  line: string;
  /** Selection, pressed buttons, highlights. */
  accent: string;
  /** Text drawn on top of `accent`. */
  accentText: string;
  shadow: string;
};

export type Theme = { name: string } & Roles;

export const THEMES: Theme[] = [
  {
    name: "Paper", desk: "#d9cdb3", dots: "#a89a7e", panel: "#f4ecda", field: "#fbf7ee", hover: "#e9dec6",
    text: "#2e2924", dim: "#978b78", line: "#3b342d", accent: "#e0652f", accentText: "#fff8ee", shadow: "#3b342d",
  },
  {
    name: "Mint", desk: "#a9c4b6", dots: "#86a595", panel: "#fbf8f1", field: "#ffffff", hover: "#e8f0ea",
    text: "#26232b", dim: "#8a8391", line: "#26232b", accent: "#e76f51", accentText: "#ffffff", shadow: "#26232b",
  },
  {
    name: "Night", desk: "#232838", dots: "#353c52", panel: "#2e3447", field: "#1c2030", hover: "#3a4259",
    text: "#e6e3f0", dim: "#8c93ad", line: "#0f121b", accent: "#8fb8ff", accentText: "#101420", shadow: "#0b0d14",
  },
  {
    name: "Lagoon", desk: "#4f9da6", dots: "#3f8891", panel: "#f2f7f5", field: "#ffffff", hover: "#dcebe7",
    text: "#1d3140", dim: "#6f8a96", line: "#1d3140", accent: "#ff9f68", accentText: "#1d3140", shadow: "#1d3140",
  },
  {
    name: "Plum", desk: "#5b4a72", dots: "#6d5a86", panel: "#fdf6ec", field: "#fffdf8", hover: "#f3e6d3",
    text: "#35283f", dim: "#8f7f96", line: "#35283f", accent: "#f2a541", accentText: "#35283f", shadow: "#2a1f33",
  },
  {
    name: "Classic", desk: "#b4b4b4", dots: "#8f8f8f", panel: "#ffffff", field: "#ffffff", hover: "#e4e4e4",
    text: "#000000", dim: "#7a7a7a", line: "#000000", accent: "#000000", accentText: "#ffffff", shadow: "#000000",
  },
];

/** Every color name, resolved for a theme. */
export function palette(theme: Theme): Record<string, string> {
  const { name, ...roles } = theme;
  return { ...HUES, ...roles };
}

export type Color = keyof Roles | keyof typeof HUES | (string & {});

/** `menu` is a right-click (or a long press), sent just before the area's menu opens. */
export type PointerEvent = { type: "down" | "move" | "up" | "wheel" | "menu"; x: number; y: number; dy?: number };
/** A menu entry: a label, or a label with options (`hint` is shown on the right, e.g. "Ctrl+S"), or null for a separator. */
export type MenuItem = string | { label: string; disabled?: boolean; hint?: string } | null;
export type KeyEvent = { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };

/**
 * How the OS talks back to an element: ('click') | ('change', value) |
 * ('submit', value) | ('pointer', PointerEvent) | ('menu', index of the picked item)
 */
export type On = (kind: string, data?: any) => void;

type Base = { x: number; y: number; id?: string; key?: string; on?: On };
export type El =
  | (Base & { t: "rect"; w: number; h: number; fill?: Color; stroke?: Color })
  | (Base & { t: "text"; text: string; color?: Color; w?: number; bg?: Color; align?: "left" | "center" | "right"; font?: Font })
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; color?: Color; id?: string; key?: string; on?: On }
  | (Base & { t: "button"; w: number; h: number; text: string; disabled?: boolean; primary?: boolean })
  | (Base & {
      t: "input"; w: number; h: number; value: string; multiline?: boolean; password?: boolean;
      placeholder?: string; readonly?: boolean; font?: Font;
    })
  | (Base & { t: "bitmap"; w: number; h: number; pw: number; ph: number; pixels: Uint8ClampedArray })
  | (Base & { t: "area"; w: number; h: number; hover?: Color; menu?: MenuItem[] });

export type Els = (El | false | null | undefined | Els)[];

export function flatten(els: Els, out: El[] = []): El[] {
  for (const e of els) {
    if (Array.isArray(e)) flatten(e, out);
    else if (e) out.push(e);
  }
  return out;
}

type TextOpts = { color?: Color; w?: number; bg?: Color; align?: "left" | "center" | "right"; font?: Font; key?: string };
type InputOpts = {
  multiline?: boolean; password?: boolean; placeholder?: string; readonly?: boolean; font?: Font;
  onSubmit?: (value: string) => void; key?: string;
};

/** Element constructors. Everything takes plain callbacks. */
export const ui = {
  rect: (x: number, y: number, w: number, h: number, fill?: Color, stroke?: Color): El =>
    ({ t: "rect", x, y, w, h, fill, stroke }),

  text: (x: number, y: number, text: string, opts: TextOpts = {}): El =>
    ({ t: "text", x, y, text: String(text), ...opts }),

  line: (x1: number, y1: number, x2: number, y2: number, color?: Color): El =>
    ({ t: "line", x1, y1, x2, y2, color }),

  /** `primary` is the button Enter would press: drawn in the accent color. */
  button: (x: number, y: number, w: number, h: number, text: string, onClick?: () => void, opts: { key?: string; disabled?: boolean; primary?: boolean } = {}): El =>
    ({ t: "button", x, y, w, h, text, ...opts, on: (k) => k === "click" && onClick?.() }),

  input: (x: number, y: number, w: number, h: number, value: string, onChange?: (value: string) => void, opts: InputOpts = {}): El => {
    const { onSubmit, ...rest } = opts;
    return {
      t: "input", x, y, w, h, value, ...rest,
      on: (k, v) => (k === "change" ? onChange?.(v) : k === "submit" ? onSubmit?.(v) : undefined),
    };
  },

  /** `pixels` is RGBA, pw*ph*4 bytes, stretched to w x h. */
  bitmap: (x: number, y: number, w: number, h: number, pw: number, ph: number, pixels: Uint8ClampedArray): El =>
    ({ t: "bitmap", x, y, w, h, pw, ph, pixels }),

  /**
   * An invisible region that receives pointer events in local coordinates.
   * `hover` fills it with a color while the pointer is over it (put it before what
   * it should be behind). `menu` is shown on right-click; `onMenu` gets the index.
   */
  area: (
    x: number, y: number, w: number, h: number, onPointer: (e: PointerEvent) => void,
    opts: { key?: string; hover?: Color; menu?: MenuItem[]; onMenu?: (index: number) => void } = {},
  ): El => {
    const { onMenu, ...rest } = opts;
    return { t: "area", x, y, w, h, ...rest, on: (k, e) => (k === "pointer" ? onPointer(e) : k === "menu" ? onMenu?.(e) : undefined) };
  },
};

/** Word-wrap text to a width in pixels. */
export function wrap(text: string, width: number, font: Font = "ui"): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (measure(line + word, font) <= width) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (line.length > 1 && measure(line, font) > width) {
        let n = line.length - 1;
        while (n > 1 && measure(line.slice(0, n), font) > width) n--;
        out.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Cut text to fit a width, ending in "..". */
export function fit(text: string, width: number, font: Font = "ui"): string {
  if (measure(text, font) <= width) return text;
  let n = text.length;
  while (n > 0 && measure(text.slice(0, n) + "..", font) > width) n--;
  return text.slice(0, n) + "..";
}
