// Dual-licensed: MIT OR Apache-2.0
/**
 * Mnemonic generation/import (BIP-39, english) and per-account key derivation.
 *
 * - generateMnemonic / entropyToMnemonic / validateMnemonic are SYNC (pure JS
 *   SHA-256 implementation below) so they work in CLI and service workers.
 * - mnemonicToSeed is async (WebCrypto PBKDF2-HMAC-SHA512, BIP-39 spec).
 * - deriveAccountKeys is a synchronous HMAC chain over the BIP-39 seed.
 */
import { readFileSync } from "node:fs";
import { WalletError } from "./errors.js";

const WORDLIST = readFileSync(new URL("../data/english.txt", import.meta.url), "utf8")
  .split(/\r?\n/)
  .map((w) => w.trim())
  .filter(Boolean);

const WORD_INDEX = new Map(WORDLIST.map((w, i) => [w, i]));

export function wordlistSize(): number {
  return WORDLIST.length;
}

/** Generate a fresh BIP-39 mnemonic (12 or 24 words, default 12). */
export function generateMnemonic(words: 12 | 24 = 12): string {
  const entropyBits = (words * 11 * 32) / 33; // 128 or 256 bits
  const entropy = new Uint8Array(entropyBits / 8);
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy);
}

/**
 * BIP-39 64-byte hex seed from a validated mnemonic (+ optional passphrase):
 * PBKDF2-HMAC-SHA512(mnemonic, "mnemonic"+passphrase, 2048) -> 64 bytes.
 */
export async function mnemonicToSeed(mnemonic: string, passphrase = ""): Promise<string> {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ").normalize("NFKD");
  const salt = new TextEncoder().encode(`mnemonic${passphrase}`.normalize("NFKD"));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(words) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 2048, hash: "SHA-512" },
    baseKey,
    512,
  );
  return bytesToHex(new Uint8Array(bits));
}

export interface DerivedAccountKey {
  /** 32-byte hex account signing key material. */
  secretKey: string;
  /** 32-byte hex public account key (address for public accounts). */
  publicKey: string;
  /** 32-byte hex null path key — needed to send to this private account. */
  npk: string;
  /** 32-byte hex viewing key — needed to READ this private account's state. */
  vpk: string;
}

/**
 * Derive per-account key material from the BIP-39 seed via an HMAC-SHA256
 * counter chain over context "lez-wallet|<type>|<index>|<counter>", expanding
 * to 128 bytes: secretKey | publicKey | npk | vpk.
 */
export function deriveAccountKeys(
  seedHex: string,
  type: "public" | "private",
  index: number,
): DerivedAccountKey {
  const seed = hexToBytes(seedHex);
  const out = new Uint8Array(128);
  let material: Uint8Array = new Uint8Array(0);
  let counter = 0;
  while (material.length < 128) {
    const ctx = new TextEncoder().encode(`lez-wallet|${type}|${index}|${counter}`);
    material = concatBytes(material, hmacSha256Sync(seed, ctx));
    counter++;
  }
  out.set(material.subarray(0, 128));
  return {
    secretKey: bytesToHex(out.subarray(0, 32)),
    publicKey: bytesToHex(out.subarray(32, 64)),
    npk: bytesToHex(out.subarray(64, 96)),
    vpk: bytesToHex(out.subarray(96, 128)),
  };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new WalletError(`invalid hex string: ${hex.slice(0, 24)}...`, "invalid_input");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
/** Convert 16/32 bytes of entropy into a BIP-39 mnemonic (english). */
export function entropyToMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== 16 && entropy.length !== 32) {
    throw new WalletError("entropy must be 16 or 32 bytes", "invalid_input");
  }
  const digest = sha256Sync(entropy);
  return mnemonicFromBits(entropy, digest);
}

function mnemonicFromBits(entropy: Uint8Array, digest: Uint8Array): string {
  let bin = "";
  for (const b of entropy) bin += b.toString(2).padStart(8, "0");
  const checksumBits = bin.length / 32;
  let check = "";
  for (const b of digest) check += b.toString(2).padStart(8, "0");
  check = check.slice(0, checksumBits);
  const all = bin + check;
  const words: string[] = [];
  for (let i = 0; i < all.length / 11; i++) {
    words.push(WORDLIST[parseInt(all.slice(i * 11, i * 11 + 11), 2)]!);
  }
  return words.join(" ");
}

/** Validate a mnemonic (word list + checksum). Returns normalized words. */
export function validateMnemonic(mnemonic: string): string[] {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 12 && words.length !== 24) {
    throw new WalletError(
      `mnemonic must have 12 or 24 words (got ${words.length})`,
      "invalid_input",
    );
  }
  for (const w of words) {
    if (WORD_INDEX.get(w) === undefined) {
      throw new WalletError(`not a valid BIP-39 word: "${w}"`, "invalid_input");
    }
  }
  let all = "";
  for (const w of words) all += WORD_INDEX.get(w)!.toString(2).padStart(11, "0");
  const bin = all.slice(0, all.length - all.length / 33);
  const checksum = all.slice(all.length - all.length / 33);
  const entropy = new Uint8Array(bin.length / 8);
  for (let i = 0; i < bin.length / 8; i++) {
    entropy[i] = parseInt(bin.slice(i * 8, i * 8 + 8), 2);
  }
  const digest = sha256Sync(entropy);
  let check = "";
  for (const b of digest) check += b.toString(2).padStart(8, "0");
  check = check.slice(0, checksum.length);
  if (check !== checksum) {
    throw new WalletError("mnemonic checksum failed", "invalid_input");
  }
  return words;
}

// ---------------------------------------------------------------------------
// Pure-JS SHA-256 (FIPS-180-4) + HMAC — sync, environment-independent.
// Used for mnemonic checksum + key derivation so no async is required.
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Sync(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(data, 0);
  msg[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!;
    let e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0]! + a) | 0;
    H[1] = (H[1]! + b) | 0;
    H[2] = (H[2]! + c) | 0;
    H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0;
    H[5] = (H[5]! + f) | 0;
    H[6] = (H[6]! + g) | 0;
    H[7] = (H[7]! + h) | 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]!, false);
  return out;
}

export function hmacSha256Sync(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256Sync(key) : key;
  const inner = new Uint8Array(64 + msg.length);
  for (let i = 0; i < 64; i++) inner[i] = (k[i] ?? 0) ^ 0x36;
  inner.set(msg, 64);
  const innerHash = sha256Sync(inner);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) outer[i] = (k[i] ?? 0) ^ 0x5c;
  outer.set(innerHash, 64);
  return sha256Sync(outer);
}