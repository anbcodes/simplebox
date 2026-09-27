/** Talks to the user's box. Only the OS (main thread) ever holds the token. */

/** `api` is the base URL of the user's box API, e.g. `https://simplebox.com/api`. */
export type Session = { api: string; token: string; address: string; home: string; prefix: string };
export type Entry = { name: string; type: "file" | "dir" | "link"; size: number; mtime: number; target?: string };
export type Grant = { id: number; app: string; kind: "folder" | "app" | "net"; target: string; access: string };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type BoxInfo = { simplebox: number; domain: string; api: string; prefix: string };

/**
 * Find the box for a domain: `https://<domain>/.well-known/simplebox` says where
 * its API is. (This page's own origin is asked first, which is what makes
 * `you@localhost` work in development.)
 */
export async function discover(domain: string): Promise<BoxInfo> {
  for (const origin of [location.origin, `https://${domain}`]) {
    try {
      const info = (await (await fetch(`${origin}/.well-known/simplebox`)).json()) as BoxInfo;
      if (info.domain === domain && /^https?:\/\//.test(info.api)) return info;
    } catch {}
  }
  throw new ApiError(404, `can't find a box for ${domain}`);
}

export class Api {
  constructor(public s: Session) {}

  private async req(method: string, path: string, opts: { query?: Record<string, string>; json?: unknown; body?: BodyInit } = {}) {
    const url = new URL(`${this.s.api}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${this.s.token}` };
    let body = opts.body;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {}
      throw new ApiError(res.status, msg);
    }
    return res;
  }

  get = async <T = any>(path: string, query?: Record<string, string>): Promise<T> =>
    (await this.req("GET", path, { query })).json();
  post = async <T = any>(path: string, json: unknown): Promise<T> => (await this.req("POST", path, { json })).json();

  list = (path: string) => this.get<{ path: string; entries: Entry[] }>("fs/list", { path });
  stat = (path: string) => this.get<{ path: string; type: "file" | "dir"; size: number }>("fs/stat", { path });
  readBytes = async (path: string) => new Uint8Array(await (await this.req("GET", "fs/read", { query: { path } })).arrayBuffer());
  readText = async (path: string) => (await this.req("GET", "fs/read", { query: { path } })).text();
  write = async (path: string, data: string | Uint8Array) => {
    await this.req("PUT", "fs/write", { query: { path }, body: data as BodyInit });
  };
  mkdir = (path: string) => this.post("fs/mkdir", { path });
  remove = (path: string) => this.post("fs/remove", { path });
  rename = (from: string, to: string) => this.post("fs/rename", { from, to });
  link = (path: string, target: string) => this.post("fs/link", { path, target });
  program = (path: string) => this.get<{ path: string; code: string }>("program", { path });
  grants = () => this.get<Grant[]>("grants");
  grant = (g: Omit<Grant, "id">) => this.post("grants", g);
  revoke = async (id: number) => {
    await this.req("DELETE", "grants", { query: { id: String(id) } });
  };
}
