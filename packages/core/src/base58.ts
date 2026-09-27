// Dual-licensed: MIT OR Apache-2.0
/** Base58 (bitcoin alphabet) + 32-byte account id helpers for LEZ. */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) MAP[ALPHABET[i]!] = i;

export function base58Encode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function base58Decode(str: string): Uint8Array {
  if (!str) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (const ch of str) {
    const val = MAP[ch];
    if (val === undefined) throw new Error(`invalid base58 character: ${ch}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

export function base58ToHex(str: string): string {
  const bytes = base58Decode(str);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBase58(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return base58Encode(bytes);
}

export function isBase58(s: string): boolean {
  if (!s) return false;
  for (const ch of s) if (MAP[ch] === undefined) return false;
  return true;
}

/**
 * Truncate a long id for display: keep head and tail, elide the middle.
 * "abc...xyz"
 */
export function truncateMiddle(s: string, head = 8, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}
