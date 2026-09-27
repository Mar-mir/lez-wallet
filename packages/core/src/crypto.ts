// Dual-licensed: MIT OR Apache-2.0
/**
 * Self-contained crypto helpers using WebCrypto (available in Node >= 18 and
 * in MV3 service workers). No native dependencies.
 */

const TEXT = new TextEncoder();

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const digest = await sha256(
    typeof data === "string" ? TEXT.encode(data) : data,
  );
  return bytesToHex(digest);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`invalid hex string: ${hex.slice(0, 24)}...`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function randomHex(n: number): string {
  return bytesToHex(randomBytes(n));
}

/** PBKDF2-HMAC-SHA256 => 32-byte key. */
export async function pbkdf2Key(
  password: string,
  salt: Uint8Array,
  iterations = 210_000,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    TEXT.encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** AES-GCM encrypt => { iv, ciphertext } (iv prepended to ciphertext). */
export async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return out;
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const iv = payload.subarray(0, 12);
  const ct = payload.subarray(12);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new Uint8Array(pt);
}

/** Constant-time string compare (defense against timing on small inputs). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = TEXT.encode(a);
  const bb = TEXT.encode(b);
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
