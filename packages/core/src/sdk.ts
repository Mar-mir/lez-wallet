// Dual-licensed: MIT OR Apache-2.0
/**
 * WalletSDK — the LP-0021 WalletProvider surface, the single entry point the
 * CLI, extension and mini-apps build on. Wires accounts + tx + approval and
 * enforces the dApp capability model:
 *
 * - dApps see ONLY the accounts an origin was granted (connect()).
 * - Every privileged call re-checks (origin, account, capability).
 * - SDK-level errors use exactly the LP-0021 codes: rejected_by_user,
 *   unauthorized, account_locked, rpc_unavailable (plus wallet-internal codes
 *   like invalid_input / insufficient_balance for non-dApp callers).
 */
import { AccountService, type AccountKeyMaterial, type CreateAccountOptions } from "./accounts.js";
import type { Backend, GasEstimate } from "./backend.js";
import {
  ApprovalService,
  type ApprovalGrant,
  type ApprovalRequest,
  type ApprovalPrompt,
  type Capability,
} from "./approval.js";
import { unauthorized } from "./errors.js";
import type { StateManager } from "./store.js";
import { TxService, type ContractCallParams, type TransferParams } from "./tx.js";
import type { AccountRecord, AccountState, AccountSummary, Balance, TxRecord } from "./types.js";
import type { PasswordVault } from "./vault.js";

export interface WalletSDKOptions {
  backend: Backend;
  state: StateManager;
  vault: PasswordVault;
  prompt?: ApprovalPrompt;
}

export interface ConnectParams {
  origin: string;
  /** Account the dApp wants; defaults to the active account. */
  accountId?: string;
  capabilities?: Capability[];
  note?: string;
}

const DEFAULT_CAPABILITIES: Capability[] = ["read_balance", "read_state", "propose_tx"];

export class WalletSDK {
  readonly accounts: AccountService;
  readonly tx: TxService;
  readonly approvals: ApprovalService;
  readonly backend: Backend;

  constructor(opts: WalletSDKOptions) {
    this.backend = opts.backend;
    this.accounts = new AccountService(opts.backend, opts.state, opts.vault);
    this.tx = new TxService(opts.backend, opts.state, this.accounts);
    this.approvals = new ApprovalService(opts.state, opts.prompt);
  }

  // ── wallet lifecycle (UI flows, not dApp-exposed) ─────────────────────

  async createAccount(type: "public" | "private", opts: CreateAccountOptions): Promise<AccountRecord> {
    return this.accounts.createAccount(type, opts);
  }

  async ping(): Promise<{ ok: boolean; info?: string }> {
    return this.backend.ping();
  }

  // ── LP-0021 provider API (dApp-exposed, approval-gated) ───────────────

  /**
   * connect(): prompt the user and grant `capabilities` for one account.
   * Reuses the existing grant (no prompt) when it already covers the request.
   */
  async connect(params: ConnectParams): Promise<AccountSummary> {
    const target = params.accountId
      ? await this.accounts.getAccount(params.accountId)
      : await this.accounts.getActive();
    if (!target) throw unauthorized("no account available to connect");
    const capabilities = params.capabilities ?? DEFAULT_CAPABILITIES;
    await this.approvals.requireApproval({
      origin: params.origin,
      accountId: target.id,
      capabilities,
      ...(params.note ? { note: params.note } : {}),
    });
    await this.accounts.touch(target.id);
    return { id: target.id, type: target.type, label: target.label, address: target.address };
  }

  /** The account(s) an origin is currently granted (at most one). */
  async getAccounts(origin: string): Promise<AccountSummary[]> {
    const grant = await this.approvals.getGrant(origin);
    if (!grant) return [];
    const rec = await this.accounts.getAccount(grant.accountId);
    return [{ id: rec.id, type: rec.type, label: rec.label, address: rec.address }];
  }

  async getPermissions(origin: string): Promise<ApprovalGrant | null> {
    return this.approvals.getGrant(origin);
  }

  /** Disconnect: drop the origin's grant entirely. */
  async disconnect(origin: string): Promise<void> {
    await this.approvals.revoke(origin);
  }

