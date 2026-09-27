// Dual-licensed: MIT OR Apache-2.0
/**
 * @lez/core — keys, vault, store, backends, accounts, assets, tx, approval,
 * and the LP-0021 WalletProvider SDK. Everything the CLI, extension and
 * mini-apps need; no package may reach past this surface into src internals.
 */

// errors + shared types
export * from "./errors.js";
export * from "./types.js";

// crypto primitives + BIP-39 keys (bytesToHex/hexToBytes come from crypto.js
// only — keys.js keeps private copies of those two helpers)
export * from "./crypto.js";
export * from "./base58.js";
export {
  wordlistSize,
  generateMnemonic,
  mnemonicToSeed,
  deriveAccountKeys,
  entropyToMnemonic,
  validateMnemonic,
  type DerivedAccountKey,
} from "./keys.js";

// persistence
export * from "./vault.js";
export * from "./store.js";

// backends
export * from "./backend.js";
export { MockBackend } from "./mock-backend.js";
export { CliBackend, type CliBackendOptions } from "./cli-backend.js";

// domain services
export * from "./assets.js";
export * from "./accounts.js";
export * from "./tx.js";
export * from "./approval.js";

// LP-0021 wallet provider SDK
export * from "./sdk.js";