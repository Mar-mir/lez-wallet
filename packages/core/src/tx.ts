// Dual-licensed: MIT OR Apache-2.0
/**
 * TxService — transfers, contract calls, gas estimates and local history.
 *
 * LP-0021 rule: estimateGas() MAY return null (the sequencer has no estimate
 * endpoint); callers must render the flow fine without a gas number.
 */
import { isPositiveAmount } from "./assets.js";
import type { AccountService } from "./accounts.js";
import type { Backend, GasEstimate, SendRequest, SendResult } from "./backend.js";
import { invalidInput, notFound } from "./errors.js";
import type { StateManager } from "./store.js";
import {
  NATIVE_ASSET_DECIMALS,
  NATIVE_ASSET_ID,
  NATIVE_ASSET_SYMBOL,
  TxRecord,
  explorerTxUrl,
} from "./types.js";

export interface TransferParams {
  /** Local account id (our registry id). */
  fromAccountId: string;
  /** Receiver: owned account address, or FOREIGN private via npk/vpk. */
  to: {
    address: string;
    type: "public" | "private";
    /** Foreign private receiver keys (mutually exclusive with address use). */
    npk?: string;
    vpk?: string;
    identifier?: number;
  };
  /** "" = native asset, else token definition account id. */
  assetId?: string;
  /** Amount in base units. */
  amount: string;
}

export interface ContractCallParams {
  fromAccountId: string;
  programId: string;
  instruction: string;
  args?: unknown[];
}

const HISTORY_LIMIT = 500;

export class TxService {
  constructor(
    private readonly backend: Backend,
    private readonly state: StateManager,
    private readonly accounts: AccountService,
  ) {}

  /** Gas estimate; null when the sequencer provides none (LP-0021). */
  async estimateGas(params: TransferParams): Promise<GasEstimate | null> {
    return this.backend.estimateGas(await this.buildSend(params));
  }

  /** Submit a native/token transfer and record it as pending. */
  async transfer(params: TransferParams): Promise<TxRecord> {
    const req = await this.buildSend(params);
    const vouchers = await this.vouchersFor(params.fromAccountId);
    const { txHash } = await this.backend.send(req, vouchers);
    return this.recordTx(txHash, req, "out");
  }

  /** Build + sign + submit a contract call (e.g. testimonial publish). */
  async callProgram(params: ContractCallParams): Promise<TxRecord> {
    const from = await this.accounts.getAccount(params.fromAccountId);
    const req: SendRequest = {
      fromAccountId: from.id,
      fromType: from.type,
      fromAddress: from.address,
      toAddress: "",
      toType: "public",
      assetId: "",
      amount: "0",
      programId: params.programId,
      instruction: params.instruction,
      args: params.args ?? [],
    };
    const vouchers = await this.vouchersFor(from.id);
    const res: SendResult = await this.backend.executeProgram(req, vouchers);
    return this.recordTx(res.txHash, req, "out");
  }

  /**
   * Poll a submitted tx to a terminal status and update history.
   * `polls` bounds the polling (tests use 1).
   */
  async awaitConfirmation(
    txHash: string,
    opts: { polls?: number; intervalMs?: number } = {},
  ): Promise<TxRecord> {
    const polls = opts.polls ?? 30;
    const intervalMs = opts.intervalMs ?? 0;
    let last = await this.backend.pollTx(txHash);
    for (let i = 1; i < polls && last.status === "pending"; i++) {
      if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
      last = await this.backend.pollTx(txHash);
    }
    await this.state.update((s) => {
      const rec = s.txHistory.find((t) => t.hash === txHash);
      if (rec) {
        rec.status = last.status;
        if (last.gasUsed) rec.gasUsed = last.gasUsed;
        if (last.error) rec.error = last.error;
      }
    });
    return this.getTx(txHash);
  }

  async getTx(hash: string): Promise<TxRecord> {
    const s = await this.state.read();
    const rec = s.txHistory.find((t) => t.hash === hash);
    if (!rec) throw notFound(`tx ${hash}`);
    return rec;
  }

