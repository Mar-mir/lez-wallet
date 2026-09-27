// Dual-licensed: MIT OR Apache-2.0
/**
 * MockBackend — a local, in-memory simulated LEZ sequencer.
 *
 * Used by unit/e2e tests and `wallet connect-test` (RISC0_DEV_MODE style: no
 * real proofs, no network). It models what the wallet needs:
 * - public + private accounts (private state only readable with a viewing key)
 * - native + fungible token balances, all privacy combinations of sends
 * - program (contract) state, e.g. the testimonial program
 * - tx lifecycle: submit -> pending -> confirmed (with gas used)
 *
 * Chain state can be persisted to a JSON file so e2e scenarios span runs.
 */
import { base58Encode } from "./base58.js";
import { randomHex, sha256Hex } from "./crypto.js";
import { WalletError, insufficientBalance, rpcUnavailable, notFound } from "./errors.js";
import {
  AccountState,
  AccountType,
  Balance,
  DEFAULT_NETWORK,
  NetworkConfig,
  TxRecord,
  NATIVE_ASSET_ID,
  NATIVE_ASSET_SYMBOL,
  NATIVE_ASSET_DECIMALS,
} from "./types.js";
import type { Backend, CreateAccountResult, GasEstimate, SendRequest } from "./backend.js";

export interface MockToken {
  assetId: string; // token definition account id
  name: string;
  symbol: string;
  decimals: number;
}

export interface MockAccountState {
  address: string;
  type: AccountType;
  label: string;
  /** assetId -> amount in base units (string). */
  balances: Record<string, string>;
  /** pdaHex -> program account data (for contract state reads). */
  programs: Record<string, { programId: string; data: Record<string, unknown> }>;
  /** Viewing keys that may read this (private) account. */
  viewingKeys: string[];
  npk?: string;
}

export interface MockChainState {
  blockId: number;
  accounts: Record<string, MockAccountState>;
  tokens: Record<string, MockToken>;
  txs: Record<
    string,
    { status: "pending" | "confirmed" | "failed"; gasUsed: string; polls: number; error?: string }
  >;
}

export function emptyMockChain(): MockChainState {
  return { blockId: 1, accounts: {}, tokens: {}, txs: {} };
}

const GAS_BASE = 50_000n;
const CONFIRM_POLLS = 2; // tx confirms after this many poll calls

export interface MockBackendOptions {
  network?: NetworkConfig;
  state?: MockChainState;
  /** If set, persist chain state to this JSON file after each mutation. */
  persistTo?: string;
  /** Set true to make network calls fail (rpc_unavailable tests). */
  offline?: boolean;
}