  /** Balance for one asset. Private reads pull the viewing key from the vault. */
  async getBalance(origin: string, accountId: string, assetId: string): Promise<Balance> {
    await this.approvals.requireCapability(origin, accountId, "read_balance");
    const rec = await this.accounts.getAccount(accountId);
    const vpk = rec.hasViewingKey ? await this.accounts.getViewingKey(accountId) : undefined;
    return this.backend.getBalance(rec.address, rec.type, assetId, vpk);
  }

  /** All balances (native + tokens) for a granted account. */
  async getAllBalances(origin: string, accountId: string): Promise<Balance[]> {
    await this.approvals.requireCapability(origin, accountId, "read_balance");
    const rec = await this.accounts.getAccount(accountId);
    const vpk = rec.hasViewingKey ? await this.accounts.getViewingKey(accountId) : undefined;
    return this.backend.getAllBalances(rec.address, rec.type, vpk);
  }

  /** Program state read for a granted account. */
  async getState(origin: string, accountId: string, programId: string): Promise<AccountState> {
    await this.approvals.requireCapability(origin, accountId, "read_state");
    const rec = await this.accounts.getAccount(accountId);
    const vpk = rec.hasViewingKey ? await this.accounts.getViewingKey(accountId) : undefined;
    return this.backend.getState(rec.address, rec.type, programId, vpk);
  }

  /** Gas estimate for a transfer; null when unavailable (LP-0021 rule). */
  async estimateGas(origin: string, params: TransferParams): Promise<GasEstimate | null> {
    await this.approvals.requireCapability(origin, params.fromAccountId, "propose_tx");
    return this.tx.estimateGas(params);
  }

  /**
   * Propose + submit a transfer. Every submission is confirmed explicitly —
   * the prompt note carries the amount so the UI can show exactly what is
   * being signed. A per-tx rejection is `rejected_by_user`.
   */
  async send(origin: string, params: TransferParams, note?: string): Promise<TxRecord> {
    await this.approvals.requireApproval(
      {
        origin,
        accountId: params.fromAccountId,
        capabilities: ["propose_tx"],
        note: note ?? `send ${params.amount} (base units) to ${params.to.address.slice(0, 16)}…`,
      },
      { alwaysPrompt: true },
    );
    return this.tx.transfer(params);
  }

  /** Propose + submit a contract call (e.g. testimonial publish). */
  async executeProgram(
    origin: string,
    params: ContractCallParams,
    note?: string,
  ): Promise<TxRecord> {
    await this.approvals.requireApproval(
      {
        origin,
        accountId: params.fromAccountId,
        capabilities: ["propose_tx"],
        note: note ?? `${params.programId}#${params.instruction}`,
      },
      { alwaysPrompt: true },
    );
    return this.tx.callProgram(params);
  }

  /** Transaction history of the account granted to `origin`. */
  async getHistory(
    origin: string,
    filter?: { assetId?: string; direction?: "in" | "out" },
  ): Promise<TxRecord[]> {
    const grant = await this.approvals.getGrant(origin);
    if (!grant) throw unauthorized(`origin ${origin} is not connected`);
    await this.approvals.requireCapability(origin, grant.accountId, "read_state");
    return this.tx.history(filter);
  }

  /**
   * Export key material — the ONLY key-exposure path, gated by the explicit
   * `read_keys` capability (never part of DEFAULT_CAPABILITIES).
   */
  async revealKeys(
    origin: string,
    accountId: string,
    req?: Omit<ApprovalRequest, "origin" | "accountId" | "capabilities">,
  ): Promise<AccountKeyMaterial> {
    // LP-0021: the user confirms every key export explicitly.
    await this.approvals.requireApproval(
      {
        origin,
        accountId,
        capabilities: ["read_keys"],
        ...(req?.note ? { note: req.note } : {}),
      },
      { alwaysPrompt: true },
    );
    return this.accounts.exportKeys(accountId);
  }
}

/** Alias kept for spec naming (LP-0021 "WalletProvider"). */
export { WalletSDK as WalletProvider };