  /** Local history, newest first; optional asset/direction filter. */
  async history(filter: { assetId?: string; direction?: "in" | "out" } = {}): Promise<TxRecord[]> {
    const s = await this.state.read();
    return s.txHistory
      .filter((t) => (filter.assetId !== undefined ? t.assetId === filter.assetId : true))
      .filter((t) => (filter.direction ? t.direction === filter.direction : true))
      .slice()
      .reverse();
  }

  /**
   * Record an incoming transfer discovered during sync (external or own
   * account paying one of ours). `toAccountId` is our local account id.
   */
  async recordIncoming(params: {
    hash: string;
    fromAddress: string;
    toAccountId: string;
    amount: string;
    assetId?: string;
  }): Promise<TxRecord> {
    const to = await this.accounts.getAccount(params.toAccountId);
    const assetId = params.assetId ?? NATIVE_ASSET_ID;
    const isNative = assetId === NATIVE_ASSET_ID;
    const s = await this.state.read();
    const rec: TxRecord = {
      hash: params.hash,
      direction: "in",
      from: params.fromAddress,
      to: to.address,
      assetId,
      assetSymbol: isNative ? NATIVE_ASSET_SYMBOL : assetId.slice(0, 4).toUpperCase(),
      amount: params.amount,
      decimals: isNative ? NATIVE_ASSET_DECIMALS : 9,
      status: "confirmed",
      timestamp: Date.now(),
      explorerUrl: explorerTxUrl(s.settings.network, params.hash),
    };
    await this.state.update((st) => {
      st.txHistory.push(rec);
      if (st.txHistory.length > HISTORY_LIMIT) {
        st.txHistory.splice(0, st.txHistory.length - HISTORY_LIMIT);
      }
    });
    await this.accounts.touch(to.id);
    return rec;
  }

  private async buildSend(params: TransferParams): Promise<SendRequest> {
    if (!isPositiveAmount(params.amount)) throw invalidInput("amount must be positive");
    const from = await this.accounts.getAccount(params.fromAccountId);
    const assetId = params.assetId ?? NATIVE_ASSET_ID;
    return {
      fromAccountId: from.id,
      fromType: from.type,
      fromAddress: from.address,
      toAddress: params.to.address,
      toType: params.to.type,
      assetId,
      amount: params.amount,
      ...(params.to.npk ? { toNpk: params.to.npk } : {}),
      ...(params.to.vpk ? { toVpk: params.to.vpk } : {}),
      ...(params.to.identifier !== undefined ? { toIdentifier: params.to.identifier } : {}),
    };
  }

  /** Viewing keys for the sender when it is private ("vouchers"). */
  private async vouchersFor(accountId: string): Promise<string[]> {
    const rec = await this.accounts.getAccount(accountId);
    if (rec.type !== "private" || !rec.hasViewingKey) return [];
    const vpk = await this.accounts.getViewingKey(accountId);
    return vpk ? [vpk] : [];
  }

  private async recordTx(hash: string, req: SendRequest, direction: "in" | "out"): Promise<TxRecord> {
    const s = await this.state.read();
    const settings = s.settings.network;
    const isNative = req.assetId === NATIVE_ASSET_ID;
    const rec: TxRecord = {
      hash,
      direction,
      from: req.fromAddress,
      to: req.toNpk ? `npk:${req.toNpk.slice(0, 16)}…` : req.toAddress,
      assetId: req.assetId,
      assetSymbol: isNative ? NATIVE_ASSET_SYMBOL : req.assetId.slice(0, 4).toUpperCase(),
      amount: req.amount,
      decimals: isNative ? NATIVE_ASSET_DECIMALS : 9,
      status: "pending",
      timestamp: Date.now(),
      ...(req.programId ? { programId: req.programId } : {}),
      ...(req.instruction ? { instruction: req.instruction } : {}),
      explorerUrl: explorerTxUrl(settings, hash),
    };
    await this.state.update((st) => {
      st.txHistory.push(rec);
      if (st.txHistory.length > HISTORY_LIMIT) {
        st.txHistory.splice(0, st.txHistory.length - HISTORY_LIMIT);
      }
    });
    await this.accounts.touch(req.fromAccountId);
    return rec;
  }
}