/** Ed25519 signing (WebCrypto), used by boxes to vouch for their users' requests. */
/** Bytes backed by a plain ArrayBuffer (what WebCrypto wants). */
export type Bytes = Uint8Array<ArrayBuffer>;

const subtle = crypto.subtle;

export const b64 = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
export const unb64 = (s: string): Bytes => new Uint8Array(Buffer.from(s, "base64url"));
export const utf8 = (s: string): Bytes => new TextEncoder().encode(s) as Bytes;

/** Public half is raw base64url, private half pkcs8 base64url. */
export async function newSigningKey(): Promise<{ pub: string; priv: string }> {
  const k = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pub: b64(await subtle.exportKey("raw", k.publicKey)), priv: b64(await subtle.exportKey("pkcs8", k.privateKey)) };
}

export function isKey(k: unknown): k is string {
  return typeof k === "string" && /^[A-Za-z0-9_-]{43}$/.test(k); // 32 bytes
}

export async function sha256(data: Bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

export async function sign(priv: string, data: Bytes): Promise<string> {
  const key = await subtle.importKey("pkcs8", unb64(priv), { name: "Ed25519" }, false, ["sign"]);
  return b64(await subtle.sign("Ed25519", key, data));
}

export async function verify(pub: string, data: Bytes, sig: string): Promise<boolean> {
  try {
    const key = await subtle.importKey("raw", unb64(pub), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify("Ed25519", key, unb64(sig), data);
  } catch {
    return false;
  }
}
