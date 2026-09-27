// Dual-licensed: MIT OR Apache-2.0
/**
 * Backend abstraction for on-chain operations.
 *
 * - MockBackend: local simulated sequencer (RISC0_DEV_MODE style, no real
 *   proofs). Used by unit/e2e tests and `wallet connect-test`.
 * - CliBackend: drives the official LEZ `wallet` CLI (which does the heavy
 *   lifting: key registration, ZK proof generation, submission to the
 *   sequencer). See https://github.com/logos-blockchain/logos-execution-zone
 *
 * The rest of the core (accounts, assets, tx, sdk, approval) is backend-
 * agnostic and always runs through this interface.
 */
import type { AccountState, AccountType, Balance, NetworkConfig, TxRecord } from "./types.js";

export interface CreateAccountResult {
  /** 32-byte base58 on-chain account id. */
  address: string;
  /** Null path key (private accounts). */
  npk?: string;
  /** Viewing key (private accounts). */
  vpk?: string;
  /** Signing key material we must keep encrypted (public accounts). */
  secretKey?: string;
}

export interface SendRequest {
  fromAccountId: string; // our local id
  fromType: AccountType;
  fromAddress: string;
  toAddress: string;
  toType: AccountType;
  /** "" = native asset, else token definition account id. */
  assetId: string;
  amount: string; // base units
  /** For sending to a FOREIGN private account: its npk/vpk. */
  toNpk?: string;
  toVpk?: string;
  /** Identifier for the recipient's private account (foreign private sends). */
  toIdentifier?: number;
  /** Contract call (testimonial etc.): programId + instruction + args. */
  programId?: string;
  instruction?: string;
  args?: unknown[];
}

export interface SendResult {
  txHash: string;
}

export interface GasEstimate {
  gas: string; // base units; null when the sequencer has no estimate
}

export interface Backend {
  readonly kind: "mock" | "cli";
  readonly network: NetworkConfig;

  /** Health check: can we reach the sequencer? */
  ping(): Promise<{ ok: boolean; info?: string }>;

  /**
   * Register a new account on chain (mock: derive + store; cli: wallet account new).
   * `material` lets the caller pin locally-derived key material (mock/tests);
   * backends that manage their own keys (cli) ignore it.
   */
  createAccount(
    type: AccountType,
    label: string,
    material?: { secretKey?: string; npk?: string; vpk?: string },
  ): Promise<CreateAccountResult>;

  /** Import an account from secret key material (public signing key, or keychain). */
  importAccount(
    type: AccountType,
    material: { secretKey?: string; keyChainJson?: string; accountState?: string },
  ): Promise<CreateAccountResult>;

  /** Balances for one asset ("" = native). Private reads need the viewing key. */
  getBalance(
    accountId: string,
    accountType: AccountType,
    assetId: string,
    viewingKey?: string,
  ): Promise<Balance>;

  /** All balances (native + fungible tokens). Private reads need the viewing key. */
  getAllBalances(
    accountId: string,
    accountType: AccountType,
    viewingKey?: string,
  ): Promise<Balance[]>;

  /**
   * Native/token transfer. `vouchers` = viewing keys proving we can read the
   * from-account when it is private.
   */
  send(req: SendRequest, vouchers: string[]): Promise<SendResult>;

  /** Build + sign + submit a contract call (e.g. testimonial publish). */
  executeProgram(
    req: SendRequest,
    vouchers: string[],
  ): Promise<SendResult>;

  /**
   * Gas estimate. MUST return null gracefully when the sequencer has no
   * estimate endpoint (LP-0021 rule).
   */
  estimateGas(req: SendRequest): Promise<GasEstimate | null>;

  /** Poll a submitted transaction to a terminal status. */
  pollTx(txHash: string): Promise<Pick<TxRecord, "hash" | "status" | "gasUsed" | "error">>;

  /** Account state for a program (public: raw; private: needs viewing key). */
  getState(
    accountId: string,
    accountType: AccountType,
    programId: string,
    viewingKey?: string,
  ): Promise<AccountState>;

  /** Current block id (used for sync). */
  currentBlockId(): Promise<number>;
}
