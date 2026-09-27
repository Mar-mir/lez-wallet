// Dual-licensed: MIT OR Apache-2.0
/**
 * Persistent wallet state with ATOMIC writes: every save is written to a temp
 * file and renamed over the target, so a crash mid-write can never corrupt
 * state. A small in-memory read-through cache keeps concurrent callers safe.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ioError } from "./errors.js";

export interface WalletState {
  version: 1;
  /** Set once a password has been chosen (first-install flow gate). */
  passwordSet: boolean;
  /** Set after the user confirms they saved the mnemonic. */
  mnemonicConfirmed: boolean;
  /** Account registry. Key material itself lives only in the vault. */
  accounts: Record<string, import("./types.js").AccountRecord>;
  activeAccountId: string | null;
  /** Local transaction history (mirrors on-chain, for offline UX). */
  txHistory: import("./types.js").TxRecord[];
  /**
   * Per-dApp approvals granted via connect(), keyed by origin. A dApp may only
   * read a private balance / propose for an account it was explicitly given.
   */
  approvals: Record<string, { accountId: string; grantedAt: string; permissions: string[] }>;
  settings: {
    network: import("./types.js").NetworkConfig;
    /** Auto-lock after N minutes of inactivity (default 10). */
    autoLockMinutes: number;
    /** Optional price API — disabled by default (privacy rule). */
    priceApiEnabled: boolean;
    priceApiUrl: string;
  };
}

export function emptyState(): WalletState {
  return {
    version: 1,
    passwordSet: false,
    mnemonicConfirmed: false,
    accounts: {},
    activeAccountId: null,
    txHistory: [],
    approvals: {},
    settings: {
      network: {
        sequencerUrl: "https://testnet.lez.logos.co",
        explorerUrl: "https://explorer.testnet.lez.logos.co",
        networkName: "testnet-0.3",
      },
      autoLockMinutes: 10,
      priceApiEnabled: false,
      priceApiUrl: "",
    },
  };
}

/**
 * In-memory storage backend (used by the extension via chrome.storage
 * adapters and by tests).
 */
export class MemoryVaultStorage {
  private data: Record<string, string> | null = null;
  async read(): Promise<Record<string, string> | null> {
    return this.data;
  }
  async write(recs: Record<string, string>): Promise<void> {
    this.data = recs;
  }
}

export class MemoryStateStorage {
  private data: WalletState | null = null;
  async read(): Promise<WalletState | null> {
    return this.data;
  }
  async writeAtomic(state: WalletState): Promise<void> {
    this.data = JSON.parse(JSON.stringify(state)) as WalletState;
  }
}

/**
 * File-based state store. Atomic writes via tmp+rename.
 */
export class FileStateStore {
  private cache: WalletState | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<WalletState | null> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as WalletState;
      if (parsed.version !== 1) throw new Error(`unsupported state version: ${parsed.version}`);
      this.cache = parsed;
      return parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw ioError(`failed to read wallet state: ${(e as Error).message}`, e);
    }
  }

  /** Atomic write: serialize -> tmp file -> fsync -> rename over target. */
  async writeAtomic(state: WalletState): Promise<void> {
    this.cache = state;
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, this.filePath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      throw ioError(`failed to persist wallet state: ${(e as Error).message}`, e);
    }
  }
}

export interface StateStorage {
  read(): Promise<WalletState | null>;
  writeAtomic(state: WalletState): Promise<void>;
}

/**
 * Serialized read-modify-write over a StateStorage. Concurrent update() calls
 * are queued so two services can never interleave a read-modify-write and drop
 * each other's changes (important for the extension's multiple ports).
 */
export class StateManager {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: StateStorage) {}

  async read(): Promise<WalletState> {
    return (await this.storage.read()) ?? emptyState();
  }

  /** Atomically mutate + persist state. `fn` may mutate the state in place. */
  async update<T>(fn: (state: WalletState) => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const state = (await this.storage.read()) ?? emptyState();
      const result = await fn(state);
      await this.storage.writeAtomic(state);
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}