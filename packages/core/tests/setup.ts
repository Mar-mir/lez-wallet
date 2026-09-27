// Dual-licensed: MIT OR Apache-2.0
/**
 * Vitest on Node 18 runs test modules inside a VM sandbox where the
 * `crypto` global (Web Crypto) is not copied over, even though plain
 * Node >= 18 exposes `globalThis.crypto`. This setup file injects the
 * `node:crypto` webcrypto implementation into the sandbox global so the
 * production code can keep using the standard Web Crypto API unchanged.
 */
import { webcrypto } from "node:crypto";

const g = globalThis as { crypto?: Crypto };
if (!g.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
