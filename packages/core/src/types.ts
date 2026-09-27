// Dual-licensed: MIT OR Apache-2.0
/**
 * Shared types for the LEZ wallet core.
 *
 * Account model (LEZ / Logos Execution Zone):
 * - Public accounts: visible on-chain, addressed by a 32-byte account id.
 * - Private accounts: hidden behind a commitment; only holders of the viewing
 *   key (vpk) can read their state. Reference:
 *   https://github.com/logos-blockchain/logos-execution-zone
 */

export type AccountType = "public" | "private";

/** Opaque local id for an account, e.g. "acc_01H...". */
export type AccountId = string;

export interface AccountRecord {
  /** Stable local id (not the on-chain address). */
  id: AccountId;
  type: AccountType;
  /** Human label, e.g. "Main". */
  label: string;
  /** 32-byte base58 on-chain account id. */
  address: string;
  /**
   * Viewing key present => we can derive this private account's state.
   * Only ever exposed through the approval-gated path (ApprovalService).
   */
  hasViewingKey: boolean;
  /** 32-byte hex null path key, needed to send to a FOREIGN private account. */
  npk?: string;
  /** When the account was first registered on chain (ISO string). */
  createdAt: string;
  /** Last time the account was used for an operation (ISO string). */
  lastUsedAt?: string;
  /** Optional per-account notes. */
  notes?: string;
}

/** Minimal public view of an account (never includes keys). */
export interface AccountSummary {
  id: AccountId;
  type: AccountType;
  label: string;
  address: string;
}

export interface Balance {
  /**
   * Asset id. The native asset is the empty string "" (LEZ native token).
   * Fungible tokens use their definition account id.
   */
  assetId: string;
  assetSymbol: string;
  assetName: string;
  /** Amount in the asset's base units (string to avoid float issues). */
  amount: string;
  decimals: number;
}

export type TxDirection = "in" | "out";

export type TxStatus = "pending" | "confirmed" | "failed";

export interface TxRecord {
  hash: string;
  direction: TxDirection;
  from: string;
  to: string;
  /** Asset id ("" = native). */
  assetId: string;
  assetSymbol: string;
  amount: string;
  decimals: number;
  status: TxStatus;
  /** Unix ms. */
  timestamp: number;
  /** Estimated gas in base units, if the sequencer provided one. */
  gasEstimate?: string;
  /** Actual gas used, known after confirmation. */
  gasUsed?: string;
  /** Program id for contract calls ("" for plain transfers). */
  programId?: string;
  /** Human-readable instruction name for contract calls. */
  instruction?: string;
  /** Explorer url, e.g. https://explorer.testnet.lez.logos.co/tx/<hash>. */
  explorerUrl?: string;
  /** Error message when status === "failed". */
  error?: string;
}

/** Account state for a (account, program) pair, as returned by getState. */
export interface AccountState {
  accountId: string;
  programId: string;
  /**
   * Decoded, human-friendly state fields. The shape depends on the program;
   * unknown programs return whatever key/value pairs could be decoded.
   */
  data: Record<string, unknown>;
  /** Raw hex account data (only present for public accounts or approved reads). */
  raw?: string;
}

export interface NetworkConfig {
  /** Sequencer RPC base, e.g. https://testnet.lez.logos.co */
  sequencerUrl: string;
  /** Explorer base, e.g. https://explorer.testnet.lez.logos.co */
  explorerUrl: string;
  networkName: string;
}

export const DEFAULT_NETWORK: NetworkConfig = {
  sequencerUrl: "https://testnet.lez.logos.co",
  explorerUrl: "https://explorer.testnet.lez.logos.co",
  networkName: "testnet-0.3",
};

export const NATIVE_ASSET_ID = "";
export const NATIVE_ASSET_SYMBOL = "LOG";
export const NATIVE_ASSET_DECIMALS = 9;

export function nativeBalance(amount: string): Balance {
  return {
    assetId: NATIVE_ASSET_ID,
    assetSymbol: NATIVE_ASSET_SYMBOL,
    assetName: "Logos (native)",
    amount,
    decimals: NATIVE_ASSET_DECIMALS,
  };
}

export function explorerTxUrl(network: NetworkConfig, hash: string): string {
  return `${network.explorerUrl}/tx/${hash}`;
}
