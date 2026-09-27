// Dual-licensed: MIT OR Apache-2.0
/**
 * AccountService — the account registry: create/import/label/remove accounts.
 *
 * Privacy invariant: key material (secretKey/npk/vpk) lives ONLY in the
 * PasswordVault, never in WalletState. AccountRecord carries just enough to
 * render UI (address, label, hasViewingKey). Key material is reached through
 * getViewingKey()/exportKeys() — the SDK only calls those on the
 * approval-gated path (see ApprovalService).
 */
import type { Backend, CreateAccountResult } from "./backend.js";
import { randomHex } from "./crypto.js";
import { invalidInput, notFound } from "./errors.js";
import { deriveAccountKeys } from "./keys.js";
import type { StateManager } from "./store.js";
import type { AccountRecord, AccountSummary, AccountType } from "./types.js";
import type { PasswordVault } from "./vault.js";

export interface AccountKeyMaterial {
  secretKey?: string;
  npk?: string;
  vpk?: string;
}

export interface CreateAccountOptions {
  label: string;
  /**
   * BIP-39 seed hex. When given, key material is derived deterministically
   * (per type + index) and pinned into the backend; otherwise the backend
   * generates its own keys.
   */
  seedHex?: string;
  notes?: string;
}

export interface ImportedAccountMaterial {
  secretKey?: string;
  keyChainJson?: string;
  accountState?: string;
}

const secretName = (id: string) => `account:${id}`;

export class AccountService {
  constructor(
    private readonly backend: Backend,
    private readonly state: StateManager,
    private readonly vault: PasswordVault,
  ) {}

  /** Register a new account on chain and record it locally. */
  async createAccount(type: AccountType, opts: CreateAccountOptions): Promise<AccountRecord> {
    const label = opts.label.trim();
    if (!label) throw invalidInput("account label is required");
    const material = opts.seedHex ? this.deriveMaterial(opts.seedHex, type) : undefined;
    const result = await this.backend.createAccount(type, label, material);
    return this.record(type, label, result, material, opts.notes);
  }

  /** Import an existing account from external key material. */
  async importAccount(
    type: AccountType,
    material: ImportedAccountMaterial,
    label = "Imported",
  ): Promise<AccountRecord> {
    const result = await this.backend.importAccount(type, material);
    const keys: AccountKeyMaterial = {};
    if (material.secretKey) keys.secretKey = material.secretKey;
    return this.record(type, label, result, keys, undefined);
  }

  private async record(
    type: AccountType,
    label: string,
    result: CreateAccountResult,
    fallback: AccountKeyMaterial | undefined,
    notes: string | undefined,
  ): Promise<AccountRecord> {
    const id = `acc_${randomHex(12)}`;
    const keys: AccountKeyMaterial = {
      secretKey: result.secretKey ?? fallback?.secretKey,
      npk: result.npk ?? fallback?.npk,
      vpk: result.vpk ?? fallback?.vpk,
    };
    await this.vault.put(secretName(id), keys);
    const rec: AccountRecord = {
      id,
      type,
      label,
      address: result.address,
      hasViewingKey: Boolean(keys.vpk),
      ...(keys.npk ? { npk: keys.npk } : {}),
      createdAt: new Date().toISOString(),
      ...(notes ? { notes } : {}),
    };
    await this.state.update((s) => {
      s.accounts[id] = rec;
      if (!s.activeAccountId) s.activeAccountId = id;
    });
    return rec;
  }

  private deriveMaterial(seedHex: string, type: AccountType): AccountKeyMaterial {
    // Index reserved for future multi-account derivation paths.
    const derived = deriveAccountKeys(seedHex, type, 0);
    return { secretKey: derived.secretKey, npk: derived.npk, vpk: derived.vpk };
  }

  /** All accounts, as safe summaries (never any key material). */
  async listAccounts(): Promise<AccountSummary[]> {
    const s = await this.state.read();
    return Object.values(s.accounts).map((r) => toSummary(r));
  }

  async getAccount(id: string): Promise<AccountRecord> {
    const s = await this.state.read();
    const rec = s.accounts[id];
    if (!rec) throw notFound(`account ${id}`);
    return rec;
  }

  async setLabel(id: string, label: string): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed) throw invalidInput("label must not be empty");
    await this.state.update((s) => {
      const rec = s.accounts[id];
      if (!rec) throw notFound(`account ${id}`);
      rec.label = trimmed;
    });
    await this.touch(id);
  }

  async setNotes(id: string, notes: string): Promise<void> {
    await this.state.update((s) => {
      const rec = s.accounts[id];
      if (!rec) throw notFound(`account ${id}`);
      rec.notes = notes;
    });
  }

  async setActive(id: string): Promise<void> {
    await this.state.update((s) => {
      if (!s.accounts[id]) throw notFound(`account ${id}`);
      s.activeAccountId = id;
    });
    await this.touch(id);
  }

  async getActive(): Promise<AccountRecord | null> {
    const s = await this.state.read();
    return s.activeAccountId ? (s.accounts[s.activeAccountId] ?? null) : null;
  }

  /**
   * Remove an account from the registry AND destroy its key material.
   * (On-chain funds are unaffected — this is purely local.)
   */
  async removeAccount(id: string): Promise<void> {
    await this.state.update((s) => {
      if (!s.accounts[id]) throw notFound(`account ${id}`);
      delete s.accounts[id];
      if (s.activeAccountId === id) {
        s.activeAccountId = Object.keys(s.accounts)[0] ?? null;
      }
    });
    await this.vault.delete(secretName(id));
  }

  /** View key for a private account (approval-gated callers only). */
  async getViewingKey(id: string): Promise<string | undefined> {
    const keys = await this.vault.get<AccountKeyMaterial>(secretName(id));
    return keys.vpk;
  }

  /** Full key material export (approval-gated callers only). */
  async exportKeys(id: string): Promise<AccountKeyMaterial> {
    await this.getAccount(id); // 404 before vault lookup
    return this.vault.get<AccountKeyMaterial>(secretName(id));
  }

  /** Mark an account as recently used. */
  async touch(id: string): Promise<void> {
    await this.state.update((s) => {
      const rec = s.accounts[id];
      if (rec) rec.lastUsedAt = new Date().toISOString();
    });
  }
}

/** Minimal safe projection — never includes keys. */
export function toSummary(rec: AccountRecord): AccountSummary {
  return { id: rec.id, type: rec.type, label: rec.label, address: rec.address };
}