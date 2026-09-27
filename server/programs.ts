/**
 * Turning a program file into the code a worker runs. Programs can import other
 * files, which are bundled in when the program starts:
 *
 *   import { grid } from "./lib/grid.ts";            // next to the program
 *   import { chart } from "/com/bob/bob/Public/chart.ts";  // shared with everyone
 *
 * An import has to be in the program's own folder (or below it), or readable by
 * everyone. Otherwise a program someone gave you could pull your private files
 * into itself just by naming them.
 */
import { posix } from "node:path";
import { HttpError } from "./errors";

/** A file as someone reads it: where it really is (after links) and what's in it. */
export type Source = { path: string; text: string };

export type Readers = {
  /** Read as the person running the program. */
  mine(virt: string): Promise<Source>;
  /** Read as the public: fails unless everyone may read it. */
  anyone(virt: string): Promise<Source>;
};

const within = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");
const loader = (p: string) => (p.endsWith(".js") ? "js" : "ts");

function target(spec: string, importer: string): string {
  let p: string;
  if (spec.startsWith("./") || spec.startsWith("../")) p = posix.join(posix.dirname(importer), spec);
  else if (spec.startsWith("/")) p = posix.normalize(spec);
  else throw new HttpError(422, `can't import "${spec}": imports are ./relative or /full/paths to .ts or .js files`);
  return /\.(ts|js)$/.test(p) ? p : p + ".ts";
}

export async function bundle(entry: string, read: Readers): Promise<{ path: string; code: string }> {
  const main = await read.mine(entry);
  const root = posix.dirname(main.path);
  /** What each file we've loaded really is: asked-for path -> source. */
  const loaded = new Map<string, Source>([[main.path, main]]);

  async function load(virt: string): Promise<Source> {
    const hit = loaded.get(virt);
    if (hit) return hit;
    let src: Source | null = null;
    if (within(virt, root)) {
      src = await read.mine(virt);
      // A link next to the program can point anywhere, so check where it landed too.
      if (!within(src.path, root)) src = null;
    }
    src ??= await read.anyone(virt).catch((e) => {
      throw new HttpError(422, `can't import ${virt}: it has to be next to the program or shared with everyone (${(e as Error).message})`);
    });
    loaded.set(virt, src);
    return src;
  }

  let failure: Error | null = null;
  const out = await Bun.build({
    entrypoints: [main.path],
    root: import.meta.dir, // unused, but Bun wants a real folder
    target: "browser",
    format: "esm",
    plugins: [{
      name: "box",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (!args.importer) return { path: args.path, namespace: "box" };
          const from = loaded.get(args.importer)?.path ?? args.importer;
          try {
            return { path: target(args.path, from), namespace: "box" };
          } catch (e) {
            failure ??= e as Error;
            throw e;
          }
        });
        b.onLoad({ filter: /.*/, namespace: "box" }, async (args) => {
          try {
            const src = await load(args.path);
            return { contents: src.text, loader: loader(src.path) };
          } catch (e) {
            failure ??= e as Error;
            throw e;
          }
        });
      },
    }],
  }).catch((e) => {
    if (failure) throw failure;
    throw new HttpError(422, `${main.path} doesn't compile:\n${buildMessage(e)}`);
  });
  if (!out.success) {
    if (failure) throw failure;
    throw new HttpError(422, `${main.path} doesn't compile:\n${buildMessage({ errors: out.logs })}`);
  }
  return { path: main.path, code: await out.outputs[0]!.text() };
}

type Log = { message?: string; position?: { file?: string; line?: number; column?: number } | null };

/** "Unexpected end of file (/com/box/you/Thing.ts line 3)" */
function buildMessage(e: unknown): string {
  const logs = (e as { errors?: Log[] })?.errors;
  if (!Array.isArray(logs) || !logs.length) return String((e as Error)?.message ?? e);
  return logs.map((l) => {
    const p = l.position;
    return p?.line ? `${l.message} (${p.file?.replace(/^box:/, "")} line ${p.line})` : String(l.message ?? l);
  }).join("\n");
}
