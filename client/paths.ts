/** Path helpers. Paths are global (`/com/simplebox/andrew/x.txt`); `~` is your home. */

export function normalize(p: string, home: string): string {
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  else if (!p.startsWith("/")) p = home + "/" + p;
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const join = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;
export const ext = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i).toLowerCase() : "";
};

/** Is `p` the folder `dir` or inside it? */
export const within = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/");

/** Show paths in your own home as `~/...`. */
export const pretty = (p: string, home: string) => (within(p, home) ? "~" + p.slice(home.length) : p);

export const isProgram = (p: string) => /\.(js|ts)$/i.test(p);