export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  readonly network: NetworkConfig;
  state: MockChainState;
  private readonly persistTo?: string;
  private offline = false;

  constructor(opts: MockBackendOptions = {}) {
    this.network = opts.network ?? DEFAULT_NETWORK;
    this.state = opts.state ?? emptyMockChain();
    this.persistTo = opts.persistTo;
    this.offline = opts.offline ?? false;
  }

  /** Toggle simulated network failure (rpc_unavailable tests). */
  setOffline(offline: boolean): void {
    this.offline = offline;
  }

  async ping(): Promise<{ ok: boolean; info?: string }> {
    if (this.offline) return { ok: false, info: "offline (injected)" };
    return { ok: true, info: `mock sequencer @ block ${this.state.blockId}` };
  }

  private async persist(): Promise<void> {
    if (!this.persistTo) return;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(this.persistTo), { recursive: true });
    const tmp = `${this.persistTo}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tmp, this.persistTo);
  }

  private requireOnline(): void {
    if (this.offline) throw rpcUnavailable("mock sequencer is offline");
  }

  /**
   * Register a new account on the mock chain.
   * Address = base58(sha256("lez-mock-account|" + keyMaterial)).
   */
  async createAccount(
    type: AccountType,
    label: string,
    material?: { secretKey?: string; npk?: string; vpk?: string },
  ): Promise<CreateAccountResult> {
    this.requireOnline();
    const seed = material?.secretKey ?? material?.vpk ?? randomHex(32);
    const digest = await sha256Hex(`lez-mock-account|${seed}`);
    const address = digestToAddress(digest);
    const existing = this.state.accounts[address];
    if (existing) {
      if (material?.npk) existing.npk = material.npk;
      if (material?.vpk && !existing.viewingKeys.includes(material.vpk)) {
        existing.viewingKeys.push(material.vpk);
      }
      if (label && !existing.label) existing.label = label;
      return { address, npk: material?.npk, vpk: material?.vpk, secretKey: material?.secretKey };
    }
    this.state.accounts[address] = {
      address,
      type,
      label,
      balances: {},
      programs: {},
      viewingKeys: type === "private" && material?.vpk ? [material.vpk] : [],
      ...(type === "private" && material?.npk ? { npk: material.npk } : {}),
    };
    await this.persist();
    return { address, npk: material?.npk, vpk: material?.vpk, secretKey: material?.secretKey };
  }

  async importAccount(
    type: AccountType,
    material: { secretKey?: string; keyChainJson?: string; accountState?: string },
  ): Promise<CreateAccountResult> {
    return this.createAccount(type, "imported", {
      secretKey: material.secretKey ?? material.keyChainJson ?? material.accountState,
    });
  }

  /** Test helper: mint an amount to an address (faucet). */
  async faucet(
    address: string,
    assetId: string,
    amount: string,
    decimals = NATIVE_ASSET_DECIMALS,
  ): Promise<void> {
    this.requireOnline();
    const acct = this.accountOrThrow(address);
    if (assetId !== NATIVE_ASSET_ID && !this.state.tokens[assetId]) {
      this.state.tokens[assetId] = {
        assetId,
        name: `Token ${assetId.slice(0, 6)}`,
        symbol: assetId.slice(0, 4).toUpperCase(),
        decimals,
      };
    }
    const cur = BigInt(acct.balances[assetId] ?? "0");
    acct.balances[assetId] = (cur + BigInt(amount)).toString();
    await this.persist();
  }

  /** Test helper: register a token definition. */
  registerToken(assetId: string, name: string, symbol: string, decimals: number): MockToken {
    const tok = { assetId, name, symbol, decimals };
    this.state.tokens[assetId] = tok;
    return tok;
  }

  private accountOrThrow(address: string): MockAccountState {
    const acct = this.state.accounts[address];
    if (!acct) throw notFound(`account ${address}`);
    return acct;
  }

  private tokenMeta(assetId: string): MockToken {
    if (assetId === NATIVE_ASSET_ID) {
      return {
        assetId,
        name: "Logos (native)",
        symbol: NATIVE_ASSET_SYMBOL,
        decimals: NATIVE_ASSET_DECIMALS,
      };
    }
    const tok = this.state.tokens[assetId];
    if (!tok) throw notFound(`token ${assetId}`);
    return tok;
  }

  private balanceOf(address: string, assetId: string, readingVpk?: string): Balance {
    const acct = this.accountOrThrow(address);
    if (acct.type === "private") {
      if (readingVpk === undefined || !acct.viewingKeys.includes(readingVpk)) {
        throw new WalletError(
          `private balance for ${address} requires the account's viewing key`,
          "unauthorized",
        );
      }
    }
    const meta = this.tokenMeta(assetId);
    return {
      assetId,
      assetSymbol: meta.symbol,
      assetName: meta.name,
      amount: acct.balances[assetId] ?? "0",
      decimals: meta.decimals,
    };
  }

  async getBalance(
    accountId: string,
    _accountType: AccountType,
    assetId: string,
    viewingKey?: string,
  ): Promise<Balance> {
    this.requireOnline();
    return this.balanceOf(accountId, assetId, viewingKey);
  }

  async getAllBalances(
    accountId: string,
    _accountType: AccountType,
    viewingKey?: string,
  ): Promise<Balance[]> {
    this.requireOnline();
    const acct = this.accountOrThrow(accountId);
    const ids = [NATIVE_ASSET_ID, ...Object.keys(this.state.tokens)];
    return ids.map((id) => this.balanceOf(accountId, id, viewingKey));
  }

  /**
   * Native/token transfer between any combination of public/private accounts.
   * Private sender: we must hold one of its viewing keys (ZK abstracts the
   * rest). Private receiver: addressed by account id (+ npk for foreign).
   */
  async send(req: SendRequest, vouchers: string[]): Promise<{ txHash: string }> {
    this.requireOnline();
    return this.transferInternal(req, vouchers);
  }

  /** Build + sign + submit a contract call (e.g. testimonial publish). */
  async executeProgram(req: SendRequest, vouchers: string[]): Promise<{ txHash: string }> {
    this.requireOnline();
    if (!req.programId || !req.instruction) {
      throw new WalletError("executeProgram requires programId + instruction", "invalid_input");
    }
    return this.programInternal(req, vouchers);
  }

  private async transferInternal(req: SendRequest, vouchers: string[]): Promise<{ txHash: string }> {
    const from = this.accountOrThrow(req.fromAddress);
    const to = this.accountOrThrow(req.toAddress);
    if (from.type === "private" && !vouchers.some((v) => from.viewingKeys.includes(v))) {
      throw new WalletError("missing viewing key for private sender", "unauthorized");
    }
    const amount = BigInt(req.amount);
    if (amount <= 0n) throw new WalletError("amount must be positive", "invalid_input");
    const cur = BigInt(from.balances[req.assetId] ?? "0");
    if (cur < amount) {
      throw insufficientBalance(
        `balance ${cur.toString()} < amount ${req.amount} for asset ${req.assetId || "native"}`,
      );
    }
    from.balances[req.assetId] = (cur - amount).toString();
    to.balances[req.assetId] = (BigInt(to.balances[req.assetId] ?? "0") + amount).toString();
    this.state.blockId++;
    const txHash = await this.recordTx();
    await this.persist();
    return { txHash };
  }

  private async programInternal(req: SendRequest, _vouchers: string[]): Promise<{ txHash: string }> {
    const from = this.accountOrThrow(req.fromAddress);
    const programId = req.programId!;
    if (req.instruction === "publishTestimonial") {
      const [text, username, submissionId, nonce] = (req.args ?? []) as [
        string,
        string | null,
        string,
        number,
      ];
      if (typeof text !== "string" || text.length === 0) {
        throw new WalletError("testimonial text is required", "invalid_input");
      }
      if (!submissionId) throw new WalletError("submissionId is required", "invalid_input");
      const pdaHex = await testimonialPdaHex(programId, req.fromAddress, submissionId, nonce ?? 0);
      from.programs[pdaHex] = {
        programId,
        data: {
          text,
          username: username ?? null,
          author: req.fromAddress,
          submissionId,
          timestamp: Math.floor(Date.now() / 1000),
        },
      };
      this.state.blockId++;
      const txHash = await this.recordTx();
      await this.persist();
      return { txHash };
    }
    throw new WalletError(
      `mock backend: unknown instruction "${req.instruction}"`,
      "invalid_input",
    );
  }

  private async recordTx(): Promise<string> {
    const hash = randomHex(32);
    this.state.txs[hash] = { status: "pending", gasUsed: "", polls: 0 };
    return hash;
  }

  async estimateGas(_req: SendRequest): Promise<GasEstimate | null> {
    // The mock sequencer always has an estimate; real sequencers may not.
    return { gas: GAS_BASE.toString() };
  }

  async pollTx(
    txHash: string,
  ): Promise<Pick<TxRecord, "hash" | "status" | "gasUsed" | "error">> {
    this.requireOnline();
    const tx = this.state.txs[txHash];
    if (!tx) throw notFound(`tx ${txHash}`);
    tx.polls++;
    if (tx.polls >= CONFIRM_POLLS) {
      tx.status = "confirmed";
      tx.gasUsed = (GAS_BASE / 2n).toString();
    }
    return { hash: txHash, status: tx.status, gasUsed: tx.gasUsed, error: tx.error };
  }

  async getState(
    accountId: string,
    _accountType: AccountType,
    programId: string,
    viewingKey?: string,
  ): Promise<AccountState> {
    this.requireOnline();
    const acct = this.accountOrThrow(accountId);
    if (acct.type === "private" && !viewingKey) {
      throw new WalletError(
        "reading private account state requires a viewing key",
        "unauthorized",
      );
    }
    const found = Object.values(acct.programs).find((p) => p.programId === programId);
    return { accountId, programId, data: found ? found.data : {} };
  }

  async currentBlockId(): Promise<number> {
    this.requireOnline();
    return this.state.blockId;
  }
}

/**
 * Testimonial PDA: sha256(programId | "testimonial" | author | submissionId | nonce).
 * MUST stay in sync with programs/testimonial guest code.
 */
export async function testimonialPdaHex(
  programId: string,
  author: string,
  submissionId: string,
  nonce: number,
): Promise<string> {
  const { sha256 } = await import("./crypto.js");
  const digest = await sha256(
    new TextEncoder().encode(`${programId}|testimonial|${author}|${submissionId}|${nonce}`),
  );
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Deterministic 32-byte base58 account address from a hex digest. */
function digestToAddress(hexDigest: string): string {
  const bytes = new Uint8Array(hexDigest.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexDigest.slice(i * 2, i * 2 + 2), 16);
  }
  return base58Encode(bytes);
}